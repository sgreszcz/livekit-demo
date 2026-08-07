/**
 * The token endpoint is the only place this Worker hands out authority, so the
 * assertions here are about the *claims* rather than the response shape: a
 * refactor that quietly dropped `canPublish: false` would still return 200 and a
 * perfectly valid JWT, and the observer would be able to talk to the agent.
 *
 * The tokens are signed for real — jose runs under node just as it does on
 * Workers — and the payload is read straight out of the middle segment. Nothing
 * verifies the signature here; the signature is jose's problem, the grants are
 * this file's.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleActiveGet,
  resetActiveCache,
  type ActiveRoomsBody,
  type RoomSnapshot,
  type RoomsApi,
} from './active';
import type { Env } from './env';
import { roomId } from './rooms';
import { handleToken } from './token';

const env = {
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'devsecret-long-enough-to-sign-with',
  LIVEKIT_URL: 'wss://livekik-rbhzpdof.livekit.cloud',
} as unknown as Env;

interface VideoGrant {
  roomJoin?: boolean;
  room?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
}

interface Claims {
  sub: string;
  iss: string;
  exp: number;
  nbf: number;
  video: VideoGrant;
}

function post(body?: unknown): Request {
  return new Request('https://cockpit.example/api/token', {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

/** The JWT payload, decoded but deliberately not verified. */
function claims(token: string): Claims {
  const segment = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Claims;
}

async function mint(body?: unknown) {
  const response = await handleToken(post(body), env);
  const payload = (await response.json()) as { token: string; url: string; roomName: string };
  return { response, payload, claims: claims(payload.token) };
}

/*
 * The observer-by-handle path resolves against the live call list, and
 * `handleToken` takes no `RoomsApi` — the route table calls it with a Request
 * and an Env and nothing else, so inventing a seam here would test a signature
 * production does not have.
 *
 * Instead these tests prime the very memo /api/active fills, which is exactly
 * how it works in production: a browser polls, the isolate holds the snapshot
 * for four seconds, and the token request that follows reads it. It also means
 * an unprimed test would reach for real LiveKit credentials, so every test below
 * that posts a handle primes first, deliberately.
 */
function fakeApi(
  rooms: RoomSnapshot[] | Error,
  participants: Record<string, { identity: string }[]> = {},
): RoomsApi {
  return {
    async listRooms() {
      if (rooms instanceof Error) throw rooms;
      return rooms;
    },
    async listParticipants(name: string) {
      return participants[name] ?? [{ identity: 'visitor-abc' }];
    },
  };
}

/**
 * A room that started just now.
 *
 * Dated off the live clock rather than a fixed epoch on purpose: /api/active
 * drops rooms older than `MAX_ROOM_AGE_SECONDS`, so a hard-coded 2024 timestamp
 * would make every fixture here an orphan and every handle unresolvable — the
 * tests below would then pass or fail for a reason that has nothing to do with
 * the token endpoint.
 */
function room(name: string): RoomSnapshot {
  return { name, numParticipants: 2, creationTime: BigInt(Math.floor(Date.now() / 1000)) };
}

/** Poll /api/active over a fake LiveKit, and hand back what a browser would see. */
async function poll(
  rooms: RoomSnapshot[] | Error,
  participants: Record<string, { identity: string }[]> = {},
): Promise<ActiveRoomsBody> {
  const response = await handleActiveGet(env, fakeApi(rooms, participants));
  return (await response.json()) as ActiveRoomsBody;
}

// The memo is module state shared with active.ts, so one test's live call must
// not still be resolvable in the next.
beforeEach(() => {
  resetActiveCache();
});

/*
 * Ofcom's reserved drama range: shaped exactly like the caller numbers LiveKit
 * SIP dispatch puts in a room name, and belonging to nobody.
 */
const SIP_CALLER = 'sip-cockpit-_+447700900123_BXhCPPSrr57t';

describe('the caller path', () => {
  it('mints an unguessable room and a prefixed identity', async () => {
    const { response, payload, claims: granted } = await mint();

    expect(response.status).toBe(200);
    expect(payload.roomName).toMatch(/^cockpit-[A-Za-z0-9]{16}$/);
    expect(payload.url).toBe('wss://livekik-rbhzpdof.livekit.cloud');
    expect(granted.sub).toMatch(/^visitor-[A-Za-z0-9]{10}$/);
    expect(granted.video.room).toBe(payload.roomName);
  });

  it('grants a caller everything the cockpit needs', async () => {
    const { claims: granted } = await mint();

    expect(granted.video).toMatchObject({
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      // Without this the chaos toggles never reach the agent.
      canPublishData: true,
    });
  });

  it('honours a requested label but sanitises it into the identity', async () => {
    const { claims: granted } = await mint({ identity: 'Ada Lovelace!!' });
    expect(granted.sub).toMatch(/^visitor-AdaLovelace-[A-Za-z0-9]{10}$/);
  });

  it('never lets a label become the whole identity', async () => {
    const { claims: granted } = await mint({ identity: `agent-cockpit${'x'.repeat(200)}` });
    // Prefixed and truncated: 24 label characters at most, then the random tail.
    expect(granted.sub).toMatch(/^visitor-agent-cockpitxxxxxxxxxxx-[A-Za-z0-9]{10}$/);
    expect(granted.sub).toHaveLength('visitor-'.length + 24 + 1 + 10);
  });

  it('still works with no body at all', async () => {
    const { response, payload } = await mint();
    expect(response.status).toBe(200);
    expect(payload.roomName).toMatch(/^cockpit-/);
  });

  it('still works with a body that is not JSON', async () => {
    // The parse-once refactor must not turn a junk body into a 400: browsers
    // have been posting whatever they like at this endpoint since day one.
    const { response, claims: granted } = await mint('not json at all');
    expect(response.status).toBe(200);
    expect(granted.sub).toMatch(/^visitor-[A-Za-z0-9]{10}$/);
  });

  it('still works with a JSON body that is not an object', async () => {
    const { response, claims: granted } = await mint('[1,2,3]');
    expect(response.status).toBe(200);
    expect(granted.sub).toMatch(/^visitor-[A-Za-z0-9]{10}$/);
  });

  it('mints two different rooms for two callers', async () => {
    const [first, second] = await Promise.all([mint(), mint()]);
    expect(first.payload.roomName).not.toBe(second.payload.roomName);
  });

  it('refuses to mint anything on a deployment with no credentials', async () => {
    const bare = { LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '', LIVEKIT_URL: '' } as unknown as Env;
    const response = await handleToken(post(), bare);
    expect(response.status).toBe(500);
  });
});

describe('the observer path', () => {
  it('joins the requested room rather than a fresh one', async () => {
    await poll([room('cockpit-abc123')]);
    const { response, payload, claims: granted } = await mint({ observe: 'cockpit-abc123' });

    expect(response.status).toBe(200);
    expect(payload.roomName).toBe('cockpit-abc123');
    expect(granted.video.room).toBe('cockpit-abc123');
    expect(payload.url).toBe('wss://livekik-rbhzpdof.livekit.cloud');
  });

  it('identifies the holder as an observer', async () => {
    // /api/active discounts exactly this prefix when counting live callers, so
    // the shape of the identity is a contract, not decoration.
    await poll([room('cockpit-abc123')]);
    const { claims: granted } = await mint({ observe: 'cockpit-abc123' });
    expect(granted.sub).toMatch(/^observer-[A-Za-z0-9]{8}$/);
  });

  it('can listen, can arm chaos, and nothing else', async () => {
    await poll([room('cockpit-abc123')]);
    const { claims: granted } = await mint({ observe: 'cockpit-abc123' });

    /*
     * `toEqual`, not `toMatchObject`. A test titled "and nothing else" that
     * cannot fail on an *extra* grant is not testing its own title:
     * `roomAdmin`, `hidden`, `recorder` or a `canPublishSources` list — which
     * the server reads as permission to publish those sources regardless of
     * `canPublish: false` — would all slip past a subset match. The strictness
     * matters more now, not less: this token deliberately grants one publishing
     * capability, so the test has to prove it did not acquire a second.
     */
    expect(granted.video).toEqual({
      roomJoin: true,
      room: 'cockpit-abc123',
      canSubscribe: true,
      // No microphone. The one grant here that is a security boundary.
      canPublish: false,
      // Chosen deliberately: the demo is driven from the laptop while the
      // caller is on their phone, and the cockpit publishes only on the
      // `cockpit-control` topic. Without it the chaos panel is inert.
      canPublishData: true,
    });
  });

  /*
   * Split out of the `toEqual` above and asserted in its own right, because it
   * is now the ONLY thing between an observer and the call's audio. Before the
   * data grant, `canPublishData: false` was a second lock on the same door; a
   * regression here no longer has a backstop, so it gets a test that names it.
   */
  it('is never handed the microphone, whatever else it may publish', async () => {
    await poll([room('cockpit-abc123')]);
    const { claims: granted } = await mint({ observe: 'cockpit-abc123' });

    expect(granted.video.canPublish).toBe(false);
    /*
     * Absent, not merely empty. LiveKit reads `canPublishSources` as permission
     * to publish exactly those sources REGARDLESS of `canPublish: false`, so a
     * list containing `microphone` would silently undo the line above — and a
     * present-but-empty list is a shape nobody meant to write either.
     */
    expect(granted.video).not.toHaveProperty('canPublishSources');
    expect(Object.keys(granted.video)).not.toContain('canPublishSources');
  });

  it('observes a sip call as readily as a browser one', async () => {
    const names = ['cockpit-abc123', 'sip-cockpit-abc123', 'cockpit-a', 'cockpit-A-1-b'];
    await poll(names.map(room));
    for (const name of names) {
      const { response, payload } = await mint({ observe: name });
      expect(response.status).toBe(200);
      expect(payload.roomName).toBe(name);
    }
  });

  it('ignores a label when observing', async () => {
    await poll([room('cockpit-abc123')]);
    const { claims: granted } = await mint({ observe: 'cockpit-abc123', identity: 'Ada' });
    expect(granted.sub).toMatch(/^observer-[A-Za-z0-9]{8}$/);
  });

  const refused: [string, unknown][] = [
    ['a room belonging to something else', 'lobby-abc123'],
    ['a name that merely contains ours', 'evil-cockpit-abc123'],
    ['a traversal attempt', 'cockpit-../x'],
    ['a name with a space in it', 'cockpit-a b'],
    ['a name with a slash in it', 'cockpit-a/b'],
    ['a suffix past the length bound', `cockpit-${'a'.repeat(61)}`],
    ['a bare prefix with no suffix', 'cockpit-'],
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
    ['an object', { room: 'cockpit-abc123' }],
    ['an array of candidate rooms', ['cockpit-abc123']],
  ];

  for (const [name, observe] of refused) {
    it(`refuses ${name}`, async () => {
      const response = await handleToken(post({ observe }), env);
      // 403 and not a fresh caller token: falling through would answer 200 with
      // a token for a room the caller never asked about.
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Not an observable room' });
    });
  }

  it('accepts a suffix sitting exactly on the length bound', async () => {
    const name = `cockpit-${'a'.repeat(60)}`;
    await poll([room(name)]);
    const { response, payload } = await mint({ observe: name });
    expect(response.status).toBe(200);
    expect(payload.roomName).toBe(name);
  });

  /*
   * Kept deliberately, and only for the rollout window: the cockpit SPA ships
   * separately and keeps posting the raw name until it does. This block is the
   * reminder that deleting it is a coordinated change, not a tidy-up.
   */
  it('still takes a raw room name from an SPA that has not been updated yet', async () => {
    const names = ['cockpit-abc123', 'sip-cockpit-abc123'];
    await poll(names.map(room));
    for (const name of names) {
      const { response, payload, claims: granted } = await mint({ observe: name });
      expect(response.status).toBe(200);
      expect(payload.roomName).toBe(name);
      expect(granted.video.room).toBe(name);
    }
  });
});

/*
 * The handle path. /api/active stopped publishing room names because a SIP room
 * is named after the caller's phone number; what it publishes instead is an
 * opaque id, and this is the endpoint that has to turn one back into a room
 * without ever handing the mapping to anybody who did not already have it.
 */
describe('observing by handle', () => {
  it('mints a token for the real room behind the handle', async () => {
    const body = await poll([room(SIP_CALLER)]);
    const handle = body.rooms[0].room_id;

    // What the browser was given is an opaque id...
    expect(handle).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(body)).not.toContain('447700900123');

    const { response, claims: granted } = await mint({ observe: handle });

    // ...and what LiveKit is asked for is the room it actually knows. A grant
    // for the hash would be accepted by this Worker and rejected by LiveKit,
    // i.e. it would fail in the one place no test here can see.
    expect(response.status).toBe(200);
    expect(granted.video.room).toBe(SIP_CALLER);
  });

  it('gives a handle-minted seat exactly the same powers as any other observer', async () => {
    const body = await poll([room(SIP_CALLER)]);
    const { claims: granted } = await mint({ observe: body.rooms[0].room_id });

    expect(granted.sub).toMatch(/^observer-[A-Za-z0-9]{8}$/);
    // `toEqual`: the resolution branch must not have acquired a grant of its own.
    expect(granted.video).toEqual({
      roomJoin: true,
      room: SIP_CALLER,
      canSubscribe: true,
      canPublish: false,
      canPublishData: true,
    });
    // The audio boundary, asserted on this path too — the two mint sites share
    // a function today and a divergence here would be invisible otherwise.
    expect(granted.video).not.toHaveProperty('canPublishSources');
  });

  it('observes a browser call by handle just as readily', async () => {
    const body = await poll([room('cockpit-browsercall')]);
    const { claims: granted } = await mint({ observe: body.rooms[0].room_id });
    expect(granted.video.room).toBe('cockpit-browsercall');
  });

  it('refuses a well-formed handle for a call that is not live', async () => {
    // The snapshot is primed and empty: the id is the right shape and hashes a
    // plausible room, and there is simply no such call in progress.
    await poll([]);

    const response = await handleToken(post({ observe: await roomId(SIP_CALLER) }), env);
    expect(response.status).toBe(403);
    // Byte-identical to the refusal for junk. A distinguishable answer would
    // turn this endpoint into an oracle for "was this number ever on a call".
    expect(await response.json()).toEqual({ error: 'Not an observable room' });
  });

  it('refuses a handle for a room that exists but is not advertised', async () => {
    // Observer-only, so /api/active filters it out. Watching must be exactly as
    // available as the list says it is — not one step more.
    const watched = 'cockpit-watched';
    const body = await poll([room(watched)], {
      [watched]: [{ identity: 'observer-aaa' }, { identity: 'observer-bbb' }],
    });
    expect(body.rooms).toEqual([]);

    const response = await handleToken(post({ observe: await roomId(watched) }), env);
    expect(response.status).toBe(403);
  });

  it('refuses every handle while LiveKit is unreachable', async () => {
    // The degraded snapshot is an empty list, and an empty list resolves nothing
    // — a LiveKit outage must not fail open into "grant whatever was asked for".
    const body = await poll(new Error('livekit unreachable'));
    expect(body).toMatchObject({ rooms: [], degraded: true });

    const response = await handleToken(post({ observe: await roomId(SIP_CALLER) }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not an observable room' });
  });

  const malformed: [string, string][] = [
    ['fifteen hex characters', '0123456789abcde'],
    ['seventeen hex characters', '0123456789abcdef0'],
    ['upper-case hex', '0123456789ABCDEF'],
    ['sixteen characters that are not all hex', '0123456789abcdeg'],
    ['a handle with a space in it', '0123456789abcde '],
  ];

  for (const [name, observe] of malformed) {
    it(`refuses ${name}`, async () => {
      await poll([room(SIP_CALLER)]);

      const response = await handleToken(post({ observe }), env);
      // Neither a handle nor a room name, so it falls through both accepted
      // forms to the same 403 — never to a fresh caller token.
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Not an observable room' });
    });
  }

  it('still accepts the real room name of a live call, for now', async () => {
    /*
     * `sip-cockpit-_+447700900123_BXhCPPSrr57t` does match OBSERVABLE_ROOM, so
     * this is NOT a refusal — the backwards-compatible branch accepts it, and
     * has to until the SPA ships. Asserted rather than left implicit because it
     * is the one thing about this change that will look like a bug in review:
     * the leak is closed by /api/active no longer emitting the name, not by
     * this endpoint refusing to hear one.
     */
    await poll([room(SIP_CALLER)]);
    const { response, claims: granted } = await mint({ observe: SIP_CALLER });
    expect(response.status).toBe(200);
    expect(granted.video.room).toBe(SIP_CALLER);
  });

  it('refuses a raw room name whose call has ended', async () => {
    /*
     * The compatibility branch is checked for liveness exactly like a handle.
     * Matching OBSERVABLE_ROOM proves only that a string is SHAPED like one of
     * our rooms — a stale name lifted from a log, a replayed request, or a
     * lucky guess all match. Minting on the grammar alone would have left the
     * observer seat wide open while the opaque id made it look closed.
     */
    await poll([room('cockpit-abc123')]);
    expect((await mint({ observe: 'cockpit-abc123' })).response.status).toBe(200);

    // The call ends: the room list is now empty, and the same name is refused.
    resetActiveCache();
    await poll([]);
    const response = await handleToken(post({ observe: 'cockpit-abc123' }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not an observable room' });
  });

  it('refuses a well-formed room name that was never live', async () => {
    await poll([room('cockpit-something-else')]);
    const response = await handleToken(post({ observe: 'cockpit-neverexisted' }), env);
    expect(response.status).toBe(403);
  });
});

describe('both paths', () => {
  it('expire fifteen minutes after they are minted', async () => {
    await poll([room('cockpit-abc123')]);
    for (const body of [undefined, { observe: 'cockpit-abc123' }]) {
      const { claims: granted } = await mint(body);
      expect(granted.exp - granted.nbf).toBeGreaterThanOrEqual(895);
      expect(granted.exp - granted.nbf).toBeLessThanOrEqual(905);
    }
  });

  it('are signed by this deployment', async () => {
    const { claims: granted } = await mint();
    expect(granted.iss).toBe('devkey');
  });

  it('are only handed out on a POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await handleToken(
        new Request('https://cockpit.example/api/token', { method }),
        env,
      );
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: 'Use POST' });
    }
  });
});

/**
 * /api/active is the one endpoint a visitor hits without asking for anything, on
 * a timer, from every open tab. Its rules are therefore mostly about what it
 * refuses to do — fan out, count observers, or fail — and all of them are
 * exercised here through the `RoomsApi` port rather than against LiveKit.
 *
 * The SDK is mocked at module level so the credential paths can be checked by
 * whether a client was ever constructed, which is the only observable
 * difference between "answered degraded" and "tried and failed".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_TTL_MS,
  MAX_CANDIDATE_ROOMS,
  MAX_ROOM_AGE_SECONDS,
  apiHost,
  collectActiveRooms,
  handleActiveGet,
  resetActiveCache,
  resolveRoomId,
  type ActiveRoomsBody,
  type ParticipantSnapshot,
  type RoomSnapshot,
  type RoomsApi,
} from './active';
import type { Env } from './env';
import worker from './index';
import { ROOM_ID, roomId } from './rooms';

const sdk = vi.hoisted(() => ({ constructed: [] as string[][] }));

// Only the room client is replaced: importing the route table below pulls in
// token.ts, which needs the real AccessToken.
vi.mock('livekit-server-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('livekit-server-sdk')>()),
  RoomServiceClient: class {
    constructor(...args: string[]) {
      sdk.constructed.push(args);
    }
    async listRooms(): Promise<RoomSnapshot[]> {
      return [];
    }
    async listParticipants(): Promise<{ identity: string }[]> {
      return [];
    }
  },
}));

const env = {
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'devsecret',
  LIVEKIT_URL: 'wss://livekik-rbhzpdof.livekit.cloud',
} as unknown as Env;

/**
 * The moment every test below pretends it is, a hundred seconds after the oldest
 * fixture.
 *
 * Not decoration: rooms now age out of the list after `MAX_ROOM_AGE_SECONDS`,
 * so against a real clock these August-2024 fixtures are orphans by two years
 * and every one of them would vanish. Pinning the clock is what keeps the
 * fixtures meaning what they meant when they were written — and if the pin is
 * ever removed, this file fails loudly rather than quietly testing empty lists.
 */
const NOW_SECONDS = 1723000100;

function room(name: string, createdAt: number, numParticipants = 2): RoomSnapshot {
  return { name, numParticipants, creationTime: BigInt(createdAt) };
}

function people(...identities: string[]): ParticipantSnapshot[] {
  return identities.map((identity) => ({ identity }));
}

/** `livekit.ParticipantInfo.Kind`: the two values these tests care about. */
const KIND_STANDARD = 0;
const KIND_AGENT = 4;

interface Fake extends RoomsApi {
  roomCalls: number;
  participantCalls: string[];
}

/**
 * A `RoomsApi` that counts what it was asked for. Pass an Error in place of the
 * room list or of a room's participants to make that one call reject; any room
 * with no entry in `participants` answers with a single live caller, so a test
 * only has to describe the rooms it actually cares about.
 */
function fakeApi(
  rooms: RoomSnapshot[] | Error,
  participants: Record<string, ParticipantSnapshot[] | Error> = {},
): Fake {
  const fake: Fake = {
    roomCalls: 0,
    participantCalls: [],
    async listRooms() {
      fake.roomCalls += 1;
      if (rooms instanceof Error) throw rooms;
      return rooms;
    },
    async listParticipants(name: string) {
      fake.participantCalls.push(name);
      const found = participants[name];
      if (found instanceof Error) throw found;
      return found ?? people('visitor-abc');
    },
  };
  return fake;
}

beforeEach(() => {
  resetActiveCache();
  sdk.constructed.length = 0;
  // See NOW_SECONDS. A test that wants a different clock re-mocks this itself.
  vi.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectActiveRooms', () => {
  it('finds both entry doors and labels each one by its prefix', async () => {
    const { rooms, degraded } = await collectActiveRooms(
      fakeApi([room('sip-cockpit-abc123', 1723000000), room('cockpit-xyz789', 1723000001)]),
    );

    expect(degraded).toBe(false);
    expect(rooms.map((entry) => [entry.name, entry.entry])).toEqual([
      ['cockpit-xyz789', 'browser'],
      ['sip-cockpit-abc123', 'sip'],
    ]);
  });

  it('calls a sip room sip even though its name also ends in the browser prefix', async () => {
    // `sip-cockpit-x` would be mislabelled the moment the two prefix tests swap
    // order, and the mislabel is invisible in the response shape.
    const { rooms } = await collectActiveRooms(fakeApi([room('sip-cockpit-x', 1723000000)]));
    expect(rooms[0].entry).toBe('sip');
  });

  it('ignores rooms this demo did not create', async () => {
    const api = fakeApi([
      room('cockpit-keep', 1723000000),
      room('lobby-1', 1723000001),
      room('sipcockpit-2', 1723000002),
      room('my-cockpit-3', 1723000003),
      room('', 1723000004),
    ]);

    const { rooms } = await collectActiveRooms(api);
    expect(rooms.map((entry) => entry.name)).toEqual(['cockpit-keep']);
    // Filtered before any per-room work, not after.
    expect(api.participantCalls).toEqual(['cockpit-keep']);
  });

  it('does not advertise a room whose only occupants are observers', async () => {
    const { rooms } = await collectActiveRooms(
      fakeApi([room('cockpit-watched', 1723000000, 3)], {
        'cockpit-watched': people('observer-aaa', 'observer-bbb', 'observer-ccc'),
      }),
    );

    expect(rooms).toEqual([]);
  });

  it('counts the humans on the call, not the people watching it or the agent serving it', async () => {
    const { rooms } = await collectActiveRooms(
      fakeApi([room('cockpit-live', 1723000000, 9)], {
        'cockpit-live': people(
          'observer-aaa',
          'visitor-bob',
          'agent-cockpit',
          'observer-bbb',
          'sip-caller-1',
        ),
      }),
    );

    /*
     * Two callers, not the room's own numParticipants of 9 — and not 3, which is
     * what this test asserted until an agent that outlived its caller held a
     * room open, and listed, for 998 seconds. The agent is not somebody to
     * listen to; a room containing only the agent is a room with nobody in it.
     */
    expect(rooms).toEqual([
      {
        name: 'cockpit-live',
        room_id: await roomId('cockpit-live'),
        entry: 'browser',
        num_participants: 2,
        created_at: 1723000000,
      },
    ]);
  });

  it('returns the newest call first', async () => {
    const { rooms } = await collectActiveRooms(
      fakeApi([
        room('cockpit-middle', 1723000500),
        room('cockpit-oldest', 1723000000),
        room('cockpit-newest', 1723009999),
      ]),
    );

    expect(rooms.map((entry) => entry.name)).toEqual([
      'cockpit-newest',
      'cockpit-middle',
      'cockpit-oldest',
    ]);
    expect(rooms.map((entry) => entry.created_at)).toEqual([1723009999, 1723000500, 1723000000]);
  });

  it('keeps only the ten newest candidates, and asks about no others', async () => {
    const api = fakeApi(
      Array.from({ length: 25 }, (_, index) => room(`cockpit-${index}`, 1723000000 + index)),
    );

    const { rooms } = await collectActiveRooms(api);

    expect(MAX_CANDIDATE_ROOMS).toBe(10);
    expect(api.participantCalls).toHaveLength(MAX_CANDIDATE_ROOMS);
    // Rooms 15..24 are the newest ten; the participant fan-out never touches the
    // other fifteen, which is the entire point of capping before the round trips.
    expect([...api.participantCalls].sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `cockpit-${15 + index}`).sort(),
    );
    expect(rooms).toHaveLength(10);
    expect(rooms[0].name).toBe('cockpit-24');
  });

  /*
   * The cap is applied to rooms that merely look like ours, before anyone has
   * asked who is in them. So a truncated list can hide a real call behind ten
   * stale ones, and saying so is the difference between "no calls right now" and
   * "I could not see all of them".
   */
  it('admits it is degraded when the candidate list had to be truncated', async () => {
    const api = fakeApi(
      Array.from({ length: 11 }, (_, index) => room(`cockpit-${index}`, 1723000000 + index)),
    );

    const { rooms, degraded } = await collectActiveRooms(api);
    expect(rooms).toHaveLength(10);
    expect(degraded).toBe(true);
  });

  it('is not degraded when every candidate fitted', async () => {
    const api = fakeApi(
      Array.from({ length: 10 }, (_, index) => room(`cockpit-${index}`, 1723000000 + index)),
    );

    const { rooms, degraded } = await collectActiveRooms(api);
    expect(rooms).toHaveLength(10);
    expect(degraded).toBe(false);
  });

  it('counts only rooms that could be ours towards the cap', async () => {
    // Fifty unrelated rooms must not truncate anything, or every deployment
    // sharing a LiveKit project would permanently report itself degraded.
    const api = fakeApi([
      ...Array.from({ length: 50 }, (_, index) => room(`lobby-${index}`, 1723000000 + index)),
      room('cockpit-real', 1723000000),
    ]);

    const { rooms, degraded } = await collectActiveRooms(api);
    expect(rooms.map((entry) => entry.name)).toEqual(['cockpit-real']);
    expect(degraded).toBe(false);
  });

  it('sorts a room with no creation time last instead of scrambling the order', async () => {
    const api = fakeApi([
      { name: 'cockpit-unstamped', numParticipants: 1, creationTime: 0 },
      room('cockpit-old', 1723000000),
      room('cockpit-new', 1723009999),
    ]);

    const { rooms } = await collectActiveRooms(api);
    expect(rooms.map((entry) => entry.name)).toEqual([
      'cockpit-new',
      'cockpit-old',
      'cockpit-unstamped',
    ]);
    expect(rooms[2].created_at).toBe(0);
  });

  it('gives up on the whole list when the room list itself fails', async () => {
    const api = fakeApi(new Error('livekit unreachable'));
    await expect(collectActiveRooms(api)).resolves.toEqual({ rooms: [], degraded: true });
    expect(api.participantCalls).toEqual([]);
  });

  it('drops one unlucky room and still returns the rest', async () => {
    const { rooms, degraded } = await collectActiveRooms(
      fakeApi(
        [
          room('cockpit-good', 1723000002),
          room('cockpit-broken', 1723000001),
          room('cockpit-alsogood', 1723000000),
        ],
        { 'cockpit-broken': new Error('room gone') },
      ),
    );

    expect(rooms.map((entry) => entry.name)).toEqual(['cockpit-good', 'cockpit-alsogood']);
    expect(degraded).toBe(true);
  });
});

describe('apiHost', () => {
  it('turns the browser signalling URL into the one the API client wants', () => {
    expect(apiHost('wss://livekik-rbhzpdof.livekit.cloud')).toBe(
      'https://livekik-rbhzpdof.livekit.cloud',
    );
    expect(apiHost('ws://localhost:7880')).toBe('http://localhost:7880');
    expect(apiHost('https://already.example')).toBe('https://already.example');
  });

  it('accepts an upper-case scheme, because URL schemes are case-insensitive', () => {
    // Left unhandled, a `WSS://` in a config file reaches fetch untouched and
    // fails every request — presenting as a LiveKit outage rather than a typo.
    expect(apiHost('WSS://livekik-rbhzpdof.livekit.cloud')).toBe(
      'https://livekik-rbhzpdof.livekit.cloud',
    );
  });
});

describe('handleActiveGet', () => {
  it('declares JSON and a four-second cache window', async () => {
    const response = await handleActiveGet(env, fakeApi([room('cockpit-a', 1723000000)]));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private, max-age=4');
  });

  it('stamps the response with the time it was generated', async () => {
    const before = Date.now() / 1000;
    const response = await handleActiveGet(env, fakeApi([room('cockpit-a', 1723000000)]));
    const body = (await response.json()) as ActiveRoomsBody;

    expect(body.generated_at).toBeGreaterThanOrEqual(before);
    expect(body.generated_at).toBeLessThanOrEqual(Date.now() / 1000);
    expect(body.degraded).toBe(false);
    expect(body.rooms).toHaveLength(1);
  });

  it('answers 200 and degraded when LiveKit is unreachable, never 5xx', async () => {
    const response = await handleActiveGet(env, fakeApi(new Error('livekit unreachable')));

    expect(response.status).toBe(200);
    expect((await response.json()) as ActiveRoomsBody).toMatchObject({
      rooms: [],
      degraded: true,
    });
  });

  it('answers 200 and degraded without constructing a client when credentials are missing', async () => {
    const bare = { LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '', LIVEKIT_URL: '' } as unknown as Env;
    const response = await handleActiveGet(bare);

    expect(response.status).toBe(200);
    expect((await response.json()) as ActiveRoomsBody).toMatchObject({
      rooms: [],
      degraded: true,
    });
    expect(sdk.constructed).toEqual([]);
  });

  it('builds the real client against the https host, on a leash', async () => {
    await handleActiveGet(env);
    // The options are asserted, not merely passed: the SDK's own defaults are a
    // 10 s timeout and up to three region attempts, which on an endpoint polled
    // every 5 s is a request that outlives several of its own successors.
    expect(sdk.constructed).toEqual([
      [
        'https://livekik-rbhzpdof.livekit.cloud',
        'devkey',
        'devsecret',
        { requestTimeout: 3, failover: false },
      ],
    ]);
  });

  it('serves a second poll from the memo instead of calling LiveKit again', async () => {
    const api = fakeApi([room('cockpit-a', 1723000000)]);

    const first = (await (await handleActiveGet(env, api)).json()) as ActiveRoomsBody;
    const second = (await (await handleActiveGet(env, api)).json()) as ActiveRoomsBody;

    expect(api.roomCalls).toBe(1);
    expect(api.participantCalls).toEqual(['cockpit-a']);
    // Same body, down to the timestamp: it is literally the same snapshot.
    expect(second).toEqual(first);
  });

  it('memoizes a degraded answer too, so a broken LiveKit is not hammered', async () => {
    const api = fakeApi(new Error('livekit unreachable'));

    await handleActiveGet(env, api);
    await handleActiveGet(env, api);

    expect(api.roomCalls).toBe(1);
  });

  it('goes back to LiveKit once the window has passed', async () => {
    const api = fakeApi([room('cockpit-a', 1723000000)]);
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(1_700_000_000_000);
    await handleActiveGet(env, api);
    now.mockReturnValue(1_700_000_000_000 + CACHE_TTL_MS + 1);
    await handleActiveGet(env, api);

    expect(api.roomCalls).toBe(2);
  });

  it('goes back to LiveKit after resetActiveCache', async () => {
    const api = fakeApi([room('cockpit-a', 1723000000)]);

    await handleActiveGet(env, api);
    resetActiveCache();
    await handleActiveGet(env, api);

    expect(api.roomCalls).toBe(2);
  });

  it('collapses a burst of simultaneous polls into one round trip', async () => {
    // The memo holds the in-flight promise, so these three all wait on the same
    // call rather than each starting their own — the case a settled-body cache
    // would miss entirely, because none of them arrive after a completed poll.
    const counted = fakeApi([room('cockpit-a', 1723000000)]);
    const slow: RoomsApi = {
      listRooms: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return counted.listRooms();
      },
      listParticipants: (name) => counted.listParticipants(name),
    };

    const bodies = await Promise.all([
      handleActiveGet(env, slow),
      handleActiveGet(env, slow),
      handleActiveGet(env, slow),
    ]);

    expect(counted.roomCalls).toBe(1);
    expect(counted.participantCalls).toEqual(['cockpit-a']);
    expect(bodies).toHaveLength(3);
  });
});

describe('the /api/active route', () => {
  it('answers a GET', async () => {
    const response = await worker.fetch(
      new Request('https://cockpit.example/api/active', { method: 'GET' }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=4');
    expect((await response.json()) as ActiveRoomsBody).toMatchObject({ rooms: [], degraded: false });
  });

  it('refuses anything but a GET', async () => {
    const response = await worker.fetch(
      new Request('https://cockpit.example/api/active', { method: 'POST' }),
      env,
    );

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: 'Use GET' });
  });
});

/*
 * The room name of a phone call is the caller's phone number, and this endpoint
 * is fetched on a timer by every anonymous visitor on the front page. That
 * combination shipped, and these are the tests that say it never ships again.
 *
 * `+447700900123` is Ofcom's reserved drama range: a number that looks exactly
 * like a real one to every rule in this codebase and belongs to nobody.
 */
const SIP_CALLER = 'sip-cockpit-_+447700900123_BXhCPPSrr57t';

describe('caller numbers never reach the wire', () => {
  it('leaks nothing anywhere in the serialized body, not merely in the field we remembered', async () => {
    const response = await handleActiveGet(
      env,
      fakeApi([room(SIP_CALLER, 1723000000), room('cockpit-plain', 1723000001)]),
    );

    /*
     * Asserted against the raw response text rather than a parsed field on
     * purpose. Picking fields is how the leak survived review the first time —
     * every individual assertion passed, because none of them looked at `room`.
     * A future field that reintroduces the name fails here and nowhere else.
     */
    const text = await response.text();

    expect(text).not.toContain('447700900123');
    expect(text).not.toContain('+44');
    // The prefix carrying the number, not the `sip-cockpit-` classifier prefix:
    // the trailing underscore is where LiveKit's dispatch starts the number.
    expect(text).not.toContain('sip-cockpit-_');
    expect(text).not.toContain('BXhCPPSrr57t');

    // ...and the call is still advertised. A body that leaked nothing because it
    // was empty would pass every assertion above and be useless.
    const body = JSON.parse(text) as ActiveRoomsBody;
    expect(body.rooms).toHaveLength(2);
    expect(body.rooms.map((entry) => entry.entry)).toEqual(['browser', 'sip']);
  });

  it('publishes a handle in place of the name, and nothing else about the room', async () => {
    const response = await handleActiveGet(env, fakeApi([room(SIP_CALLER, 1723000000)]));
    const body = (await response.json()) as ActiveRoomsBody;

    // `toEqual`, not `toMatchObject`: the point of this test is the absence of a
    // fifth key, which a subset match cannot see.
    expect(body.rooms).toEqual([
      {
        room_id: await roomId(SIP_CALLER),
        entry: 'sip',
        num_participants: 1,
        created_at: 1723000000,
      },
    ]);
  });

  it('shapes every handle like a room id', async () => {
    const { rooms } = await collectActiveRooms(
      fakeApi([room(SIP_CALLER, 1723000000), room('cockpit-plain', 1723000001)]),
    );

    for (const entry of rooms) expect(entry.room_id).toMatch(ROOM_ID);
  });

  it('gives one room the same handle every poll, and two rooms different ones', async () => {
    const first = await collectActiveRooms(fakeApi([room(SIP_CALLER, 1723000000)]));
    const second = await collectActiveRooms(
      fakeApi([room(SIP_CALLER, 1723000000), room('cockpit-other', 1723000001)]),
    );

    // Stable: the cockpit polls every few seconds and must not see the call it
    // is already watching turn into a different call.
    expect(second.rooms[1].room_id).toBe(first.rooms[0].room_id);
    expect(second.rooms[0].room_id).not.toBe(second.rooms[1].room_id);
  });

  it('does not collide two rooms that differ only in the caller number', async () => {
    // The random suffix is what LiveKit varies per call; the number is what a
    // handle must not quietly generalise over.
    const other = 'sip-cockpit-_+447700900456_BXhCPPSrr57t';
    const { rooms } = await collectActiveRooms(
      fakeApi([room(SIP_CALLER, 1723000000), room(other, 1723000001)]),
    );

    expect(rooms[0].room_id).not.toBe(rooms[1].room_id);
  });
});

/*
 * From production, and the reason these tests exist rather than being obvious:
 * an agent redeploy mid-call orphaned a SIP room at 1786099630. The caller had
 * hung up; the agent process that survived the deploy had not, so the room stayed
 * open with exactly one participant in it and /api/active advertised it as a live
 * call for 998 seconds, until it was deleted by hand. Every rule below is that
 * room, from a different angle.
 */
describe('an orphaned room is not a live call', () => {
  it('does not list a room whose only occupant is the agent, by kind', async () => {
    const { rooms } = await collectActiveRooms(
      fakeApi([room('sip-cockpit-orphan', 1723000000, 1)], {
        'sip-cockpit-orphan': [{ identity: 'AG_7fJq2', kind: KIND_AGENT }],
      }),
    );

    // The identity here is deliberately NOT `agent-`-prefixed: this asserts the
    // `kind` rule on its own, with the prefix fallback given nothing to match.
    expect(rooms).toEqual([]);
  });

  it('does not list a room whose only occupant is the agent, by identity prefix', async () => {
    const { rooms } = await collectActiveRooms(
      fakeApi([room('sip-cockpit-orphan', 1723000000, 1)], {
        // No `kind` at all — an older server, or a fake that forgot. The prefix
        // is the whole defence, which is exactly when it has to work.
        'sip-cockpit-orphan': people('agent-cockpit'),
      }),
    );

    expect(rooms).toEqual([]);
  });

  it('lists a call the agent is serving, and counts only the caller', async () => {
    const { rooms } = await collectActiveRooms(
      fakeApi([room('sip-cockpit-real', 1723000000, 4)], {
        'sip-cockpit-real': [
          { identity: 'AG_7fJq2', kind: KIND_AGENT },
          { identity: 'sip_+447700900123', kind: 3 },
          { identity: 'observer-aaa', kind: KIND_STANDARD },
        ],
      }),
    );

    // The guard must not swing so far that a call in progress disappears: one
    // caller, agent and observer discounted.
    expect(rooms).toHaveLength(1);
    expect(rooms[0].num_participants).toBe(1);
  });

  it('counts a browser caller and a sip caller, and no other kind', async () => {
    const { rooms } = await collectActiveRooms(
      fakeApi([room('cockpit-mixed', 1723000000, 5)], {
        'cockpit-mixed': [
          { identity: 'visitor-ada', kind: KIND_STANDARD },
          { identity: 'sip_+447700900123', kind: 3 },
          // Egress: a recorder, not a person. Excluded by the allow-list rather
          // than by being explicitly named, which is the point of allow-listing.
          { identity: 'EG_recorder', kind: 2 },
        ],
      }),
    );

    expect(rooms[0].num_participants).toBe(2);
  });

  it('does not list a room older than the age ceiling, even with a caller in it', async () => {
    const now = 1723000000 + MAX_ROOM_AGE_SECONDS + 1;
    const { rooms, degraded } = await collectActiveRooms(
      fakeApi([room('sip-cockpit-orphan', 1723000000)]),
      now,
    );

    // The participant rules are the real fix and this is the backstop: it catches
    // the orphan even when whatever is holding the room open looks like a caller.
    expect(rooms).toEqual([]);
    // Not degraded. This is a room the endpoint has judged, not one it missed.
    expect(degraded).toBe(false);
  });

  it('still lists a room sitting just inside the age ceiling', async () => {
    const now = 1723000000 + MAX_ROOM_AGE_SECONDS;
    const { rooms } = await collectActiveRooms(fakeApi([room('cockpit-long', 1723000000)]), now);

    // Exactly on the bound is inside it: a call that hits the ceiling on the
    // stroke of the poll should not vanish mid-sentence.
    expect(rooms.map((entry) => entry.name)).toEqual(['cockpit-long']);
    expect(MAX_ROOM_AGE_SECONDS).toBe(30 * 60);
  });

  it('drops an aged-out room before it can cost a round trip or a candidate slot', async () => {
    const now = 1723000000 + MAX_ROOM_AGE_SECONDS + 1;
    const api = fakeApi([
      ...Array.from({ length: 20 }, (_, index) => room(`cockpit-orphan-${index}`, 1723000000)),
      room('cockpit-fresh', now - 5),
    ]);

    const { rooms, degraded } = await collectActiveRooms(api, now);

    // Twenty orphans must not crowd the one real call out of the ten-candidate
    // window, and must not each cost a listParticipants call to discover.
    expect(api.participantCalls).toEqual(['cockpit-fresh']);
    expect(rooms.map((entry) => entry.name)).toEqual(['cockpit-fresh']);
    // And truncation is not reported, because nothing was truncated.
    expect(degraded).toBe(false);
  });

  it('does not judge the age of a room whose creation time is unknown', async () => {
    // 0 means "LiveKit did not say", not "1970". Guessing stale there would hide
    // live calls on any deployment that stopped populating the field.
    const { rooms } = await collectActiveRooms(
      fakeApi([{ name: 'cockpit-unstamped', numParticipants: 1, creationTime: 0 }]),
      1723000000 + MAX_ROOM_AGE_SECONDS * 100,
    );

    expect(rooms.map((entry) => entry.name)).toEqual(['cockpit-unstamped']);
  });

  it('keeps the orphan off the public body entirely, not merely out of the count', async () => {
    const orphan = 'sip-cockpit-_+447700900123_BXhCPPSrr57t';
    const response = await handleActiveGet(
      env,
      fakeApi([room(orphan, 1723000000, 1)], { [orphan]: people('agent-cockpit') }),
    );

    // The 998-second incident in one assertion: an orphaned SIP room published a
    // caller's number to the front page. Neither the room nor the number appears.
    const text = await response.text();
    expect(text).not.toContain('447700900123');
    expect(JSON.parse(text) as ActiveRoomsBody).toMatchObject({ rooms: [], degraded: false });
  });
});

describe('resolveRoomId', () => {
  it('turns a handle from /api/active back into the name LiveKit knows', async () => {
    const api = fakeApi([room(SIP_CALLER, 1723000000)]);
    const body = (await (await handleActiveGet(env, api)).json()) as ActiveRoomsBody;

    // The round trip a real observer makes: poll, take the handle, ask to watch.
    await expect(resolveRoomId(env, body.rooms[0].room_id, api)).resolves.toBe(SIP_CALLER);
  });

  it('answers from the poll that already happened, without asking LiveKit again', async () => {
    const api = fakeApi([room(SIP_CALLER, 1723000000)]);
    const body = (await (await handleActiveGet(env, api)).json()) as ActiveRoomsBody;

    await resolveRoomId(env, body.rooms[0].room_id, api);
    await resolveRoomId(env, body.rooms[0].room_id, api);

    // One `listRooms` for the poll and none for the two resolutions. Without the
    // shared memo, /api/token would become an unmetered amplifier of LiveKit
    // traffic — it is the one endpoint an anonymous client can call in a loop.
    expect(api.roomCalls).toBe(1);
    expect(api.participantCalls).toEqual([SIP_CALLER]);
  });

  it('stops resolving a handle once the call is over', async () => {
    const api = fakeApi([room(SIP_CALLER, 1723000000)]);
    const body = (await (await handleActiveGet(env, api)).json()) as ActiveRoomsBody;
    const handle = body.rooms[0].room_id;

    // The call ends; the next poll sees an empty project.
    resetActiveCache();
    await expect(resolveRoomId(env, handle, fakeApi([]))).resolves.toBeNull();
  });

  it('will not resolve a room that is live but not advertised', async () => {
    // Observer-only rooms are filtered out of /api/active, so their handles must
    // not work either — otherwise the id becomes a way into a call the list
    // deliberately declined to offer.
    const watched = 'cockpit-watched';
    const api = fakeApi([room(watched, 1723000000, 3)], {
      [watched]: people('observer-aaa', 'observer-bbb'),
    });

    const body = (await (await handleActiveGet(env, api)).json()) as ActiveRoomsBody;
    expect(body.rooms).toEqual([]);

    await expect(resolveRoomId(env, await roomId(watched), api)).resolves.toBeNull();
  });

  it('will not resolve a room pushed out of the candidate window', async () => {
    const api = fakeApi(
      Array.from({ length: 11 }, (_, index) => room(`cockpit-${index}`, 1723000000 + index)),
    );
    await handleActiveGet(env, api);

    // `cockpit-0` is the oldest of eleven and never got a participant call, so
    // it has no handle and cannot acquire one by being guessed at.
    await expect(resolveRoomId(env, await roomId('cockpit-0'), api)).resolves.toBeNull();
    await expect(resolveRoomId(env, await roomId('cockpit-10'), api)).resolves.toBe('cockpit-10');
  });

  it('resolves nothing while LiveKit is unreachable', async () => {
    const api = fakeApi(new Error('livekit unreachable'));
    await expect(resolveRoomId(env, await roomId(SIP_CALLER), api)).resolves.toBeNull();
  });

  const notHandles: [string, string][] = [
    ['an empty string', ''],
    ['a short hex run', '0123456789abcde'],
    ['a long hex run', '0123456789abcdef0'],
    ['upper-case hex', '0123456789ABCDEF'],
    ['hex with a stray character', '0123456789abcde!'],
    ['a room name', 'cockpit-abc123'],
    ['the real room name it hashes', SIP_CALLER],
  ];

  for (const [name, id] of notHandles) {
    it(`refuses ${name} without calling LiveKit at all`, async () => {
      const api = fakeApi([room(SIP_CALLER, 1723000000)]);
      await expect(resolveRoomId(env, id, api)).resolves.toBeNull();
      // Shape-checked before the snapshot: garbage must not cost a round trip,
      // and a room's own name must never be accepted in place of its handle.
      expect(api.roomCalls).toBe(0);
    });
  }
});

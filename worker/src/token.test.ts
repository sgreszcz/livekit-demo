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

import { describe, expect, it } from 'vitest';
import type { Env } from './env';
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
    const { response, payload, claims: granted } = await mint({ observe: 'cockpit-abc123' });

    expect(response.status).toBe(200);
    expect(payload.roomName).toBe('cockpit-abc123');
    expect(granted.video.room).toBe('cockpit-abc123');
    expect(payload.url).toBe('wss://livekik-rbhzpdof.livekit.cloud');
  });

  it('identifies the holder as an observer', async () => {
    // /api/active discounts exactly this prefix when counting live callers, so
    // the shape of the identity is a contract, not decoration.
    const { claims: granted } = await mint({ observe: 'cockpit-abc123' });
    expect(granted.sub).toMatch(/^observer-[A-Za-z0-9]{8}$/);
  });

  it('can listen and nothing else', async () => {
    const { claims: granted } = await mint({ observe: 'cockpit-abc123' });

    /*
     * `toEqual`, not `toMatchObject`. A test titled "and nothing else" that
     * cannot fail on an *extra* grant is not testing its own title:
     * `roomAdmin`, `hidden`, `recorder` or a `canPublishSources` list — which
     * the server reads as permission to publish those sources regardless of
     * `canPublish: false` — would all slip past a subset match.
     */
    expect(granted.video).toEqual({
      roomJoin: true,
      room: 'cockpit-abc123',
      canSubscribe: true,
      // The two that matter: a publishing observer could speak to the agent or
      // forge frames on the chaos-control topic in a call it is only watching.
      canPublish: false,
      canPublishData: false,
    });
  });

  it('observes a sip call as readily as a browser one', async () => {
    for (const name of ['cockpit-abc123', 'sip-cockpit-abc123', 'cockpit-a', 'cockpit-A-1-b']) {
      const { response, payload } = await mint({ observe: name });
      expect(response.status).toBe(200);
      expect(payload.roomName).toBe(name);
    }
  });

  it('ignores a label when observing', async () => {
    const { claims: granted } = await mint({ observe: 'cockpit-abc123', identity: 'Ada' });
    expect(granted.sub).toMatch(/^observer-[A-Za-z0-9]{8}$/);
  });

  const refused: [string, unknown][] = [
    ['a room belonging to something else', 'lobby-abc123'],
    ['a name that merely contains ours', 'evil-cockpit-abc123'],
    ['a traversal attempt', 'cockpit-../x'],
    ['a name with a space in it', 'cockpit-a b'],
    ['a name with a slash in it', 'cockpit-a/b'],
    ['a suffix past the length bound', `cockpit-${'a'.repeat(41)}`],
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
    const name = `cockpit-${'a'.repeat(40)}`;
    const { response, payload } = await mint({ observe: name });
    expect(response.status).toBe(200);
    expect(payload.roomName).toBe(name);
  });
});

describe('both paths', () => {
  it('expire fifteen minutes after they are minted', async () => {
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

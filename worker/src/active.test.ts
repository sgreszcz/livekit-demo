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
  apiHost,
  collectActiveRooms,
  handleActiveGet,
  resetActiveCache,
  type ActiveRoomsBody,
  type RoomSnapshot,
  type RoomsApi,
} from './active';
import type { Env } from './env';
import worker from './index';

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

function room(name: string, createdAt: number, numParticipants = 2): RoomSnapshot {
  return { name, numParticipants, creationTime: BigInt(createdAt) };
}

function people(...identities: string[]): { identity: string }[] {
  return identities.map((identity) => ({ identity }));
}

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
  participants: Record<string, { identity: string }[] | Error> = {},
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
    expect(rooms.map((entry) => [entry.room, entry.entry])).toEqual([
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
    expect(rooms.map((entry) => entry.room)).toEqual(['cockpit-keep']);
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

  it('counts the humans on the call, not the people watching it', async () => {
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

    // Three non-observers, not the room's own numParticipants of 9.
    expect(rooms).toEqual([
      { room: 'cockpit-live', entry: 'browser', num_participants: 3, created_at: 1723000000 },
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

    expect(rooms.map((entry) => entry.room)).toEqual([
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
    expect(rooms[0].room).toBe('cockpit-24');
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
    expect(rooms.map((entry) => entry.room)).toEqual(['cockpit-real']);
    expect(degraded).toBe(false);
  });

  it('sorts a room with no creation time last instead of scrambling the order', async () => {
    const api = fakeApi([
      { name: 'cockpit-unstamped', numParticipants: 1, creationTime: 0 },
      room('cockpit-old', 1723000000),
      room('cockpit-new', 1723009999),
    ]);

    const { rooms } = await collectActiveRooms(api);
    expect(rooms.map((entry) => entry.room)).toEqual([
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

    expect(rooms.map((entry) => entry.room)).toEqual(['cockpit-good', 'cockpit-alsogood']);
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

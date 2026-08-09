/**
 * The keep-warm ping, and the promise that it is invisible.
 *
 * Two quite different things are tested here. The first is the cron's own behaviour —
 * create, delete, skip, swallow — which is ordinary logic over the `WarmupApi` port.
 *
 * The second matters more and looks like paranoia: that a `warmup-` room cannot appear
 * anywhere a visitor can see it. That property is not implemented anywhere. It is an
 * emergent consequence of two unrelated prefix checks written before warm-ups existed —
 * `classifyEntry` in active.ts and `OBSERVABLE_ROOM` in token.ts — and nothing about
 * either of them says "and this is what keeps warm-up rooms off the front page". Both are
 * one plausible edit away from becoming false: widening the observable-room grammar, or
 * adding a third entry type. So the consequence is asserted directly, here, next to the
 * feature that depends on it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyEntry,
  resetActiveCache,
  type ParticipantSnapshot,
  type RoomSnapshot,
  type RoomsApi,
} from './active';
import type { Env } from './env';
import worker from './index';
import {
  runWarmup,
  warmupRoomName,
  WARMUP_ROOM_PREFIX,
  WARMUP_ROOM_TIMEOUT_SECONDS,
  type WarmupApi,
} from './warmup';

const sdk = vi.hoisted(() => ({
  constructed: [] as string[][],
  created: [] as { name: string; emptyTimeout?: number; departureTimeout?: number }[],
  deleted: [] as string[],
  /** What the mocked `listRooms` reports. Set by the tests that go through the router,
   *  which reach LiveKit through the real factory rather than an injected port. */
  listed: [] as { name: string; numParticipants: number; creationTime: bigint }[],
  participants: [] as { identity: string; kind?: number }[],
}));

// Only the room client is replaced: the route table pulls in token.ts, which signs with
// the real AccessToken.
vi.mock('livekit-server-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('livekit-server-sdk')>()),
  RoomServiceClient: class {
    constructor(...args: string[]) {
      sdk.constructed.push(args);
    }
    async listRooms(): Promise<RoomSnapshot[]> {
      return sdk.listed;
    }
    async listParticipants(): Promise<ParticipantSnapshot[]> {
      return sdk.participants;
    }
    async createRoom(options: { name: string }): Promise<void> {
      sdk.created.push(options);
    }
    async deleteRoom(name: string): Promise<void> {
      sdk.deleted.push(name);
    }
  },
}));

const env = {
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'devsecret',
  LIVEKIT_URL: 'wss://livekik-rbhzpdof.livekit.cloud',
} as unknown as Env;

/** A `WarmupApi` double that records what it was asked to do. */
function recordingApi(
  overrides: Partial<WarmupApi> = {},
): WarmupApi & { created: string[]; deleted: string[] } {
  const created: string[] = [];
  const deleted: string[] = [];
  return {
    created,
    deleted,
    createRoom: async (name: string) => {
      created.push(name);
    },
    deleteRoom: async (name: string) => {
      deleted.push(name);
    },
    ...overrides,
  };
}

/** A `RoomsApi` double reporting whichever rooms a test wants to be live. */
function roomsApi(rooms: RoomSnapshot[], participants: ParticipantSnapshot[] = []): RoomsApi {
  return {
    listRooms: async () => rooms,
    listParticipants: async () => participants,
  };
}

/** A live browser call: a cockpit room with a real human still in it. */
function liveCall(): RoomsApi {
  return roomsApi(
    [
      {
        name: 'cockpit-Ab3xQ9zK2mNp7RtY',
        numParticipants: 2,
        creationTime: BigInt(Math.floor(Date.now() / 1000)),
      },
    ],
    [{ identity: 'visitor-abc123', kind: 0 }],
  );
}

/** Nobody on a call: LiveKit answers, and answers empty. */
function noCalls(): RoomsApi {
  return roomsApi([]);
}

beforeEach(() => {
  // The live-call check reads /api/active's memo, so a snapshot left by a previous
  // test would decide this one.
  resetActiveCache();
  sdk.constructed.length = 0;
  sdk.created.length = 0;
  sdk.deleted.length = 0;
  sdk.listed.length = 0;
  sdk.participants.length = 0;
});

afterEach(() => {
  resetActiveCache();
});

describe('warm-up room names', () => {
  it('carries the prefix the agent matches on', () => {
    expect(warmupRoomName().startsWith(WARMUP_ROOM_PREFIX)).toBe(true);
  });

  it('is unpredictable, so overlapping pings cannot collide', () => {
    const names = new Set(Array.from({ length: 50 }, warmupRoomName));
    expect(names.size).toBe(50);
  });

  it('matches the constant the Python agent exports', () => {
    // agent/agent.py: WARMUP_ROOM_PREFIX = "warmup-". The two halves agree on this
    // string or the ping is served as a real call, with a full metered session.
    expect(WARMUP_ROOM_PREFIX).toBe('warmup-');
  });
});

describe('runWarmup', () => {
  it('creates a warm-up room and then deletes it', async () => {
    const api = recordingApi();
    const outcome = await runWarmup(env, { warmup: api, rooms: noCalls() });

    expect(outcome).toBe('pinged');
    expect(api.created).toHaveLength(1);
    expect(api.created[0].startsWith(WARMUP_ROOM_PREFIX)).toBe(true);
    expect(api.deleted).toEqual(api.created);
  });

  it('deletes the room it actually created', async () => {
    // A delete of some other name would leave the room to expire and read as success.
    const api = recordingApi();
    await runWarmup(env, { warmup: api, rooms: noCalls() });
    expect(api.deleted[0]).toBe(api.created[0]);
  });

  it('skips entirely when a real call is in progress', async () => {
    const api = recordingApi();
    const outcome = await runWarmup(env, { warmup: api, rooms: liveCall() });

    expect(outcome).toBe('skipped-live-call');
    expect(api.created).toEqual([]);
    expect(api.deleted).toEqual([]);
  });

  it('pings anyway when the live-call check is degraded', async () => {
    /*
     * The asymmetry argued for in warmup.ts, pinned so it cannot be "tidied" into
     * treating unknown as busy. A needless ping costs one job the agent rejects in
     * milliseconds; a needless skip costs the next caller twelve seconds of ringing —
     * and a degraded room listing is exactly when a cold container is most likely.
     */
    const api = recordingApi();
    const failing: RoomsApi = {
      listRooms: async () => {
        throw new Error('livekit is unhappy');
      },
      listParticipants: async () => [],
    };

    const outcome = await runWarmup(env, { warmup: api, rooms: failing });

    expect(outcome).toBe('pinged');
    expect(api.created).toHaveLength(1);
  });

  it('does not count an observer-only room as a live call', async () => {
    /*
     * Inherited from /api/active's caller rules, and worth pinning: a room held open
     * by a watcher after the caller hung up means nobody is talking to the agent, so
     * nothing is keeping it warm and the ping should fire.
     */
    const api = recordingApi();
    const observed = roomsApi(
      [
        {
          name: 'cockpit-Ab3xQ9zK2mNp7RtY',
          numParticipants: 1,
          creationTime: BigInt(Math.floor(Date.now() / 1000)),
        },
      ],
      [{ identity: 'observer-xyz789', kind: 0 }],
    );

    expect(await runWarmup(env, { warmup: api, rooms: observed })).toBe('pinged');
  });

  it('swallows a failed createRoom', async () => {
    const api = recordingApi({
      createRoom: async () => {
        throw new Error('livekit said no');
      },
    });

    const outcome = await runWarmup(env, { warmup: api, rooms: noCalls() });

    expect(outcome).toBe('create-failed');
    // Nothing was created, so nothing is deleted — a delete of a room that does not
    // exist is a second failure to report about a ping that already did not happen.
    expect(api.deleted).toEqual([]);
  });

  it('swallows a failed deleteRoom, having already done its job', async () => {
    const api = recordingApi({
      deleteRoom: async () => {
        throw new Error('livekit said no');
      },
    });

    const outcome = await runWarmup(env, { warmup: api, rooms: noCalls() });

    // The room was created, so the container was woken: the ping worked and only the
    // cleanup failed. The one-second empty timeout collects it.
    expect(outcome).toBe('delete-failed');
    expect(api.created).toHaveLength(1);
  });

  it('never rejects, whatever the API does', async () => {
    const exploding = recordingApi({
      createRoom: async () => {
        throw new Error('boom');
      },
      deleteRoom: async () => {
        throw new Error('boom');
      },
    });

    await expect(runWarmup(env, { warmup: exploding, rooms: noCalls() })).resolves.toBeDefined();
  });

  it('answers no-credentials rather than constructing a client that could only fail', async () => {
    const outcome = await runWarmup({} as unknown as Env, { rooms: noCalls() });

    expect(outcome).toBe('no-credentials');
    expect(sdk.constructed).toEqual([]);
  });

  it('asks for the shortest room lifetime the API allows', async () => {
    // Through the real factory this time, so the CreateOptions actually sent are the
    // thing under test. One second, not zero: zero means "use the server default".
    await runWarmup(env, { rooms: noCalls() });

    expect(sdk.created).toHaveLength(1);
    expect(sdk.created[0].emptyTimeout).toBe(WARMUP_ROOM_TIMEOUT_SECONDS);
    expect(sdk.created[0].departureTimeout).toBe(WARMUP_ROOM_TIMEOUT_SECONDS);
    expect(WARMUP_ROOM_TIMEOUT_SECONDS).toBeGreaterThan(0);
  });
});

describe('the scheduled handler', () => {
  const controller = { cron: '*/10 6-21 * * *', scheduledTime: Date.now() } as ScheduledController;

  it('runs a ping', async () => {
    resetActiveCache();
    await worker.scheduled?.(controller, env, {} as ExecutionContext);

    expect(sdk.created).toHaveLength(1);
    expect(sdk.created[0].name.startsWith(WARMUP_ROOM_PREFIX)).toBe(true);
    expect(sdk.deleted).toEqual([sdk.created[0].name]);
  });

  it('never throws out of the cron invocation', async () => {
    // No credentials, so the ping cannot even start. A rejected `scheduled` is a failed
    // cron run, and a cron that reports failures is a cron somebody turns off.
    await expect(
      worker.scheduled?.(controller, {} as unknown as Env, {} as ExecutionContext),
    ).resolves.toBeUndefined();
  });
});

/*
 * Everything below is the invisibility promise. None of it tests warmup.ts — it tests
 * that the rest of the system refuses to acknowledge a warm-up room exists.
 */
describe('a warm-up room is invisible', () => {
  const name = 'warmup-0123456789abcdef';

  it('is not classified as an entry type, so /api/active cannot list it', () => {
    /*
     * The single check the whole invisibility property rests on. `collectActiveRooms`
     * filters on `classifyEntry(room.name) !== null` before anything else happens, so a
     * null here means a warm-up room is dropped before it can be counted, hashed into a
     * `room_id`, or resolved back into a name.
     */
    expect(classifyEntry(name)).toBeNull();
  });

  it('is filtered out of /api/active even with a caller in it', async () => {
    /*
     * Belt to the braces above, through the real endpoint: a warm-up room reported by
     * LiveKit alongside a genuine call must leave the genuine call alone in the list.
     * Constructed with participants, because a room with nobody in it would be dropped
     * by the caller-count rule and would prove nothing about the name.
     */
    const created = Math.floor(Date.now() / 1000);
    const api = roomsApi(
      [
        { name, numParticipants: 2, creationTime: BigInt(created) },
        { name: 'cockpit-Ab3xQ9zK2mNp7RtY', numParticipants: 2, creationTime: BigInt(created) },
      ],
      [{ identity: 'visitor-abc123', kind: 0 }],
    );

    const { handleActiveGet } = await import('./active');
    resetActiveCache();
    const body = (await (await handleActiveGet(env, api)).json()) as {
      rooms: { entry: string }[];
    };

    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].entry).toBe('browser');
  });

  it('is refused an observer token', async () => {
    /*
     * The observer path takes a raw room name as well as a hashed id, and a warm-up name
     * must fail the grammar rather than merely fail the liveness check — a ping is briefly
     * live by construction, so grammar is the guarantee that holds during that window.
     */
    resetActiveCache();
    const response = await worker.fetch(
      new Request('https://cockpit.example/api/token', {
        method: 'POST',
        body: JSON.stringify({ observe: name }),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not an observable room' });
  });

  it('is refused an observer token while it is genuinely live', async () => {
    /*
     * The refusal that actually proves something, and the reason the mock's room list is
     * configurable at all.
     *
     * The previous assertion could have passed simply because the room did not exist —
     * every unknown name is a 403. Here the warm-up room IS in LiveKit's listing, with a
     * caller-shaped participant in it, which is the state a ping briefly occupies between
     * `createRoom` and `deleteRoom`. It is still refused, because `OBSERVABLE_ROOM` is
     * checked before liveness: grammar is what protects that window, and liveness alone
     * would not.
     */
    const name = warmupRoomName();
    sdk.listed.push({
      name,
      numParticipants: 1,
      creationTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    sdk.participants.push({ identity: 'visitor-abc123', kind: 0 });
    resetActiveCache();

    const response = await worker.fetch(
      new Request('https://cockpit.example/api/token', {
        method: 'POST',
        body: JSON.stringify({ observe: name }),
      }),
      env,
    );

    expect(response.status).toBe(403);

    // And it is not merely unobservable — it was never listed as a call in the first
    // place, so `isLiveRoom` could not have found it even if the grammar had let it by.
    const { isLiveRoom } = await import('./active');
    expect(await isLiveRoom(env, name)).toBe(false);
  });

  it('produces no debrief, so it never reaches /api/metrics', () => {
    /*
     * Asserted as a chain of facts rather than by driving the agent, which is Python and
     * not reachable from here. The agent rejects a `warmup-` job at request time and, if
     * one lands anyway, shuts down before the DebriefUploader is constructed
     * (agent/tests/test_warmup.py). No debrief is posted, so no KV record is written, and
     * /api/metrics aggregates stored debriefs and nothing else. What this test can pin is
     * the link in that chain that lives in this repo half: the name never classifies as a
     * call, so nothing downstream of a room listing will ever treat it as one.
     */
    expect(classifyEntry(name)).toBeNull();
    expect(classifyEntry('warmup-')).toBeNull();
  });

  it('does not become visible by containing a known prefix', () => {
    // A name is only a warm-up if the prefix LEADS. These are ordinary rooms and must
    // stay ordinary — a warm-up check that matched by substring would hide real calls.
    expect(classifyEntry('cockpit-warmup-abc')).toBe('browser');
    expect(classifyEntry('sip-cockpit-warmup-abc')).toBe('sip');
  });
});

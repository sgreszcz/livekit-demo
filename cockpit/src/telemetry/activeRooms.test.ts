/**
 * `/api/active` is the one payload that decides what a stranger is invited to
 * join, so it gets the same treatment as an envelope off the data channel: it is
 * assumed to be wrong until each field says otherwise.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchActiveRooms,
  isObservableRoom,
  parseActiveResponse,
  roomElapsedSeconds,
  type ActiveSnapshot,
} from './activeRooms';

/** A response shaped exactly as the Worker documents it. */
const PAYLOAD = {
  rooms: [
    { room: 'sip-cockpit-abc123', entry: 'sip', num_participants: 2, created_at: 1723000000 },
    { room: 'cockpit-demo01', entry: 'browser', num_participants: 2, created_at: 1723000030 },
  ],
  generated_at: 1723000042.5,
  degraded: false,
};

const FETCHED_AT_MS = 1_700_000_000_000;

function parsed(overrides: Record<string, unknown> = {}): ActiveSnapshot | null {
  return parseActiveResponse({ ...PAYLOAD, ...overrides }, FETCHED_AT_MS);
}

describe('parseActiveResponse', () => {
  /*
   * The valid-room cap cannot bound this on its own: it counts rooms that
   * PASSED validation, so a payload where everything fails is walked end to end.
   * A corrupt or hostile response should cost a wasted parse, not a frozen tab.
   */
  it('stops walking a payload long before a hostile one can freeze the page', () => {
    const snapshot = parseActiveResponse(
      {
        rooms: Array.from({ length: 100_000 }, () => ({ room: 'not-a-cockpit-room' })),
        generated_at: 1723000042.5,
        degraded: false,
      },
      FETCHED_AT_MS,
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot!.rooms).toEqual([]);
  });

  it('keeps a valid room that follows a wall of malformed ones', () => {
    // The bound must not be so eager that it discards real data behind noise.
    const snapshot = parseActiveResponse(
      {
        rooms: [
          ...Array.from({ length: 20 }, () => ({ room: 'lobby' })),
          { room: 'cockpit-real', entry: 'browser', num_participants: 1, created_at: 1723000000 },
        ],
        generated_at: 1723000042.5,
        degraded: false,
      },
      FETCHED_AT_MS,
    );

    expect(snapshot!.rooms.map((entry) => entry.room)).toEqual(['cockpit-real']);
  });

  it('reads the documented payload into camel-cased rooms', () => {
    const snapshot = parsed();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.generatedAt).toBe(1723000042.5);
    expect(snapshot!.degraded).toBe(false);
    expect(snapshot!.fetchedAtMs).toBe(FETCHED_AT_MS);
    expect(snapshot!.rooms).toEqual([
      { room: 'sip-cockpit-abc123', entry: 'sip', numParticipants: 2, createdAt: 1723000000 },
      { room: 'cockpit-demo01', entry: 'browser', numParticipants: 2, createdAt: 1723000030 },
    ]);
  });

  it('drops a malformed room individually rather than losing the good ones', () => {
    // One live call must not be hidden because the server also reported a room
    // this build cannot make sense of.
    const snapshot = parsed({
      rooms: [
        null,
        'cockpit-demo01',
        { room: 'cockpit-nope' }, // no entry, no counts
        { room: 'cockpit-nope', entry: 'telepathy', num_participants: 1, created_at: 1 },
        { room: 42, entry: 'sip', num_participants: 1, created_at: 1 },
        { room: 'cockpit-nope', entry: 'sip', num_participants: '2', created_at: 1 },
        { room: 'cockpit-nope', entry: 'sip', num_participants: 2, created_at: Number.NaN },
        PAYLOAD.rooms[0],
      ],
    });

    expect(snapshot!.rooms.map((room) => room.room)).toEqual(['sip-cockpit-abc123']);
  });

  it('drops a room name the Worker would answer 403 for', () => {
    // Dropped here, so a name that cannot be observed never reaches /api/token.
    const snapshot = parsed({
      rooms: [
        { room: 'lobby', entry: 'sip', num_participants: 1, created_at: 1 },
        { room: 'cockpit-a b', entry: 'sip', num_participants: 1, created_at: 1 },
        { room: `cockpit-${'a'.repeat(61)}`, entry: 'sip', num_participants: 1, created_at: 1 },
        PAYLOAD.rooms[1],
      ],
    });

    expect(snapshot!.rooms.map((room) => room.room)).toEqual(['cockpit-demo01']);
  });

  it('rejects a payload whose own fields are the wrong type', () => {
    expect(parsed({ rooms: 'none' })).toBeNull();
    expect(parsed({ generated_at: '1723000042' })).toBeNull();
    expect(parsed({ generated_at: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parsed({ degraded: 'false' })).toBeNull();
  });

  it('rejects a body that is not an object at all', () => {
    for (const body of [null, undefined, 'ok', 42, [], true]) {
      expect(parseActiveResponse(body, FETCHED_AT_MS)).toBeNull();
    }
  });

  it('accepts a degraded response with no rooms in it', () => {
    // The Worker answers 200 with `degraded: true` when it cannot reach LiveKit;
    // that is an empty list, not a broken payload.
    const snapshot = parseActiveResponse({ rooms: [], generated_at: 1, degraded: true }, 0);
    expect(snapshot).toEqual({ rooms: [], generatedAt: 1, degraded: true, fetchedAtMs: 0 });
  });
});

describe('isObservableRoom', () => {
  it('accepts the two room shapes the agent creates', () => {
    expect(isObservableRoom('cockpit-demo01')).toBe(true);
    expect(isObservableRoom('sip-cockpit-abc123')).toBe(true);
    expect(isObservableRoom('cockpit-a')).toBe(true);
  });

  it('refuses anything else, including the empty suffix and a path traversal', () => {
    for (const name of ['', 'cockpit-', 'sip-cockpit-', 'lobby', '../cockpit-x', 'cockpit-x/y']) {
      expect(isObservableRoom(name)).toBe(false);
    }
  });
});

describe('roomElapsedSeconds', () => {
  const snapshot = parsed()!;
  const room = snapshot.rooms[0]; // created 42.5 s before the snapshot was generated

  it('measures the call from the server clock, not this browser’s', () => {
    // The one that matters: a browser five minutes fast still reports 45.5 s,
    // because only the local *interval* since the response landed is measured
    // locally — the call's age came from the server.
    const onTime = roomElapsedSeconds(room, snapshot, FETCHED_AT_MS + 3000);
    expect(onTime).toBeCloseTo(45.5, 6);

    const fiveMinutesFast: ActiveSnapshot = { ...snapshot, fetchedAtMs: FETCHED_AT_MS + 300_000 };
    expect(roomElapsedSeconds(room, fiveMinutesFast, FETCHED_AT_MS + 303_000)).toBeCloseTo(45.5, 6);
  });

  it('advances with local time between polls', () => {
    expect(roomElapsedSeconds(room, snapshot, FETCHED_AT_MS)).toBeCloseTo(42.5, 6);
    expect(roomElapsedSeconds(room, snapshot, FETCHED_AT_MS + 5000)).toBeCloseTo(47.5, 6);
  });

  it('clamps at zero rather than printing a negative duration', () => {
    const future = { ...room, createdAt: snapshot.generatedAt + 60 };
    expect(roomElapsedSeconds(future, snapshot, FETCHED_AT_MS)).toBe(0);
    // A clock that stepped backwards between renders is the same problem.
    expect(roomElapsedSeconds(room, snapshot, FETCHED_AT_MS - 999_999_999)).toBe(0);
  });

  it('never returns NaN, whatever it is handed', () => {
    // Unknown rather than zero: "0.0s elapsed" asserts the call just started,
    // which is a claim, and the input that produced it supports no claim at all.
    expect(roomElapsedSeconds(room, snapshot, Number.NaN)).toBeNull();
  });

  /*
   * The seam between the two halves of this feature. The Worker maps a room
   * LiveKit gave it no creation time for to `created_at: 0` — a sentinel, not a
   * timestamp — and reads anything unparseable the same way, so a future SDK
   * rename would zero every room at once. Read literally, 0 is midnight 1970 and
   * the hero would advertise a call that had been running for 55 years.
   */
  it('reports an unknown age as unknown rather than as 1970', () => {
    const unstamped = { ...room, createdAt: 0 };
    expect(roomElapsedSeconds(unstamped, snapshot, FETCHED_AT_MS)).toBeNull();
  });

  it('treats a negative creation time as unknown too', () => {
    expect(roomElapsedSeconds({ ...room, createdAt: -1 }, snapshot, FETCHED_AT_MS)).toBeNull();
  });

  /*
   * The failure this guards is a unit mismatch, not a long call: a
   * `generated_at` sent in milliseconds against a `created_at` in seconds is
   * finite, positive, and passes every other check on its way to the card.
   */
  it('calls an implausible age unknown rather than rendering it', () => {
    const millisecondsByMistake: ActiveSnapshot = {
      ...snapshot,
      generatedAt: snapshot.generatedAt * 1000,
    };
    expect(roomElapsedSeconds(room, millisecondsByMistake, FETCHED_AT_MS)).toBeNull();
  });

  it('still measures a genuinely long call', () => {
    // The ceiling must not clip a real one: an hour in is unusual, not absurd.
    const anHourIn: ActiveSnapshot = { ...snapshot, generatedAt: room.createdAt + 3600 };
    expect(roomElapsedSeconds(room, anHourIn, FETCHED_AT_MS)).toBeCloseTo(3600, 6);
  });
});

describe('fetchActiveRooms', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stub = (response: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

  it('returns a snapshot for a good response', async () => {
    stub({ ok: true, json: async () => PAYLOAD });
    const snapshot = await fetchActiveRooms();
    expect(snapshot!.rooms).toHaveLength(2);
  });

  /*
   * The poller suppresses overlapping fetches, so a request that never settles
   * pins its in-flight flag and quietly retires the hero's room list for the
   * rest of the visit. The timeout is what turns that into one lost poll.
   */
  it('gives the request a deadline so a dead socket cannot retire the poller', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD });
    vi.stubGlobal('fetch', fetchMock);

    await fetchActiveRooms();

    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal } | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it('returns null rather than throwing when the Worker answers an error', async () => {
    stub({ ok: false, status: 500, json: async () => ({}) });
    await expect(fetchActiveRooms()).resolves.toBeNull();
  });

  it('returns null for a body that is not JSON', async () => {
    stub({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });
    await expect(fetchActiveRooms()).resolves.toBeNull();
  });

  it('returns null when the network is simply gone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchActiveRooms()).resolves.toBeNull();
  });
});

/**
 * SIP dispatch embeds the caller's number in the room name, so this shape is
 * the one that matters most and the one a stricter pattern would silently drop.
 *
 * The number is from Ofcom's drama range (07700 900xxx), which is reserved so
 * that it can never route to a real subscriber. That is not fastidiousness: a
 * room name is a caller's phone number, this file is a git object forever, and a
 * fixture taken from a real call would publish somebody's mobile in a public
 * repository. Anything that needs a phone number here comes from that range.
 */
const DRAMA_SIP_ROOM = 'sip-cockpit-_+447700900123_5xzppVvwo6Px';

it('accepts a real SIP room name — caller number embedded with _ and +', () => {
  const snapshot = parseActiveResponse(
    {
      rooms: [
        {
          room: DRAMA_SIP_ROOM,
          entry: 'sip',
          num_participants: 2,
          created_at: 1786098222,
        },
      ],
      degraded: false,
      generated_at: 1786098358,
    },
    1786098358_000,
  );
  expect(snapshot?.rooms).toHaveLength(1);
  expect(isObservableRoom(DRAMA_SIP_ROOM)).toBe(true);
});

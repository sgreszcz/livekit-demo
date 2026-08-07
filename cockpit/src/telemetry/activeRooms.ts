/**
 * The air-traffic view: which calls are on the agent right now.
 *
 * `GET /api/active` is answered by the Worker from the LiveKit server API, and
 * it is no more trusted than a stored debrief or a data-channel frame — it is
 * shaped by whatever the server returned, and one wrong field must not blank the
 * hero. So it is validated the way `schema.ts` validates envelopes: field by
 * field at the single ingest point, dropping bad rooms individually rather than
 * rejecting a payload whose other rooms were perfectly good.
 */

export interface ActiveRoom {
  room: string;
  entry: 'sip' | 'browser';
  numParticipants: number;
  createdAt: number;
}

export interface ActiveSnapshot {
  rooms: ActiveRoom[];
  /** Unix seconds on the SERVER clock — the anchor for every elapsed figure. */
  generatedAt: number;
  degraded: boolean;
  /** `Date.now()` when this response landed, in local time. */
  fetchedAtMs: number;
}

/**
 * The same gate the Worker applies before minting an observer token, mirrored
 * here. Not defence in depth for its own sake: a room name that fails this is
 * one the Worker will answer 403 for, so a card offering to watch it is a button
 * that cannot work. Dropping it at parse time means a bad name can never reach
 * `/api/token` at all.
 */
const OBSERVABLE_ROOM = /^(sip-)?cockpit-[A-Za-z0-9-]{1,40}$/;

export function isObservableRoom(name: string): boolean {
  return typeof name === 'string' && OBSERVABLE_ROOM.test(name);
}

/**
 * A ceiling on how many cards one response can put on the page. The list is
 * rendered above the hero, so an unbounded one is an unbounded amount of DOM in
 * the first thing a visitor sees. No demo runs twenty concurrent calls.
 */
const MAX_ACTIVE_ROOMS = 20;

/**
 * Long enough to ride out a slow mobile round trip, short enough that a dead
 * socket costs one poll rather than the rest of the session.
 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * `AbortSignal.timeout` is well supported but not universal, and a browser
 * without it should still get a room list — an un-timed fetch is what this code
 * did before, so its absence is a missing improvement, not a broken page.
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * A ceiling on how much of a hostile or corrupt payload is walked. The valid
 * rooms are capped separately below; this bounds the *candidates*, so an array
 * of a million malformed entries cannot freeze the main thread on the way to
 * discovering that none of them were usable.
 */
const MAX_ROOM_CANDIDATES = 200;

/**
 * Past this, an "elapsed" figure is evidence of a bug rather than of a long
 * call. A voice demo does not run for a day, and the token that joins one
 * expires in fifteen minutes.
 */
const MAX_PLAUSIBLE_CALL_SECONDS = 24 * 60 * 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** NaN and Infinity are rejected here for the same reason as in `schema.ts`. */
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isCount = (value: unknown): value is number =>
  isNumber(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

function parseRoom(value: unknown): ActiveRoom | null {
  if (!isRecord(value)) return null;
  if (typeof value.room !== 'string' || !isObservableRoom(value.room)) return null;
  if (value.entry !== 'sip' && value.entry !== 'browser') return null;
  if (!isCount(value.num_participants)) return null;
  if (!isCount(value.created_at)) return null;

  return {
    room: value.room,
    entry: value.entry,
    numParticipants: value.num_participants,
    createdAt: value.created_at,
  };
}

/**
 * Returns null only when the envelope itself is unusable — a non-object body, a
 * missing room list, a `generated_at` that is not a clock reading. Without those
 * there is nothing to anchor elapsed time against, and a list of rooms with no
 * honest age is worse than no list.
 */
export function parseActiveResponse(value: unknown, fetchedAtMs: number): ActiveSnapshot | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.rooms)) return null;
  if (!isNumber(value.generated_at)) return null;
  if (typeof value.degraded !== 'boolean') return null;
  if (!isNumber(fetchedAtMs)) return null;

  const rooms: ActiveRoom[] = [];
  for (const candidate of value.rooms.slice(0, MAX_ROOM_CANDIDATES)) {
    const room = parseRoom(candidate);
    if (room !== null) rooms.push(room);
    if (rooms.length === MAX_ACTIVE_ROOMS) break;
  }

  return { rooms, generatedAt: value.generated_at, degraded: value.degraded, fetchedAtMs };
}

/**
 * How long the call has been running, anchored to the SERVER's clock.
 *
 * The tempting version — `Date.now()/1000 - room.createdAt` — subtracts two
 * readings taken on different clocks, and a browser five minutes fast reports
 * every call as five minutes old. So the server's own measurement of the call's
 * age (`generatedAt - createdAt`, both server-side) is taken whole, and only the
 * time since the response landed is measured locally. That second term is a
 * local *interval*, which is the one thing this machine can measure correctly
 * however wrong its wall clock is.
 *
 * Null means "this call's age is not known", which is a different statement from
 * zero and must not be rendered as one.
 */
export function roomElapsedSeconds(
  room: ActiveRoom,
  snapshot: ActiveSnapshot,
  nowMs: number,
): number | null {
  /*
   * The Worker encodes "LiveKit did not report a creation time" as 0 rather than
   * dropping the room — a call you can watch is worth listing even when its age
   * is unknown. Read literally, that 0 is midnight 1970, and the subtraction
   * below would put "29166666m 40s elapsed" on the hero.
   *
   * This is not a hypothetical off-by-one. The Worker maps *anything*
   * unreadable to 0, so a future SDK that renames `creationTime` (there is
   * already a `creationTimeMs` beside it) would silently zero every room at
   * once, and the failure would land on the marketing page rather than in a log.
   */
  if (!(room.createdAt > 0)) return null;

  const serverAge = snapshot.generatedAt - room.createdAt;
  const sinceFetch = (nowMs - snapshot.fetchedAtMs) / 1000;
  const elapsed = serverAge + sinceFetch;
  if (!Number.isFinite(elapsed)) return null;

  /*
   * An age this large is not a long call, it is a unit mismatch — a
   * `generated_at` handed over in milliseconds while `created_at` is in seconds
   * produces a figure that is perfectly finite, sails past every guard above,
   * and renders as a five-figure minute count that shoulders the card's layout
   * apart. Beyond a plausible call length the honest answer is that the age is
   * not known.
   */
  if (elapsed > MAX_PLAUSIBLE_CALL_SECONDS) return null;

  // A clock that stepped backwards, or a room created after the snapshot was
  // generated, must read zero rather than print a negative duration.
  return Math.max(0, elapsed);
}

/**
 * Null on anything that went wrong — offline, 500, a body that is not JSON, a
 * payload that does not validate. The caller polls this every few seconds on the
 * hero, so a failure is a temporary absence of information, never an error worth
 * putting in front of a visitor who did not ask for anything.
 */
export async function fetchActiveRooms(): Promise<ActiveSnapshot | null> {
  try {
    /*
     * The timeout is not politeness, it is what keeps the poller alive.
     *
     * `createActivePoller` suppresses overlapping fetches, so a request that
     * never settles holds the in-flight flag forever and every subsequent tick
     * becomes a no-op: the hero silently stops discovering calls for the rest of
     * the visit, with no error and nothing in the console. A hung socket is
     * ordinary on mobile networks, so this is a matter of when, not whether.
     */
    const response = await fetch('/api/active', { signal: timeoutSignal(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    // Stamped once the response is in hand: `roomElapsedSeconds` measures
    // forward from this instant, so it must be the instant the figures were true.
    return parseActiveResponse(body, Date.now());
  } catch {
    return null;
  }
}

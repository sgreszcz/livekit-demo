/**
 * Live calls, as LiveKit currently sees them.
 *
 * The hero polls this endpoint so a visitor can watch a call that is already in
 * progress instead of staring at an empty stage. That framing drives three
 * decisions that would otherwise look over-careful:
 *
 *  * **It never fails.** A polled endpoint that 5xxes turns one LiveKit hiccup
 *    into a broken-looking front page. Every failure path answers 200 with
 *    `degraded: true` and whatever rooms did survive, and the consumer decides
 *    how loudly to say so.
 *  * **It never fans out far.** Room listing is one call, but participants are
 *    one call *per room*, so an unbounded room list would multiply every poll by
 *    however many rooms the project happens to be holding open. The candidate
 *    list is capped before any per-room work starts.
 *  * **It collapses bursts.** The memo below holds the in-flight promise, not
 *    just the settled body, so ten browsers polling in the same second produce
 *    one LiveKit round trip rather than ten.
 *
 * All the logic lives over the `RoomsApi` port rather than over the SDK, so the
 * filtering and counting rules are testable without a network or a fake Twirp
 * server. The SDK only appears in the small factory at the bottom.
 */

import { RoomServiceClient } from 'livekit-server-sdk';
import type { Env } from './env';
import { json } from './http';

/**
 * Candidate rooms kept per poll, newest first. Each one costs a `listParticipants`
 * round trip, and the hero shows a handful at most — a project with fifty stale
 * rooms open must not turn one poll into fifty API calls.
 */
export const MAX_CANDIDATE_ROOMS = 10;

/** Isolate memo lifetime, matching the cache-control max-age on the response. */
export const CACHE_TTL_MS = 4_000;

/** Identity prefix minted by the observer path in token.ts. */
const OBSERVER_PREFIX = 'observer-';

/** Room name prefixes, most specific first — see `classifyEntry`. */
const SIP_PREFIX = 'sip-cockpit-';
const BROWSER_PREFIX = 'cockpit-';

/**
 * The slice of a LiveKit `Room` this module reads. A real `Room` satisfies it
 * structurally, so the factory below needs no cast; `creationTime` is an int64
 * and therefore a bigint from the SDK, but a number is accepted so a test does
 * not have to write `123n` everywhere.
 */
export interface RoomSnapshot {
  name: string;
  numParticipants: number;
  creationTime: bigint | number;
}

/** The only two LiveKit calls this endpoint makes. */
export interface RoomsApi {
  listRooms(): Promise<RoomSnapshot[]>;
  listParticipants(room: string): Promise<{ identity: string }[]>;
}

export interface ActiveRoom {
  room: string;
  entry: 'sip' | 'browser';
  /**
   * Humans on the call, NOT `Room.numParticipants`. Observers minted by
   * /api/token are subscribers watching this very list, so counting them would
   * make a call look busier every time somebody opened the page.
   */
  num_participants: number;
  /** Unix seconds. */
  created_at: number;
}

export interface ActiveRoomsBody {
  rooms: ActiveRoom[];
  generated_at: number;
  degraded: boolean;
}

/**
 * Which door the call came in by, or null for a room this demo did not create.
 *
 * The sip test must come first: `sip-cockpit-x` also fails to start with
 * `cockpit-`, but a future prefix that merely contains it would be silently
 * mislabelled if this were reordered.
 */
export function classifyEntry(name: string): 'sip' | 'browser' | null {
  if (name.startsWith(SIP_PREFIX)) return 'sip';
  if (name.startsWith(BROWSER_PREFIX)) return 'browser';
  return null;
}

/**
 * `creation_time` as unix seconds.
 *
 * A missing or zero value is real — LiveKit reports it for a room that exists
 * only as a reservation — and `Number(undefined)` from a hand-rolled fake is
 * NaN, which poisons a comparator and would scramble the whole ordering. Both
 * degrade to 0, which sorts such a room last instead of pretending it is new.
 */
function createdAt(room: RoomSnapshot): number {
  const seconds = Number(room.creationTime);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * Everything /api/active knows how to do, over the port.
 *
 * Returns `degraded` rather than throwing, and callers are expected to serve
 * whatever `rooms` comes back with: a partial list of live calls is far more
 * useful to the hero than an error.
 */
export async function collectActiveRooms(
  api: RoomsApi,
): Promise<{ rooms: ActiveRoom[]; degraded: boolean }> {
  let listed: RoomSnapshot[];
  try {
    listed = await api.listRooms();
  } catch {
    // No room list means no picture at all — there is nothing partial to serve.
    return { rooms: [], degraded: true };
  }

  // Filter, then sort, then cap: the cap has to land on the newest *candidates*,
  // not on the newest rooms in the project, or a burst of unrelated rooms would
  // push every cockpit call out of the window.
  const named = listed
    .filter((room) => classifyEntry(room.name) !== null)
    .map((room) => ({
      name: room.name,
      entry: classifyEntry(room.name) as 'sip' | 'browser',
      created_at: createdAt(room),
    }))
    .sort((a, b) => b.created_at - a.created_at);

  const candidates = named.slice(0, MAX_CANDIDATE_ROOMS);

  /*
   * Truncation is a degraded answer, not a clean one.
   *
   * The cap is applied to rooms that merely *look* like ours, before anyone has
   * asked who is in them — it has to be, since finding out costs the round trip
   * the cap exists to limit. So ten stale or observer-only rooms can crowd out an
   * older eleventh room with real people on it, and without this flag the hero
   * would render a confident empty lobby over a call that is genuinely running.
   */
  let degraded = named.length > MAX_CANDIDATE_ROOMS;

  // Concurrently: these are independent round trips and the hero is waiting.
  // `allSettled` rather than `all` because one unlucky room must cost that room
  // and nothing else.
  const settled = await Promise.allSettled(
    candidates.map((candidate) => api.listParticipants(candidate.name)),
  );

  const rooms: ActiveRoom[] = [];

  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      degraded = true;
      return;
    }

    const candidate = candidates[index];
    const live = result.value.filter(
      (participant) => !participant.identity.startsWith(OBSERVER_PREFIX),
    ).length;

    // An observer-only room is the tail end of a call everyone has left, or a
    // room being watched after the fact. Either way there is nothing to listen
    // to, so it is not advertised as a live call.
    if (live < 1) return;

    rooms.push({
      room: candidate.name,
      entry: candidate.entry,
      num_participants: live,
      created_at: candidate.created_at,
    });
  });

  // Newest first, inherited from the candidate sort above — the array is only
  // ever filtered after that point, never reordered.
  return { rooms, degraded };
}

/**
 * wss:// → https://, ws:// → http://.
 *
 * `LIVEKIT_URL` is the signalling URL handed to browsers, but RoomServiceClient
 * speaks Twirp over plain HTTP against the same host, and hands the scheme
 * straight to `fetch`.
 *
 * Case-insensitive because URL schemes are: a `WSS://` in a config file is
 * valid, and would otherwise be passed to `fetch` unchanged, fail every request,
 * and present as a permanent LiveKit outage rather than as a typo.
 *
 * Known limitation: a host carrying a base path (`wss://x/base`) keeps it here,
 * but the SDK requests absolute `/twirp/...` paths and would drop it anyway.
 * LiveKit Cloud URLs have no base path, so this is noted rather than handled.
 */
export function apiHost(url: string): string {
  // The whole scheme is matched and rewritten, not just its first two letters:
  // replacing `^ws` in `WSS://host` leaves `httpS://host`, which is every bit as
  // broken as the input and considerably harder to spot.
  return url.replace(/^(wss?):\/\//i, (_match, scheme: string) =>
    scheme.length === 3 ? 'https://' : 'http://',
  );
}

/**
 * The real port. Returns null when the deployment has no LiveKit credentials,
 * so the caller can answer degraded instead of constructing a client that could
 * only fail — this endpoint has no way to ask the visitor to fix the config.
 */
function roomsApiFor(env: Env): RoomsApi | null {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) return null;

  /*
   * Both options exist because this endpoint is polled, and a poll that hangs is
   * worse than a poll that fails.
   *
   * The SDK defaults to a 10-second request timeout and, on a Cloud host, up to
   * three region attempts on a retryable error. `Promise.allSettled` below waits
   * for the slowest room, so the defaults put a worst case somewhere north of
   * thirty seconds on an endpoint the hero calls every five — the browser would
   * sit on an open request across several poll intervals. A degraded answer now
   * is strictly more useful here than a complete one after half a minute.
   */
  const client = new RoomServiceClient(
    apiHost(env.LIVEKIT_URL),
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
    { requestTimeout: 3, failover: false },
  );

  // Wrapped rather than returned directly: the port is two methods wide, and
  // narrowing it here is what keeps the SDK out of the logic above.
  return {
    listRooms: () => client.listRooms(),
    listParticipants: (room: string) => client.listParticipants(room),
  };
}

/** Build the response body. Never rejects — see the memo below for why. */
async function snapshot(env: Env, injected?: RoomsApi): Promise<ActiveRoomsBody> {
  let result: { rooms: ActiveRoom[]; degraded: boolean };
  try {
    const api = injected ?? roomsApiFor(env);
    result = api === null ? { rooms: [], degraded: true } : await collectActiveRooms(api);
  } catch {
    result = { rooms: [], degraded: true };
  }

  return { ...result, generated_at: Date.now() / 1000 };
}

let memo: { at: number; body: Promise<ActiveRoomsBody> } | null = null;

/**
 * Drop the isolate memo. Tests only — a Worker has no reason to call this.
 */
export function resetActiveCache(): void {
  memo = null;
}

/**
 * Memoized snapshot, holding the promise rather than the settled body.
 *
 * Holding the body would only deduplicate polls that arrive *after* a round trip
 * finishes; the burst this endpoint actually sees — several browsers polling on
 * the same four-second tick — all arrives while the first request is still in
 * flight, and would fan out. Stamping `at` before the call also means the TTL
 * covers the in-flight window, which is the point.
 *
 * Degraded results are cached for the same four seconds on purpose: a LiveKit
 * outage is exactly when hammering it is least helpful, and the front page
 * recovers one tick later than it strictly could.
 *
 * Honest scope note: this memo is per-isolate. Cloudflare runs many isolates,
 * so it is a damper on fan-out, not a global cache — the `cache-control` header
 * is what actually keeps the request count down at the edge.
 */
function cachedSnapshot(env: Env, injected?: RoomsApi): Promise<ActiveRoomsBody> {
  const now = Date.now();
  if (memo !== null && now - memo.at < CACHE_TTL_MS) return memo.body;

  // `snapshot` swallows its own failures, so this promise never rejects — a
  // rejected promise parked in the memo would be re-thrown to every poll for
  // the rest of the window, and turn one bad call into four seconds of 500s.
  const body = snapshot(env, injected);
  memo = { at: now, body };
  return body;
}

/**
 * GET /api/active. `api` is injected by tests so they never touch the network.
 */
export async function handleActiveGet(env: Env, api?: RoomsApi): Promise<Response> {
  return json(await cachedSnapshot(env, api), {
    headers: {
      /*
       * Matches CACHE_TTL_MS. `private` is explicit rather than implied:
       * omitting `public` does NOT keep a response out of a shared cache — a
       * plain `max-age` on an unauthenticated GET is freely shareable, and an
       * earlier version of this comment claimed otherwise. The body is the same
       * for every visitor, so a shared copy would leak nothing; it would simply
       * go stale, and a four-second-old list of live calls is the one thing this
       * endpoint exists to avoid serving.
       */
      'cache-control': 'private, max-age=4',
    },
  });
}

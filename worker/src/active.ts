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
 *  * **It never says a room's name.** SIP dispatch names a phone-call room after
 *    the caller's number, so the obvious field — `room: candidate.name` — was
 *    publishing strangers' phone numbers to every anonymous visitor on the front
 *    page. The public body now carries `room_id`, the opaque handle from
 *    rooms.ts; the real names stay inside this module, where `resolveRoomId`
 *    turns a handle back into the name LiveKit actually knows.
 *
 * All the logic lives over the `RoomsApi` port rather than over the SDK, so the
 * filtering and counting rules are testable without a network or a fake Twirp
 * server. The SDK only appears in the small factory at the bottom.
 */

import { RoomServiceClient } from 'livekit-server-sdk';
import type { Env } from './env';
import { json } from './http';
import { ROOM_ID, roomId } from './rooms';

/**
 * Candidate rooms kept per poll, newest first. Each one costs a `listParticipants`
 * round trip, and the hero shows a handful at most — a project with fifty stale
 * rooms open must not turn one poll into fifty API calls.
 */
export const MAX_CANDIDATE_ROOMS = 10;

/** Isolate memo lifetime, matching the cache-control max-age on the response. */
export const CACHE_TTL_MS = 4_000;

/**
 * How old a room may be and still be called a live call.
 *
 * From production: an agent redeploy mid-call orphaned a SIP room. The human had
 * hung up, but the agent process that outlived the deploy was still joined, so
 * the room stayed open — and listed — for 998 seconds, until somebody deleted it
 * by hand. Before room names were replaced by handles, that was sixteen minutes
 * of a stranger's phone number on the front page of a public demo.
 *
 * The participant rules below are the real fix and this is the backstop, because
 * both of them are reasoning about *who is in the room*, and the orphan case is
 * precisely the case where that reasoning is being fooled by something nobody
 * predicted. Half an hour is generous for a demo call that a visitor is expected
 * to hold in one browser tab; a room open longer than that is not a call anyone
 * is having.
 */
export const MAX_ROOM_AGE_SECONDS = 30 * 60;

/** Identity prefix minted by the observer path in token.ts. */
const OBSERVER_PREFIX = 'observer-';

/**
 * Identity prefix the LiveKit agents framework gives a dispatched worker.
 *
 * Only a fallback — `kind` is the authority, see `isCaller`. It exists because
 * `kind` is a field a fake can forget and an older server can omit, and the one
 * time this mattered in production the cost was a phone number on a public page
 * for sixteen minutes. A redundant string test is cheap next to that.
 */
const AGENT_PREFIX = 'agent-';

/**
 * The participant kinds a human caller can arrive as: `livekit.ParticipantInfo.Kind`
 * STANDARD (0), SIP (3) and CONNECTOR (7).
 *
 * An allow-list rather than "everything except AGENT", and the same three the
 * Python agent's own `CALLER_KINDS` uses — the two halves of this system must
 * agree about who counts as the caller, or the agent hangs up on a call the
 * front page is still advertising. It also means a kind added to the proto after
 * this was written (BRIDGE, EGRESS, whatever comes next) is excluded by default
 * rather than silently counted as a human.
 *
 * Inlined as numbers because `livekit-server-sdk` re-exports `ParticipantInfo`
 * but not its `Kind` enum, and reaching past it into `@livekit/protocol` would
 * add a dependency this Worker does not declare. The numbers are wire format —
 * they are as stable as the field itself — and `roomsApiFor` below would stop
 * compiling if the SDK's participant type ever stopped fitting the port.
 */
const CALLER_KINDS = new Set([0, 3, 7]);

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

/**
 * The slice of a LiveKit `ParticipantInfo` this module reads.
 *
 * `kind` is optional so a test fake can leave it out, not because the server
 * ever does. Note that STANDARD is 0, so a missing `kind` and a browser
 * participant are *not* distinguishable by truthiness — `isCaller` tests for
 * `undefined` explicitly, and a `kind ?? 0` default would have quietly counted
 * every agent as a human.
 */
export interface ParticipantSnapshot {
  identity: string;
  kind?: number;
}

/** The only two LiveKit calls this endpoint makes. */
export interface RoomsApi {
  listRooms(): Promise<RoomSnapshot[]>;
  listParticipants(room: string): Promise<ParticipantSnapshot[]>;
}

/**
 * A live call as this module knows it, name and all. Never serialized.
 *
 * The split between this and `ActiveRoom` is the whole fix: everything upstream
 * of the response needs the real name — `listParticipants` takes it, and the
 * observer flow has to hand it back to LiveKit as a room grant — while nothing
 * downstream of the response is allowed to see it. Keeping the two in one type
 * with a "don't serialize this field" comment is exactly the arrangement that
 * leaked in the first place, so they are two types.
 */
export interface LiveRoom {
  /** The real LiveKit room name. Server-side only — see the module note. */
  name: string;
  /** `roomId(name)`: the opaque handle clients are given instead. */
  room_id: string;
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

/**
 * A live call as a visitor is allowed to know it.
 *
 * `room_id` replaced `room` when it became clear the old field was publishing
 * caller phone numbers. It is deliberately not a name-shaped string: there is
 * nothing in it to render, so a consumer that wants a label has to invent one
 * rather than quietly reintroducing the leak by displaying what it was handed.
 */
export interface ActiveRoom {
  room_id: string;
  entry: 'sip' | 'browser';
  num_participants: number;
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
 * Is this participant the person the call is *with*?
 *
 * Three ways to be excluded, and each one is a room that has been observed
 * staying open with nobody to listen to:
 *
 *  * **Observers.** Watchers minted by token.ts, subscribed to this very list.
 *    Counting them makes a call look busier every time somebody opens the page,
 *    and keeps a finished call listed for as long as anyone is still watching
 *    it. They join as STANDARD, so no `kind` test can catch them — the prefix is
 *    the only signal, which is why token.ts treats it as a contract.
 *  * **Agents, by kind.** The authority, and the one that would have caught the
 *    998-second orphan: an agent that outlives its caller holds the room open,
 *    and a rule that counts it reports an empty room as a live call indefinitely.
 *  * **Agents, by identity prefix.** Redundant with the above wherever `kind`
 *    is populated, deliberately. See `AGENT_PREFIX`.
 *
 * A participant with no `kind` at all is given the benefit of the doubt, because
 * the alternative is a server that stops reporting one field emptying the front
 * page. The prefix rules still apply to it.
 */
function isCaller(participant: ParticipantSnapshot): boolean {
  const { identity, kind } = participant;
  if (identity.startsWith(OBSERVER_PREFIX) || identity.startsWith(AGENT_PREFIX)) return false;
  return kind === undefined || CALLER_KINDS.has(kind);
}

/**
 * A room too old to be a call anyone is having. See `MAX_ROOM_AGE_SECONDS`.
 *
 * An unknown creation time (0 — LiveKit reports it for a room that exists only
 * as a reservation) is exempt rather than treated as infinitely old. It has to
 * be: age is unknowable there, and guessing "stale" would hide live calls on any
 * deployment that stopped populating the field. It costs nothing, because a
 * reservation has no participants and is dropped by the caller count anyway.
 */
function isOrphanedByAge(created_at: number, now: number): boolean {
  return created_at > 0 && now - created_at > MAX_ROOM_AGE_SECONDS;
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
  now: number = Date.now() / 1000,
): Promise<{ rooms: LiveRoom[]; degraded: boolean }> {
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
  //
  // Age is filtered here, in the same breath as the name — before the sort and
  // therefore before the cap, so a shelf of orphaned rooms cannot crowd real
  // calls out of the candidate window. It deliberately does NOT set `degraded`:
  // an orphan is a room this endpoint has decided is not a call, the same as an
  // observer-only one, not a room it failed to look at.
  const named = listed
    .filter((room) => classifyEntry(room.name) !== null)
    .map((room) => ({
      name: room.name,
      entry: classifyEntry(room.name) as 'sip' | 'browser',
      created_at: createdAt(room),
    }))
    .filter((room) => !isOrphanedByAge(room.created_at, now))
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

  /*
   * Two passes rather than one, because hashing is async.
   *
   * `roomId` goes through WebCrypto and therefore returns a promise, which a
   * `forEach` body cannot wait on — pushing from inside an async callback would
   * return an array that is still empty when this function resolves. So the
   * synchronous pass decides *which* rooms survive and the awaited pass gives
   * each survivor its handle. Only the survivors are hashed: a room nobody may
   * see has no handle worth minting.
   */
  const survivors: Omit<LiveRoom, 'room_id'>[] = [];

  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      degraded = true;
      return;
    }

    const candidate = candidates[index];
    const live = result.value.filter(isCaller).length;

    // A room with no caller left in it is the tail end of a call everyone has
    // left: watched after the fact, or held open by an agent that outlived its
    // caller. Either way there is nothing to listen to, so it is not advertised
    // as a live call.
    if (live < 1) return;

    survivors.push({
      name: candidate.name,
      entry: candidate.entry,
      num_participants: live,
      created_at: candidate.created_at,
    });
  });

  // `Promise.all` keeps input order, so newest-first is inherited from the
  // candidate sort above — the array is only ever filtered and mapped after
  // that point, never reordered.
  const rooms = await Promise.all(
    survivors.map(async (survivor) => ({ ...survivor, room_id: await roomId(survivor.name) })),
  );

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

/**
 * What the memo holds: the poll's findings with the real names still attached.
 *
 * The memo used to cache the public body, which was fine when the public body
 * was the whole truth. It no longer is, and caching the redacted view would
 * force `resolveRoomId` to make its own `listRooms` round trip on every token
 * request — turning the one endpoint an attacker can call in a loop into an
 * un-damped amplifier of LiveKit traffic. So the memo keeps the internal
 * snapshot and the public body is derived from it per response, which costs a
 * map over at most ten rooms.
 */
interface InternalSnapshot {
  rooms: LiveRoom[];
  generated_at: number;
  degraded: boolean;
}

/** Build the internal snapshot. Never rejects — see the memo below for why. */
async function snapshot(env: Env, injected?: RoomsApi): Promise<InternalSnapshot> {
  /*
   * One clock reading for the whole snapshot, taken before the round trips
   * rather than after. `generated_at` and the staleness filter are two answers
   * to the same question — "as of when?" — and reading the clock twice lets a
   * slow LiveKit call sit between them, so a room could be reported at an age
   * the response's own timestamp contradicts.
   */
  const now = Date.now() / 1000;

  let result: { rooms: LiveRoom[]; degraded: boolean };
  try {
    const api = injected ?? roomsApiFor(env);
    result = api === null ? { rooms: [], degraded: true } : await collectActiveRooms(api, now);
  } catch {
    result = { rooms: [], degraded: true };
  }

  return { ...result, generated_at: now };
}

/**
 * The internal snapshot, minus the names. The one place the two views meet.
 *
 * Written as an explicit field list rather than a rest-destructure of `name`:
 * a spread would carry any field a future edit adds to `LiveRoom` straight into
 * the response, which is precisely the accident this whole change exists to
 * undo. Adding a field here should take a deliberate keystroke.
 */
function publicBody(internal: InternalSnapshot): ActiveRoomsBody {
  return {
    rooms: internal.rooms.map((room) => ({
      room_id: room.room_id,
      entry: room.entry,
      num_participants: room.num_participants,
      created_at: room.created_at,
    })),
    generated_at: internal.generated_at,
    degraded: internal.degraded,
  };
}

let memo: { at: number; body: Promise<InternalSnapshot> } | null = null;

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
function cachedSnapshot(env: Env, injected?: RoomsApi): Promise<InternalSnapshot> {
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
 * Turn an opaque handle back into the room name LiveKit knows, or null.
 *
 * Resolution happens against the rooms that are live *right now*, and that is a
 * security property rather than an implementation shortcut. The id is an
 * unkeyed hash of a name, so anyone holding a candidate phone number could
 * derive the matching id offline; what stops that from mattering is that an id
 * only means anything while the call is up. The handle is a pointer into the
 * current call list, not a durable identifier, and it stops resolving the moment
 * the call ends — which is the same guarantee token.ts has always given about a
 * room not being rejoinable once it drops off the list.
 *
 * A room that /api/active filters out — observer-only, or past the candidate cap
 * — is not in the snapshot and so does not resolve either. Watching is exactly
 * as available as listening was.
 *
 * The shape check comes first so a garbage `observe` value is refused without
 * costing a LiveKit round trip; a well-formed but stale id is indistinguishable
 * from garbage to the caller, because both answer null and the caller turns both
 * into the same 403.
 *
 * `api` is injected by tests, and reaches the same memo `handleActiveGet` uses:
 * a token request arriving inside the four-second window costs nothing at all.
 */
export async function resolveRoomId(env: Env, id: string, api?: RoomsApi): Promise<string | null> {
  if (!ROOM_ID.test(id)) return null;

  const internal = await cachedSnapshot(env, api);
  return internal.rooms.find((room) => room.room_id === id)?.name ?? null;
}

/**
 * Is this exact room name one of the calls currently advertised as live?
 *
 * The compatibility half of the observer flow, for cockpit builds that still
 * hold a raw room name. It answers the same question `resolveRoomId` does and
 * against the same list, so a name and an id are equally powerless once the
 * call has ended. Matching the room-name *grammar* is not a substitute: it
 * proves a string is shaped like one of ours, not that it names anything.
 */
export async function isLiveRoom(env: Env, name: string, api?: RoomsApi): Promise<boolean> {
  const internal = await cachedSnapshot(env, api);
  return internal.rooms.some((room) => room.name === name);
}

/**
 * GET /api/active. `api` is injected by tests so they never touch the network.
 */
export async function handleActiveGet(env: Env, api?: RoomsApi): Promise<Response> {
  return json(publicBody(await cachedSnapshot(env, api)), {
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

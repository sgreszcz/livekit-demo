/**
 * The one decision `/live` makes: given what the agent is doing right now, is
 * there a call this page should join, and which one.
 *
 * Split out as a pure function for the same reason `createActivePoller` is: the
 * suite runs without a DOM, and this is the part worth asserting. Every way the
 * page can get this wrong is a bad one — rejoining the call the visitor just
 * left, retrying a room that refused, joining a second call while already
 * watching one, or sitting silently on a snapshot that had a call in it.
 */

import type { ActiveSnapshot } from '../telemetry/activeRooms';
import type { CockpitMode } from '../useCockpit';

export interface AutoJoinInput {
  /** The cockpit's own state — anything but `idle` means hands off. */
  mode: CockpitMode;
  snapshot: ActiveSnapshot | null;
  /**
   * The room `/live?room=…` named, or null for a bare `/live`.
   *
   * This is a ONE-SHOT authorisation for one specific call, not a general
   * licence to watch. Someone handed that link was pointed at a particular
   * call; joining a different person's call instead would be surprising, and it
   * would quietly widen what the link's gesture consented to. So a named room
   * that is not up does NOT fall back to the newest — see below.
   */
  preferred: string | null;
  /** Rooms this page has already watched, left, or failed to join. */
  excluded: ReadonlySet<string>;
  /**
   * Whether this page may join whatever is live, without asking again.
   *
   * A bare `/live` does not start this way: joining a stranger's phone call the
   * instant a page loads is a thing that should require a person to have asked
   * for it, and the telemetry and transcript stream whatever the speakers are
   * doing. The holding screen offers one button, and pressing it arms the page
   * for the rest of the visit — which is what keeps "leave it open, it joins the
   * next one" true without making it true of a link nobody read.
   *
   * Independent of `preferred`, which carries its own authorisation for its own
   * one call.
   */
  armed: boolean;
}

/**
 * The room to join, or null for "keep waiting".
 *
 * `mode` is an input rather than a caller-side guard because the gating is the
 * substance of the rule, not preamble to it: a page that auto-joins while
 * already connecting fires a second token request and abandons the first room
 * mid-handshake, and one that auto-joins while observing tears down the call the
 * visitor is watching in order to rejoin it.
 *
 * `armed` governs only the bare-`/live` path: an unarmed page has no business
 * joining whatever happens to be live, however many calls are up and however
 * new they are. A named room carries its own authorisation and is checked
 * first, because it is a narrower permission rather than a broader one.
 *
 * `excluded` is what makes leaving stick. `/api/active` is polled every five
 * seconds, so the call a visitor just stopped watching is still in the snapshot
 * for several seconds afterwards — without this, Stop watching would be
 * followed immediately by rejoining the same call, and the button would look
 * broken because it would be.
 */
export function autoJoinTarget({
  mode,
  snapshot,
  preferred,
  excluded,
  armed,
}: AutoJoinInput): string | null {
  if (mode !== 'idle') return null;
  if (snapshot === null) return null;

  const candidates = snapshot.rooms.filter((room) => !excluded.has(room.room));
  if (candidates.length === 0) return null;

  /*
   * A named room is joined if it is up, and NOTHING is joined if it is not.
   *
   * The absent `else` is the whole rule. Someone handed `/live?room=X` was
   * pointed at one particular call; if X has hung up, joining whoever else
   * happens to be on the agent is both surprising and a quiet widening of what
   * that link's gesture consented to. The page says the call has ended and
   * offers to watch the next one, which costs a press and is the honest answer.
   *
   * It also does not consult `armed`: the link IS the gesture, for this one
   * call. See `linkRoomGone`, which is how the view learns to stop waiting.
   */
  if (preferred !== null) {
    const named = candidates.find((room) => room.room === preferred);
    return named === undefined ? null : named.room;
  }

  // A bare `/live` is the other case entirely — "watch whatever is live" is
  // exactly what that visitor asked for, once they have asked for it.
  if (!armed) return null;

  /*
   * Newest by the server's own creation time. `createdAt` of 0 is the Worker's
   * encoding of "LiveKit did not say", so it sorts as the oldest thing here —
   * which is the right way round: a call whose age is unknown has no claim to
   * being the newest, and the first-listed one is a better guess than a room
   * pretending to have started in 1970.
   */
  let newest = candidates[0];
  for (const room of candidates) {
    if (room.createdAt > newest.createdAt) newest = room;
  }
  return newest.room;
}

/**
 * Whether the call a `/live?room=…` link named is over.
 *
 * The counterpart to the refusal in `autoJoinTarget`: that function declines to
 * substitute a different call, and this one is how the page learns to stop
 * waiting for the one it was sent to and offer the visitor a choice instead.
 * Without it a dead link would sit on a holding screen forever, which is a
 * worse answer than joining the wrong call rather than a better one.
 *
 * "Gone" is deliberately conservative. A null snapshot is a failed or degraded
 * poll — an absence of information, not evidence of an absence — and treating
 * it as proof would abandon a perfectly live call because one request timed out
 * on a phone. Only a snapshot that arrived and did not contain the room counts.
 *
 * A room in `excluded` is gone in the sense that matters here too: this page has
 * already watched it and been finished with it, so the link has been spent.
 */
export function linkRoomGone({
  snapshot,
  preferred,
  excluded,
}: Pick<AutoJoinInput, 'snapshot' | 'preferred' | 'excluded'>): boolean {
  if (preferred === null) return false;
  if (snapshot === null) return false;
  if (excluded.has(preferred)) return true;
  return !snapshot.rooms.some((room) => room.room === preferred);
}

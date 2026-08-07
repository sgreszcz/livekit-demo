/**
 * Mints a short-lived LiveKit access token: a caller's, or an observer's.
 *
 * The API secret never leaves the Worker: the browser receives only the signed
 * JWT and the public wss:// URL. livekit-server-sdk signs via `jose`, which
 * uses WebCrypto and runs unmodified on Workers.
 *
 * The build prints a `node:crypto` warning for this dependency. It is benign
 * and `nodejs_compat` is deliberately not enabled: the SDK's two node:crypto
 * imports (crypto/digest.js, crypto/uuid.js) are dynamic `await import()` calls
 * inside `else` branches guarded by `globalThis.crypto`, which the Workers
 * runtime always provides — so the branch is unreachable here. Verified by
 * minting a token against `wrangler dev`.
 */

import { AccessToken } from 'livekit-server-sdk';
import { isLiveRoom, resolveRoomId } from './active';
import type { Env } from './env';
import { error, json, randomId } from './http';
import { ROOM_ID } from './rooms';

/** Long enough to hold a demo conversation, short enough to be worthless if leaked. */
const TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Room names an observer may ask for: exactly what this Worker and the SIP
 * bridge mint, and nothing else.
 *
 * An allow-list rather than a deny-list because the value is handed straight to
 * LiveKit as a room grant — a name that is not one of ours is either a typo or
 * an attempt to join something else in the project, and neither deserves a
 * token. The suffix is bounded so a caller cannot use the grant as a place to
 * park arbitrary text.
 */
// SIP dispatch embeds the caller number in the room name (`sip-cockpit-_+44…`),
// so `_` and `+` are legitimate. Verified against a real inbound call.
const OBSERVABLE_ROOM = /^(sip-)?cockpit-[A-Za-z0-9+_-]{1,60}$/;

interface TokenRequest {
  identity?: unknown;
  observe?: unknown;
}

/**
 * Parse the request body once.
 *
 * A Request body is a stream and can only be read once: the second `json()`
 * call throws, so reading it per-field would make whichever field was read
 * second permanently invisible. An absent or malformed body is not an error —
 * the caller path has always worked without one.
 */
async function readBody(request: Request): Promise<TokenRequest> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? (body as TokenRequest) : {};
  } catch {
    return {};
  }
}

/**
 * A caller may suggest a display name, but never their own identity string:
 * it is sanitised and always prefixed, so a visitor cannot mint a token that
 * impersonates the agent or another participant.
 */
function requestedLabel(identity: unknown): string {
  if (typeof identity !== 'string') return '';
  return identity.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24);
}

export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return error(405, 'Use POST');

  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) {
    return error(500, 'LiveKit credentials are not configured on this deployment');
  }

  const body = await readBody(request);

  /*
   * Present but unacceptable is a refusal, never a fall-through: silently
   * minting a fresh caller token for a bad `observe` would answer 200 with a
   * token for a different room, which reads as success to the consumer.
   *
   * Two accepted forms, and the order matters only in that they cannot overlap —
   * a 16-hex id can never satisfy `OBSERVABLE_ROOM`, which demands a `cockpit-`
   * prefix:
   *
   *  * A `room_id` from /api/active. This is the form the cockpit should use,
   *    and the reason /api/active no longer publishes names at all: SIP rooms
   *    are named after the caller's phone number.
   *  * A raw room name. Kept only for the rollout window — the SPA is being
   *    updated separately and will keep posting the old value until it ships.
   *    Deleting this branch is safe the day it does, and until then it grants
   *    nothing the endpoint did not already grant yesterday.
   *
   * Both refusals are the same 403 with the same message. A well-formed id for a
   * call that has since ended must be indistinguishable from a typo, or the
   * endpoint becomes an oracle for "was this id ever real".
   */
  if (body.observe !== undefined) {
    if (typeof body.observe !== 'string') return error(403, 'Not an observable room');

    if (ROOM_ID.test(body.observe)) {
      const resolved = await resolveRoomId(env, body.observe);
      if (resolved === null) return error(403, 'Not an observable room');
      return mintObserver(resolved, env);
    }

    /*
     * A raw room name, for the window in which an older cockpit build is still
     * being served from cache.
     *
     * It is checked for liveness exactly like a hashed id, and that is the
     * whole point of this block. Matching the name grammar proves only that a
     * string is *shaped* like one of ours; it says nothing about whether that
     * call exists. Minting on the grammar alone handed an observer seat to any
     * name that had ever been valid — a stale name from a log, a replayed
     * request, or a lucky guess — which is precisely the property the opaque id
     * was introduced to remove. Leaving the compatibility path unchecked would
     * have preserved the hole while appearing to close it.
     */
    if (!OBSERVABLE_ROOM.test(body.observe)) return error(403, 'Not an observable room');
    const live = await isLiveRoom(env, body.observe);
    if (!live) return error(403, 'Not an observable room');
    return mintObserver(body.observe, env);
  }

  const label = requestedLabel(body.identity);
  /*
   * Still unguessable rather than merely short — and note what /api/active does
   * and does not give away. It publishes an opaque `room_id` for each live call,
   * not the name, so the name itself never reaches a browser. What is published
   * is *that a call exists and may be watched*, for as long as it is live, which
   * is the entire point of the observer feature. The randomness buys the rest: a
   * room cannot be predicted before it is listed, and it cannot be rejoined once
   * the call has dropped off the list, because the handle stops resolving.
   *
   * A caller on this demo should be understood to be broadcasting. If that ever
   * stops being acceptable, the fix belongs in /api/active (stop advertising) or
   * in an explicit consent step — not here.
   */
  const roomName = `cockpit-${randomId(16)}`;
  const identity = `visitor-${label ? `${label}-` : ''}${randomId(10)}`;

  const accessToken = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity,
    ttl: TOKEN_TTL_SECONDS,
  });

  accessToken.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    // The cockpit publishes chaos toggles on the `cockpit-control` topic.
    canPublishData: true,
  });

  return json({
    token: await accessToken.toJwt(),
    url: env.LIVEKIT_URL,
    roomName,
  });
}

/**
 * A read-only seat in somebody else's call.
 *
 * `canPublish: false` and `canPublishData: false` are the whole security model
 * here, not defaults worth tidying away. /api/active publishes a handle for
 * every live call, so anyone can ask to observe one; a publishing observer could
 * talk to the agent over the caller's own audio, or forge frames on the
 * `cockpit-control` topic and drive the chaos toggles of a call they are merely
 * watching. Subscribe-only makes the seat exactly as powerful as a window.
 *
 * The identity prefix is load-bearing too: /api/active counts only participants
 * that do NOT start with `observer-`, so watchers never make a call look busier
 * than it is, and never keep a finished call listed as live.
 *
 * `roomName` is always the REAL name by the time it gets here — resolved from a
 * handle, or posted raw by the not-yet-updated SPA — and both the grant and the
 * echoed `roomName` therefore carry it. That is not an oversight and redacting
 * the echo would not help: a JWT payload is base64, not encrypted, so anyone
 * holding an observer token can read `video.room` out of it, and LiveKit cannot
 * admit them to a room the grant does not name. Joining a call inescapably means
 * learning which call it is.
 *
 * What changed is who pays that price. /api/active is fetched on a timer by
 * every anonymous visitor who so much as loads the front page; asking for an
 * observer token is a deliberate act against one specific call. Moving the name
 * from the first to the second is the whole of the fix, and it is a real one.
 */
async function mintObserver(roomName: string, env: Env): Promise<Response> {
  const accessToken = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: `observer-${randomId(8)}`,
    ttl: TOKEN_TTL_SECONDS,
  });

  accessToken.addGrant({
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
    canPublish: false,
    canPublishData: false,
  });

  return json({
    token: await accessToken.toJwt(),
    url: env.LIVEKIT_URL,
    roomName,
  });
}

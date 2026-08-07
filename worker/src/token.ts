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
import type { Env } from './env';
import { error, json, randomId } from './http';

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
const OBSERVABLE_ROOM = /^(sip-)?cockpit-[A-Za-z0-9-]{1,40}$/;

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

  // Present but unacceptable is a refusal, never a fall-through: silently
  // minting a fresh caller token for a bad `observe` would answer 200 with a
  // token for a different room, which reads as success to the consumer.
  if (body.observe !== undefined) {
    if (typeof body.observe !== 'string' || !OBSERVABLE_ROOM.test(body.observe)) {
      return error(403, 'Not an observable room');
    }
    return mintObserver(body.observe, env);
  }

  const label = requestedLabel(body.identity);
  /*
   * Still unguessable rather than merely short — but note what changed when
   * /api/active shipped: the room name is no longer a secret. It is published to
   * anyone loading the front page for as long as the call is live, which is the
   * entire point of the observer feature. The randomness now buys two narrower
   * things: a room cannot be *predicted* before it is listed, and it cannot be
   * rejoined once the call has dropped off the list.
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
 * here, not defaults worth tidying away. /api/active publishes the room names of
 * live calls, so anyone can ask to observe one; a publishing observer could talk
 * to the agent over the caller's own audio, or forge frames on the
 * `cockpit-control` topic and drive the chaos toggles of a call they are merely
 * watching. Subscribe-only makes the seat exactly as powerful as a window.
 *
 * The identity prefix is load-bearing too: /api/active counts only participants
 * that do NOT start with `observer-`, so watchers never make a call look busier
 * than it is, and never keep a finished call listed as live.
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

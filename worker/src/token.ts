/**
 * Mints a short-lived LiveKit access token for a browser visitor.
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
 * A caller may suggest a display name, but never their own identity string:
 * it is sanitised and always prefixed, so a visitor cannot mint a token that
 * impersonates the agent or another participant.
 */
async function requestedLabel(request: Request): Promise<string> {
  try {
    const body = (await request.json()) as { identity?: unknown };
    if (typeof body.identity !== 'string') return '';
    return body.identity.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24);
  } catch {
    return '';
  }
}

export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return error(405, 'Use POST');

  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) {
    return error(500, 'LiveKit credentials are not configured on this deployment');
  }

  const label = await requestedLabel(request);
  // The room name is the only thing keeping two strangers out of one call, so
  // it is unguessable rather than merely short.
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

/** Small response helpers — every API route answers in JSON. */

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Every route here answers JSON and none of it is ever meant to be
      // interpreted as anything else. Declared once, centrally, so a new route
      // cannot forget it. Routes that need more (a share link's `no-store`, the
      // metrics endpoint's CORS) add it themselves.
      'x-content-type-options': 'nosniff',
      ...init.headers,
    },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

/**
 * 405 with the `Allow` header the status is meaningless without.
 *
 * A 405 that does not say what IS allowed tells a client only that it is wrong,
 * and RFC 9110 makes the header mandatory for exactly that reason.
 */
export function methodNotAllowed(...allowed: string[]): Response {
  return json(
    { error: `Use ${allowed.join(' or ')}` },
    { status: 405, headers: { allow: allowed.join(', ') } },
  );
}

/**
 * 429 with `Retry-After`, so a client can back off instead of guessing.
 */
export function tooManyRequests(retryAfter: number): Response {
  return json(
    { error: 'Too many requests — slow down and try again shortly' },
    { status: 429, headers: { 'retry-after': String(retryAfter) } },
  );
}

const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Random base62 id. Bytes ≥ 248 are discarded so the modulo does not skew the
 * alphabet — cheap here, and the ids are the only thing guarding a debrief.
 */
export function randomId(length: number): string {
  let id = '';
  while (id.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    for (const byte of bytes) {
      if (byte >= 248) continue;
      id += BASE62[byte % 62];
      if (id.length === length) break;
    }
  }
  return id;
}

/**
 * Constant-time string compare, so a bearer token cannot be probed byte by byte.
 *
 * Comparing the strings directly is not constant time however carefully the
 * loop is written: an early return on unequal lengths leaks the token's length,
 * and the loop itself runs for as long as the shorter input. Hashing both sides
 * first fixes that — SHA-256 digests are always 32 bytes, so the comparison
 * takes the same work regardless of what was submitted, and a mismatched digest
 * says nothing about the input that produced it.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);

  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let mismatch = 0;
  for (let i = 0; i < x.length; i += 1) mismatch |= x[i] ^ y[i];
  return mismatch === 0;
}

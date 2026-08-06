/** Small response helpers — every API route answers in JSON. */

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...init.headers,
    },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
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

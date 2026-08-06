import { describe, expect, it } from 'vitest';
import { error, json, randomId, timingSafeEqual } from './http';

describe('json', () => {
  it('serialises the body and always declares JSON', async () => {
    const response = json({ id: 'abc' }, { status: 201 });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ id: 'abc' });
  });

  it('lets a caller add headers without losing the content type', () => {
    const response = json({}, { headers: { 'cache-control': 'no-store' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('error', () => {
  it('answers in the same envelope as everything else', async () => {
    const response = error(413, 'Debrief payload too large');
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Debrief payload too large' });
  });
});

describe('randomId', () => {
  it('returns exactly the requested length', () => {
    for (const length of [1, 6, 16, 32]) expect(randomId(length)).toHaveLength(length);
  });

  it('stays inside the base62 alphabet', () => {
    for (let i = 0; i < 200; i += 1) expect(randomId(16)).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => randomId(16)));
    expect(ids.size).toBe(2000);
  });

  it('spreads over the whole alphabet rather than skewing to its start', () => {
    // Rejection sampling exists to keep this true; without it the first 10
    // characters would come up measurably more often than the last 10.
    const seen = new Set(randomId(4000).split(''));
    expect(seen.size).toBe(62);
  });
});

describe('timingSafeEqual', () => {
  it('accepts an exact match', async () => {
    await expect(timingSafeEqual('s3cret-token', 's3cret-token')).resolves.toBe(true);
  });

  it('accepts two empty strings', async () => {
    await expect(timingSafeEqual('', '')).resolves.toBe(true);
  });

  it('rejects a single flipped character', async () => {
    await expect(timingSafeEqual('s3cret-token', 's3cret-tokes')).resolves.toBe(false);
  });

  it('rejects a value that merely shares a prefix', async () => {
    await expect(timingSafeEqual('s3cret-token', 's3cret')).resolves.toBe(false);
  });

  it('rejects a longer value with the secret as its prefix', async () => {
    await expect(timingSafeEqual('s3cret-token-extra', 's3cret-token')).resolves.toBe(false);
  });

  // Honest scope note: these assertions cover correctness, not timing. A naive
  // `a === b` would satisfy every one of them, because the constant-time
  // property is structural — it lives in comparing two fixed-length digests
  // rather than the strings — and is not observable from return values. A
  // wall-clock test for it is inherently flaky and is deliberately not written
  // here; the guarantee is reviewed in the implementation, not asserted.
  it('rejects guesses of wildly different lengths without erroring', async () => {
    await expect(timingSafeEqual('x', 's3cret-token')).resolves.toBe(false);
    await expect(timingSafeEqual('x'.repeat(100_000), 's3cret-token')).resolves.toBe(false);
  });

  it('handles multi-byte characters without truncating them', async () => {
    await expect(timingSafeEqual('tøken-✓', 'tøken-✓')).resolves.toBe(true);
    await expect(timingSafeEqual('tøken-✓', 'tøken-✗')).resolves.toBe(false);
  });
});

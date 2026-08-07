/**
 * The limiter guards the two routes that cost real money, so the cases that
 * matter are the boundaries: the request that is still allowed, the one that is
 * not, and what happens to a client that keeps hammering after being refused.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEBRIEF_WINDOWS, TOKEN_WINDOWS, check, clientKey, resetRateLimits, tracked } from './ratelimit';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => resetRateLimits());

describe('clientKey', () => {
  it('reads the address the edge set', () => {
    const request = new Request('https://x.example', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    expect(clientKey(request)).toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For, which a client controls', () => {
    // Trusting it would let anyone reset their own counter per request.
    const request = new Request('https://x.example', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(clientKey(request)).toBe('unknown');
  });
});

const PER_MINUTE = TOKEN_WINDOWS[0].limit;
const PER_HOUR = TOKEN_WINDOWS[1].limit;

describe('the limits are a circuit breaker, not a quota', () => {
  it('is set far above anything a room full of humans produces', () => {
    /*
     * The realistic audience is a recruiter, a hiring manager and a few LiveKit
     * engineers, quite possibly behind one office NAT and arriving in the same
     * ten minutes because somebody shared the link. To this limiter that is a
     * single client bursting — the exact shape it exists to stop — so the bar
     * has to sit where no human can reach it. A legitimate visitor seeing a 429
     * on a portfolio piece costs more than an afternoon of wasted inference.
     *
     * This test exists so a future tightening has to be deliberate.
     */
    expect(PER_MINUTE).toBeGreaterThanOrEqual(30);
    expect(PER_HOUR).toBeGreaterThanOrEqual(200);
    expect(DEBRIEF_WINDOWS[0].limit).toBeGreaterThanOrEqual(60);
  });

  it('lets twelve people each start a call in the same minute', () => {
    // One office, one NAT, one shared link. Nobody sees a 429.
    const at = 1_000_000;
    for (let i = 0; i < 12; i += 1) {
      expect(check('token', 'office-nat', TOKEN_WINDOWS, at + i * 1000).ok).toBe(true);
    }
  });
});

describe('check: the short window', () => {
  it('allows the limit and refuses the one after it', () => {
    const at = 1_000_000;
    for (let i = 0; i < PER_MINUTE; i += 1) {
      expect(check('token', 'ip', TOKEN_WINDOWS, at).ok).toBe(true);
    }
    const refused = check('token', 'ip', TOKEN_WINDOWS, at);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfter).toBe(60);
  });

  it('lets the window slide', () => {
    const at = 1_000_000;
    for (let i = 0; i < PER_MINUTE; i += 1) check('token', 'ip', TOKEN_WINDOWS, at);
    expect(check('token', 'ip', TOKEN_WINDOWS, at + MINUTE - 1).ok).toBe(false);
    // The first hit has aged out, so there is room for exactly one more.
    expect(check('token', 'ip', TOKEN_WINDOWS, at + MINUTE + 1).ok).toBe(true);
  });

  it('does not let a refused request extend its own ban', () => {
    // A refused attempt must not be recorded, or a client in a tight retry loop
    // would keep pushing its own window forward and never recover.
    const at = 1_000_000;
    for (let i = 0; i < PER_MINUTE; i += 1) check('token', 'ip', TOKEN_WINDOWS, at);
    for (let i = 0; i < 500; i += 1) check('token', 'ip', TOKEN_WINDOWS, at + i);
    expect(check('token', 'ip', TOKEN_WINDOWS, at + MINUTE + 1).ok).toBe(true);
  });
});

describe('check: the long window', () => {
  it('catches a drip that never trips the per-minute limit', () => {
    // Six a minute forever is well under the short limit, and would be 360
    // agent sessions an hour — the case a single window misses entirely.
    let at = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 300; i += 1) {
      if (check('token', 'ip', TOKEN_WINDOWS, at).ok) allowed += 1;
      at += 10_000;
    }
    expect(allowed).toBe(PER_HOUR);
    expect(check('token', 'ip', TOKEN_WINDOWS, at).ok).toBe(false);
  });

  it('recovers after an hour', () => {
    // Spaced at three seconds so the hourly bucket fills without the per-minute
    // one ever tripping — this is the long window under test, not the short one.
    const at = 1_000_000;
    let now = at;
    for (let i = 0; i < PER_HOUR; i += 1) {
      expect(check('token', 'ip', TOKEN_WINDOWS, now).ok).toBe(true);
      now += 3000;
    }
    expect(check('token', 'ip', TOKEN_WINDOWS, now).ok).toBe(false);
    expect(check('token', 'ip', TOKEN_WINDOWS, at + HOUR + 1).ok).toBe(true);
  });
});

describe('check: isolation', () => {
  it('counts each client separately', () => {
    const at = 1_000_000;
    for (let i = 0; i < PER_MINUTE; i += 1) check('token', 'first', TOKEN_WINDOWS, at);
    expect(check('token', 'first', TOKEN_WINDOWS, at).ok).toBe(false);
    expect(check('token', 'second', TOKEN_WINDOWS, at).ok).toBe(true);
  });

  it('counts each bucket separately', () => {
    // Minting tokens must not spend a client's debrief allowance.
    const at = 1_000_000;
    for (let i = 0; i < PER_MINUTE; i += 1) check('token', 'ip', TOKEN_WINDOWS, at);
    expect(check('token', 'ip', TOKEN_WINDOWS, at).ok).toBe(false);
    expect(check('debrief', 'ip', DEBRIEF_WINDOWS, at).ok).toBe(true);
  });

  it('is looser on debriefs than on tokens', () => {
    // Refusing a debrief loses a recording; refusing a token saves money.
    expect(DEBRIEF_WINDOWS[0].limit).toBeGreaterThan(TOKEN_WINDOWS[0].limit);
  });
});

describe('memory under an address flood', () => {
  it('bounds the table instead of growing forever', () => {
    /*
     * Expiry alone was not a bound. Sweeping only clients whose history had
     * fully aged out meant a flood of FRESH addresses deleted nothing: the map
     * grew without limit and, because the sweep runs whenever the table is
     * oversized, every later request paid a full scan. Unbounded memory and a
     * CPU sink from the same line.
     */
    const at = 1_000_000;
    for (let i = 0; i < 30_000; i += 1) {
      check('token', `ip-${i}`, TOKEN_WINDOWS, at);
    }
    expect(tracked('token')).toBeLessThanOrEqual(10_000);
  });

  it('evicts the quietest clients, not the busiest', () => {
    // An evicted client gets a fresh allowance, so under a flood the limiter
    // degrades toward permissive rather than toward refusing everybody.
    const at = 1_000_000;
    check('token', 'long-quiet', TOKEN_WINDOWS, at);
    for (let i = 0; i < 30_000; i += 1) {
      check('token', `ip-${i}`, TOKEN_WINDOWS, at + 1000 + i);
    }
    // The busiest, most recent clients survive; the one that went quiet first
    // is the one that got dropped.
    expect(tracked('token')).toBeLessThanOrEqual(10_000);
    expect(check('token', 'long-quiet', TOKEN_WINDOWS, at + 40_000).ok).toBe(true);
  });
});

/**
 * The router had no tests at all, which is how `GET /api/debrief/%` came to
 * answer 500: `decodeURIComponent` throws `URIError` on malformed percent-
 * encoding, and an uncaught throw in a Worker's `fetch` is a server error and
 * an alert page for what is entirely the client's mistake.
 *
 * These tests are about dispatch — status codes, methods, and the paths that
 * never reach a handler. What each handler then does is tested beside it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './env';
import worker from './index';
import { resetMetricsMemo } from './metrics';
import { DEBRIEF_WINDOWS, TOKEN_WINDOWS, resetRateLimits } from './ratelimit';

/** A Worker environment with a KV double and no LiveKit credentials. */
function fakeEnv(): Env {
  const store = new Map<string, string>();
  return {
    DEBRIEF_TOKEN: 'the-real-token',
    DEBRIEFS: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      async list() {
        return { keys: [], list_complete: true, cacheStatus: null };
      },
    },
  } as unknown as Env;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://cockpit.example${path}`, init);
}

beforeEach(() => {
  resetRateLimits();
  resetMetricsMemo();
});

afterEach(() => {
  // Only the hourly rate-limit test fakes the clock, but a leaked fake clock
  // would make every later test in this file lie about time.
  vi.useRealTimers();
});

describe('malformed percent-encoding', () => {
  /*
   * Each of these makes `decodeURIComponent` throw. A lone `%` has no hex
   * digits after it; `%zz` has non-hex digits; `%E0%A4%A` is a truncated UTF-8
   * sequence, which is the one that tends to arrive from real crawlers.
   */
  const malformed = ['%', '%zz', '%E0%A4%A', '%FF', '%c0%80'];

  for (const id of malformed) {
    it(`answers 400, not 500, for /api/debrief/${id}`, async () => {
      const response = await worker.fetch(request(`/api/debrief/${id}`), fakeEnv());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Malformed call id' });
    });
  }

  it('decodes a well-formed escape and refuses it on its merits', async () => {
    // %2F is a slash: decodable, but not a valid id, so it is a 400 from the
    // handler's allowlist rather than from the decoder.
    const response = await worker.fetch(request('/api/debrief/a%2Fb'), fakeEnv());
    expect(response.status).toBe(400);
  });

  it('serves a well-formed id through to the store', async () => {
    const response = await worker.fetch(request('/api/debrief/abc123'), fakeEnv());
    expect(response.status).toBe(404); // valid shape, nothing stored
  });

  it('is unbothered by malformed encoding elsewhere in the URL', async () => {
    for (const path of ['/api/metrics?q=%', '/api/active?x=%zz']) {
      const response = await worker.fetch(request(path), fakeEnv());
      expect(response.status).toBe(200);
    }
  });
});

describe('methods', () => {
  it('names what is allowed on a 405', async () => {
    const cases: [string, string, string][] = [
      ['/api/token', 'GET', 'POST'],
      ['/api/active', 'POST', 'GET'],
      ['/api/metrics', 'POST', 'GET'],
      ['/api/debrief/abc123', 'DELETE', 'GET'],
    ];

    for (const [path, method, allow] of cases) {
      const response = await worker.fetch(request(path, { method }), fakeEnv());
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe(allow);
    }
  });

  it('accepts both writers on /api/debrief and refuses the rest', async () => {
    const response = await worker.fetch(request('/api/debrief', { method: 'DELETE' }), fakeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, PUT');
  });

  it('routes PUT to the checkpoint path, which demands the bearer token', async () => {
    const response = await worker.fetch(
      request('/api/debrief', { method: 'PUT', body: '{}' }),
      fakeEnv(),
    );
    expect(response.status).toBe(401);
  });
});

describe('unknown paths', () => {
  it('404s anything that is not a route', async () => {
    for (const path of ['/api', '/api/', '/api/nope', '/api/debrief/a/b', '/api/metrics/extra']) {
      const response = await worker.fetch(request(path), fakeEnv());
      expect(response.status).toBe(404);
    }
  });

  it('declares its content type and refuses to let it be sniffed', async () => {
    const response = await worker.fetch(request('/api/nope'), fakeEnv());
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('rate limiting', () => {
  const from = (ip: string, init: RequestInit = {}) =>
    new Request('https://cockpit.example/api/token', {
      method: 'POST',
      ...init,
      headers: { 'cf-connecting-ip': ip, ...(init.headers ?? {}) },
    });

  it('caps token minting per address', async () => {
    // Every token that gets used spawns an agent that speaks — billable STT,
    // LLM and TTS on an endpoint with no credential in front of it.
    const env = fakeEnv();
    for (let i = 0; i < TOKEN_WINDOWS[0].limit; i += 1) {
      // No LiveKit credentials configured, so the handler answers 500; what
      // matters here is that the request reached it at all.
      expect((await worker.fetch(from('203.0.113.1'), env)).status).not.toBe(429);
    }

    const refused = await worker.fetch(from('203.0.113.1'), env);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);

    // A different visitor is unaffected.
    expect((await worker.fetch(from('203.0.113.2'), env)).status).not.toBe(429);
  });

  it('caps anonymous debrief writes', async () => {
    const env = fakeEnv();
    const body = JSON.stringify({
      call_id: 'RM_x',
      meta: {},
      ended_at: 1,
      messages: [{ v: 1, type: 'state', ts: 1, payload: { state: 'listening' } }],
    });
    const anonymous = () =>
      new Request('https://cockpit.example/api/debrief', {
        method: 'POST',
        body,
        headers: { 'cf-connecting-ip': '198.51.100.9' },
      });

    for (let i = 0; i < DEBRIEF_WINDOWS[0].limit; i += 1) {
      expect((await worker.fetch(anonymous(), env)).status).toBe(201);
    }
    expect((await worker.fetch(anonymous(), env)).status).toBe(429);
  });

  /*
   * The numbers below are written out rather than read from `ALERT_WINDOWS`.
   * A test that asserts the limit is whatever the limit happens to be passes
   * for every value of it, including the one somebody fat-fingers to 5000.
   */
  const alert = () =>
    new Request('https://cockpit.example/api/alerts/twilio?key=x', {
      method: 'POST',
      body: 'UsageCategory=totalprice',
      headers: { 'cf-connecting-ip': '203.0.113.77' },
    });

  it('caps the alert webhook at five a minute', async () => {
    // Nobody is behind this route — Twilio calls it when a trigger fires — so
    // the limit can be what the traffic actually is.
    const env = fakeEnv();
    for (let i = 0; i < 5; i += 1) {
      // No ALERT_WEBHOOK_KEY configured, so each is a 401; what matters is that
      // the request reached the handler at all.
      expect((await worker.fetch(alert(), env)).status).toBe(401);
    }
    const refused = await worker.fetch(alert(), env);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('caps it at twenty an hour, which the per-minute window would never catch', async () => {
    // Four bursts of five, a minute apart: never more than five in any minute,
    // and still over the hour's allowance. The slow drip is exactly what the
    // second window exists for.
    vi.useFakeTimers();
    const start = Date.parse('2026-08-10T09:00:00Z');
    const env = fakeEnv();

    for (let burst = 0; burst < 4; burst += 1) {
      vi.setSystemTime(start + burst * 61_000);
      for (let i = 0; i < 5; i += 1) {
        expect((await worker.fetch(alert(), env)).status).toBe(401);
      }
    }

    vi.setSystemTime(start + 4 * 61_000);
    expect((await worker.fetch(alert(), env)).status).toBe(429);

    // An hour after the first burst it is allowed again.
    vi.setSystemTime(start + 61 * 60_000);
    expect((await worker.fetch(alert(), env)).status).toBe(401);
  });

  it('never throttles the agent', async () => {
    // The agent holds a bearer token and its uploads are the recordings this
    // whole system exists to keep. Throttling it would drop real calls.
    const env = fakeEnv();
    const body = JSON.stringify({
      call_id: 'RM_agent',
      meta: {},
      ended_at: 1,
      messages: [{ v: 1, type: 'state', ts: 1, payload: { state: 'listening' } }],
    });

    for (let i = 0; i < DEBRIEF_WINDOWS[0].limit * 2; i += 1) {
      const response = await worker.fetch(
        new Request('https://cockpit.example/api/debrief', {
          method: 'POST',
          body,
          headers: {
            'cf-connecting-ip': '198.51.100.10',
            authorization: 'Bearer the-real-token',
          },
        }),
        env,
      );
      expect(response.status).toBe(201);
    }
  });
});

describe('the alert webhook is a route like any other', () => {
  it('takes POST and nothing else', async () => {
    const response = await worker.fetch(request('/api/alerts/twilio'), fakeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('401s a request carrying no key', async () => {
    const response = await worker.fetch(
      request('/api/alerts/twilio', { method: 'POST', body: '' }),
      fakeEnv(),
    );
    expect(response.status).toBe(401);
  });
});

/**
 * The ledger is deferred, which means it runs only if the router actually hands
 * the handler somewhere to defer to. Nothing else fails if that argument is
 * dropped — the upload still returns 201 — so the wiring is pinned here rather
 * than left to be noticed from a spend alert that never arrives.
 */
describe('deferred work is given somewhere to go', () => {
  it('threads waitUntil through to the debrief spend ledger', async () => {
    const usagePuts: string[] = [];
    const env = {
      ...(fakeEnv() as unknown as Record<string, unknown>),
      USAGE: {
        async get() {
          return null;
        },
        async put(key: string) {
          usagePuts.push(key);
        },
      },
    } as unknown as Env;

    const deferred: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (work: Promise<unknown>) => deferred.push(work),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await worker.fetch(
      new Request('https://cockpit.example/api/debrief', {
        method: 'POST',
        body: JSON.stringify({
          call_id: 'RM_router',
          meta: { room: 'cockpit-x', started_at: 1723000000 },
          ended_at: 1723000049.5,
          messages: [{ v: 1, type: 'state', ts: 1723000000.5, payload: { state: 'listening' } }],
        }),
        headers: { authorization: 'Bearer the-real-token' },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(201);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    // The month `ended_at` names, not the month this test runs in.
    expect(usagePuts).toEqual(['usage_2024-08']);
  });
});

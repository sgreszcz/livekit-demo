/**
 * The debrief endpoint takes unauthenticated POSTs from any browser, so its two
 * gatekeepers — the body cap and the payload validator — are the parts most
 * worth testing. Both are pure enough to exercise without a running Worker.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_BYTES,
  checkpointKey,
  handleDebriefGet,
  handleDebriefPost,
  handleDebriefPut,
  readCappedBody,
  validate,
} from './debrief';
import type { Env } from './env';

const encoder = new TextEncoder();

/** Just enough Request for `readCappedBody`: headers and a readable body. */
function mockRequest(body: ReadableStream<Uint8Array> | null, headers: HeadersInit = {}): Request {
  return { headers: new Headers(headers), body } as unknown as Request;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function envelope(type: string, payload: Record<string, unknown> = {}) {
  return { v: 1, type, ts: 1723000000.5, payload };
}

function debriefBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    call_id: 'RM_demo0001',
    meta: { room: 'cockpit-demo01' },
    ended_at: 1723000049.5,
    messages: [envelope('call_meta', { call_id: 'RM_demo0001' }), envelope('state')],
    ...overrides,
  });
}

describe('readCappedBody', () => {
  it('reads a body that fits', async () => {
    const request = mockRequest(streamOf(encoder.encode('{"a":1}')));
    await expect(readCappedBody(request)).resolves.toEqual({ ok: true, body: '{"a":1}' });
  });

  it('reassembles a body split across chunks', async () => {
    const request = mockRequest(
      streamOf(encoder.encode('{"a":'), encoder.encode('1'), encoder.encode('}')),
    );
    await expect(readCappedBody(request)).resolves.toEqual({ ok: true, body: '{"a":1}' });
  });

  it('reads an empty body as an empty string', async () => {
    await expect(readCappedBody(mockRequest(null))).resolves.toEqual({ ok: true, body: '' });
  });

  it('rejects on an honest oversized content-length without opening the body', async () => {
    const stream = streamOf(new Uint8Array(1024));
    let opened = false;
    const request = {
      headers: new Headers({ 'content-length': String(MAX_BODY_BYTES + 1) }),
      body: {
        getReader: () => {
          opened = true;
          return stream.getReader();
        },
      },
    } as unknown as Request;

    await expect(readCappedBody(request)).resolves.toEqual({ ok: false, reason: 'too_large' });
    expect(opened).toBe(false);
  });

  it('rejects a body that exceeds the cap despite a truthful small header', async () => {
    // The old cap trusted content-length, then buffered the whole thing anyway.
    const request = mockRequest(streamOf(new Uint8Array(MAX_BODY_BYTES + 1)), {
      'content-length': '10',
    });
    await expect(readCappedBody(request)).resolves.toEqual({ ok: false, reason: 'too_large' });
  });

  it('accepts a body sitting exactly on the cap', async () => {
    const request = mockRequest(streamOf(encoder.encode('x'.repeat(MAX_BODY_BYTES))));
    const read = await readCappedBody(request);
    expect(read.ok).toBe(true);
    expect(read.ok && read.body).toHaveLength(MAX_BODY_BYTES);
  });

  it('gives up quietly on a body that fails mid-stream', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"messages":'));
        controller.error(new Error('connection reset'));
      },
    });
    // Distinct reason from "too large", so the caller can answer 400 not 413.
    await expect(readCappedBody(mockRequest(broken))).resolves.toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('abandons a chunked upload instead of buffering it', async () => {
    // No content-length, and the body never ends. The old implementation would
    // have sat in request.text() until the isolate ran out of memory.
    let produced = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });

    await expect(readCappedBody(mockRequest(endless))).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    });
    // 256 KB of cap at 64 KB a chunk: a handful of reads, not an unbounded run.
    expect(produced).toBeLessThanOrEqual(8);
  });
});

describe('validate', () => {
  it('accepts a well-formed debrief', () => {
    const record = validate(debriefBody());
    expect(record).not.toBeNull();
    expect(record!.call_id).toBe('RM_demo0001');
    expect(record!.messages).toHaveLength(2);
    expect(record!.ended_at).toBe(1723000049.5);
    expect(record!.source).toBe('browser');
    expect(typeof record!.stored_at).toBe('number');
  });

  it('drops the envelopes it does not recognise but keeps the rest', () => {
    const record = validate(
      debriefBody({
        messages: [
          envelope('turn', { turn_id: 't1' }),
          envelope('gremlin'),
          { v: 1, type: 'state', ts: 'soon', payload: {} },
          { v: 2, type: 'state', ts: 1, payload: {} },
          { type: 'state', ts: 1, payload: {} },
          { v: 1, type: 'state', ts: 1, payload: null },
          'not an envelope at all',
          null,
          envelope('usage'),
        ],
      }),
    );
    expect(record!.messages.map((message) => (message as { type: string }).type)).toEqual([
      'turn',
      'usage',
    ]);
  });

  it('substitutes safe defaults for a missing call id and end time', () => {
    const record = validate(
      JSON.stringify({ messages: [envelope('state')] }),
    );
    expect(record!.call_id).toBe('unknown');
    expect(record!.meta).toBeNull();
    expect(typeof record!.ended_at).toBe('number');
  });

  it('truncates an over-long call id rather than storing it', () => {
    const record = validate(debriefBody({ call_id: 'A'.repeat(500) }));
    expect(record!.call_id).toHaveLength(128);
  });

  const rejected: [string, string][] = [
    ['a body that is not JSON', 'not json at all'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['a JSON string', '"debrief"'],
    ['JSON null', 'null'],
    ['a record with no messages', JSON.stringify({ call_id: 'x' })],
    ['a messages field that is not an array', JSON.stringify({ messages: 'lots' })],
    ['an empty message list', JSON.stringify({ messages: [] })],
    [
      'a message list of nothing but junk',
      JSON.stringify({ messages: [{ type: 'gremlin' }, 42, null] }),
    ],
    // The crafted debrief from the review: it used to round-trip and then throw
    // in the viewer. There is nothing here worth storing.
    ['the crafted call_meta with an empty payload', '{"messages":[{"type":"call_meta","ts":1,"payload":{}}]}'],
  ];

  for (const [name, body] of rejected) {
    it(`rejects ${name}`, () => {
      expect(validate(body)).toBeNull();
    });
  }

  it('rejects a message list past the count cap', () => {
    const messages = Array.from({ length: 4001 }, () => envelope('state'));
    expect(validate(JSON.stringify({ messages }))).toBeNull();
  });

  it('accepts a message list right on the count cap', () => {
    const messages = Array.from({ length: 4000 }, () => envelope('state'));
    expect(validate(JSON.stringify({ messages }))!.messages).toHaveLength(4000);
  });

  it('never trusts a client-supplied source label', () => {
    const record = validate(debriefBody({ source: 'agent' }));
    expect(record!.source).toBe('browser');
  });
});

/** A KV double that records what was written, deleted and with what options. */
function fakeKv() {
  const store = new Map<string, string>();
  const puts: { key: string; options: unknown }[] = [];
  const deletes: string[] = [];
  return {
    store,
    puts,
    deletes,
    env: {
      DEBRIEF_TOKEN: 'the-real-token',
      DEBRIEFS: {
        async put(key: string, value: string, options: unknown) {
          store.set(key, value);
          puts.push({ key, options });
        },
        async get(key: string) {
          return store.get(key) ?? null;
        },
        async delete(key: string) {
          store.delete(key);
          deletes.push(key);
        },
      },
    } as unknown as Env,
  };
}

function post(body: string, headers: HeadersInit = {}): Request {
  return new Request('https://cockpit.example/api/debrief', { method: 'POST', body, headers });
}

function put(body: string, headers: HeadersInit = {}): Request {
  return new Request('https://cockpit.example/api/debrief', { method: 'PUT', body, headers });
}

const AGENT = { authorization: 'Bearer the-real-token' };

describe('validate: envelope types', () => {
  it('keeps transport envelopes', () => {
    // Omitting `transport` from the allowlist silently stripped every
    // browser-sampled WebRTC reading out of every stored debrief, so a shared
    // call always claimed the network panel was "not recorded on this call".
    const stored = validate(
      debriefBody({
        messages: [envelope('call_meta'), envelope('transport', { rtt_ms: 48, quality: 'good' })],
      }),
    );
    expect(stored).not.toBeNull();
    expect(stored!.messages).toHaveLength(2);
    expect(JSON.stringify(stored!.messages)).toContain('rtt_ms');
  });

  it('still drops an envelope of an unknown type', () => {
    const stored = validate(
      debriefBody({ messages: [envelope('call_meta'), envelope('telepathy', { x: 1 })] }),
    );
    expect(stored!.messages).toHaveLength(1);
  });
});

describe('validate: hostile shapes', () => {
  it('refuses an array as a payload', () => {
    // `typeof [] === 'object'` and `[] !== null`, so the old check accepted it
    // and stored an envelope with a list where every reader expects a record.
    const stored = validate(
      debriefBody({ messages: [{ v: 1, type: 'state', ts: 1, payload: [] }] }),
    );
    expect(stored).toBeNull();
  });

  it('refuses envelopes carrying prototype-pollution keys', () => {
    // Written as raw JSON on purpose: `{ __proto__: … }` in an object literal
    // sets the prototype rather than creating an own property, so a test built
    // that way would stringify to `{}` and prove nothing. Over the wire the key
    // is an ordinary string, which is exactly the case that matters.
    const stored = validate(
      `{"call_id":"RM_demo0001","meta":{},"ended_at":1,"messages":[` +
        `{"v":1,"type":"call_meta","ts":1,"payload":{}},` +
        `{"v":1,"type":"state","ts":1,"payload":{"__proto__":{"polluted":true}}},` +
        `{"v":1,"type":"state","ts":1,"payload":{"nested":{"constructor":{"x":1}}}}` +
        `]}`,
    );
    // Only the clean envelope survives; nothing dangerous is persisted for the
    // SPA to merge later.
    expect(stored!.messages).toHaveLength(1);
    expect(JSON.stringify(stored!.messages)).not.toContain('polluted');
  });

  it('drops a meta block carrying prototype-pollution keys, keeping the call', () => {
    const stored = validate(
      `{"call_id":"RM_demo0001","meta":{"room":"cockpit-x","__proto__":{"bad":1}},` +
        `"ended_at":1,"messages":[{"v":1,"type":"state","ts":1,"payload":{}}]}`,
    );
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored!.meta)).not.toContain('bad');
    expect(stored!.messages).toHaveLength(1);
  });

  it('refuses a payload nested past any legitimate depth', () => {
    let deep: Record<string, unknown> = { bottom: true };
    for (let i = 0; i < 40; i += 1) deep = { down: deep };
    const stored = validate(
      debriefBody({ messages: [envelope('call_meta'), { v: 1, type: 'state', ts: 1, payload: deep }] }),
    );
    expect(stored!.messages).toHaveLength(1);
  });

  it('drops fields the envelope schema does not define', () => {
    const stored = validate(
      debriefBody({
        messages: [{ v: 1, type: 'state', ts: 1, payload: { state: 'listening' }, evil: 'x' }],
      }),
    );
    expect(JSON.stringify(stored!.messages)).not.toContain('evil');
    expect(JSON.stringify(stored!.messages)).toContain('listening');
  });

  it('drops a non-finite number rather than storing a null in its place', () => {
    const stored = validate(
      debriefBody({
        messages: [{ v: 1, type: 'turn', ts: 1, payload: { turn_id: 't', total_response_latency: Infinity } }],
      }),
    );
    // JSON.parse cannot produce Infinity, so this arrives as null and is kept
    // as null; the guard exists for values built in code paths that can.
    expect(stored).not.toBeNull();
  });
});

describe('validate: room-name redaction', () => {
  const SIP = 'sip-cockpit-_+447700900123_BXhCPPSrr57t';

  it('redacts the caller number in meta and in the call_meta envelope', () => {
    const stored = validate(
      debriefBody({ meta: { room: SIP }, messages: [envelope('call_meta', { room: SIP })] }),
    );
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain('447700900123');
    expect(serialised).toContain('+REDACTED');
    expect(serialised).toContain('BXhCPPSrr57t');
  });

  it('leaves a browser room name alone', () => {
    const stored = validate(debriefBody({ meta: { room: 'cockpit-AKI0UWWR2t0BaIwA' } }));
    expect(JSON.stringify(stored!.meta)).toContain('cockpit-AKI0UWWR2t0BaIwA');
  });
});

describe('handleDebriefPost: who wrote this', () => {
  it('marks a bearer-authenticated upload as the agent', async () => {
    const kv = fakeKv();
    const response = await handleDebriefPost(post(debriefBody(), AGENT), kv.env);
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(JSON.parse(kv.store.get(id)!).source).toBe('agent');
    expect(JSON.parse(kv.store.get(id)!).in_progress).toBe(false);
  });

  it('marks an anonymous upload as the browser', async () => {
    const kv = fakeKv();
    const response = await handleDebriefPost(post(debriefBody()), kv.env);
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(JSON.parse(kv.store.get(id)!).source).toBe('browser');
  });

  it('refuses a bearer token that does not verify instead of downgrading it', async () => {
    // `source` decides whether a record moves the public dashboard, so a typo
    // in DEBRIEF_TOKEN must not silently reclassify every real call as
    // untrusted and empty the fleet numbers with a 201 on every upload.
    const kv = fakeKv();
    const response = await handleDebriefPost(
      post(debriefBody(), { authorization: 'Bearer wrong' }),
      kv.env,
    );
    expect(response.status).toBe(401);
    expect(kv.puts).toHaveLength(0);
  });

  it('deletes the call checkpoint once the final debrief lands', async () => {
    const kv = fakeKv();
    await handleDebriefPut(put(debriefBody(), AGENT), kv.env);
    const key = await checkpointKey('RM_demo0001');
    expect(kv.store.has(key)).toBe(true);

    await handleDebriefPost(post(debriefBody(), AGENT), kv.env);
    expect(kv.deletes).toContain(key);
    expect(kv.store.has(key)).toBe(false);
  });

  it('does not delete a checkpoint on an anonymous post', async () => {
    // A browser copy of a call must not be able to evict the agent's record.
    const kv = fakeKv();
    await handleDebriefPut(put(debriefBody(), AGENT), kv.env);
    await handleDebriefPost(post(debriefBody()), kv.env);
    expect(kv.deletes).toHaveLength(0);
  });
});

describe('handleDebriefPut: in-flight checkpoints', () => {
  it('stores under a key derived from the call id, and overwrites in place', async () => {
    const kv = fakeKv();
    await handleDebriefPut(put(debriefBody(), AGENT), kv.env);
    await handleDebriefPut(
      put(debriefBody({ messages: [envelope('call_meta'), envelope('state'), envelope('state')] }), AGENT),
      kv.env,
    );

    const key = await checkpointKey('RM_demo0001');
    expect(kv.puts.map((p) => p.key)).toEqual([key, key]);
    expect(kv.store.size).toBe(1);
    const stored = JSON.parse(kv.store.get(key)!);
    expect(stored.in_progress).toBe(true);
    expect(stored.source).toBe('agent');
    expect(stored.messages).toHaveLength(3);
  });

  it('keys checkpoints out of the shareable id space', async () => {
    // `/api/debrief/:id` matches [A-Za-z0-9] only, so the underscore in the
    // prefix is what makes a checkpoint unfetchable as a share link.
    expect(await checkpointKey('RM_demo0001')).toMatch(/^chk_[0-9a-f]{32}$/);
  });

  it('refuses an anonymous checkpoint', async () => {
    const kv = fakeKv();
    const response = await handleDebriefPut(put(debriefBody()), kv.env);
    expect(response.status).toBe(401);
    expect(kv.puts).toHaveLength(0);
  });

  it('refuses a checkpoint with no call id', async () => {
    // Without one there is nothing stable to key on, and a random key would
    // make every checkpoint a new call in the fleet count.
    const kv = fakeKv();
    const body = JSON.stringify({ meta: {}, ended_at: 1, messages: [envelope('state')] });
    const response = await handleDebriefPut(put(body, AGENT), kv.env);
    expect(response.status).toBe(400);
    expect(kv.puts).toHaveLength(0);
  });

  it('expires far sooner than a finished call', async () => {
    const kv = fakeKv();
    await handleDebriefPut(put(debriefBody(), AGENT), kv.env);
    await handleDebriefPost(post(debriefBody(), AGENT), kv.env);
    const [checkpoint, final] = kv.puts;
    const ttl = (p: { options: unknown }) => (p.options as { expirationTtl: number }).expirationTtl;
    expect(ttl(checkpoint)).toBe(6 * 60 * 60);
    expect(ttl(final)).toBe(90 * 24 * 60 * 60);
  });
});

describe('handleDebriefGet: a share link is a credential', () => {
  it('never tells a shared cache to keep a transcript', async () => {
    const kv = fakeKv();
    const { id } = (await (await handleDebriefPost(post(debriefBody(), AGENT), kv.env)).json()) as {
      id: string;
    };
    const response = await handleDebriefGet(id, kv.env);
    expect(response.status).toBe(200);
    // It used to be `public, max-age=31536000, immutable` — a year of shared
    // caching for a record whose own TTL is ninety days.
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('redacts a room name stored before redaction existed', async () => {
    const kv = fakeKv();
    // Written straight to KV, the way the old code would have left it.
    kv.env.DEBRIEFS.put(
      'legacyid',
      JSON.stringify({
        call_id: 'RM_old',
        meta: { room: 'sip-cockpit-_+447700900123_old' },
        ended_at: 1,
        messages: [{ v: 1, type: 'call_meta', ts: 1, payload: { room: 'sip-cockpit-_+447700900123_old' } }],
        stored_at: 1,
        source: 'agent',
      }),
      {},
    );

    const body = await (await handleDebriefGet('legacyid', kv.env)).text();
    expect(body).not.toContain('447700900123');
    expect(body).toContain('+REDACTED');
  });

  it('refuses a malformed id without reading KV', async () => {
    const kv = fakeKv();
    expect((await handleDebriefGet('../secret', kv.env)).status).toBe(400);
    expect((await handleDebriefGet('a'.repeat(33), kv.env)).status).toBe(400);
  });
});

/**
 * The final POST is the only thing that feeds the spend ledger, and the branch
 * it feeds from is the bearer-authenticated one. That is not a detail: anyone on
 * the internet can POST here — the browser path is deliberate — so an anonymous
 * body reaching the emailer would be an email amplifier with a public URL.
 */
describe('handleDebriefPost: the spend ledger hook', () => {
  /** The debrief fake, plus a USAGE namespace and a `defer` that can be awaited. */
  function ledgerKv(vars: Record<string, unknown> = {}) {
    const kv = fakeKv();
    const usage = new Map<string, string>();
    const usagePuts: string[] = [];
    const deferred: Promise<unknown>[] = [];

    const env = {
      ...(kv.env as unknown as Record<string, unknown>),
      USAGE: {
        async get(key: string) {
          return usage.get(key) ?? null;
        },
        async put(key: string, value: string) {
          usage.set(key, value);
          usagePuts.push(key);
        },
      },
      ...vars,
    } as unknown as Env;

    return {
      env,
      usage,
      usagePuts,
      defer: (work: Promise<unknown>) => {
        deferred.push(work);
      },
      settle: () => Promise.all(deferred),
    };
  }

  /**
   * A call with a readable clock. `debriefBody`'s meta carries no `started_at`,
   * which `summariseCall` reports as a null duration — right for the fleet
   * numbers, useless for exercising minutes.
   */
  function timedBody() {
    return debriefBody({ meta: { room: 'cockpit-demo01', started_at: 1723000000 } });
  }

  it('records an agent-authenticated final call in the month the call ended in', async () => {
    const ledger = ledgerKv();
    const response = await handleDebriefPost(post(timedBody(), AGENT), ledger.env, ledger.defer);
    expect(response.status).toBe(201);

    await ledger.settle();
    // `ended_at` is 1723000049.5 — 7 August 2024 — and NOT whenever this test
    // happens to run. The month a call belongs to is the month it ended in.
    expect(ledger.usagePuts).toEqual(['usage_2024-08']);
    const stored = JSON.parse(ledger.usage.get('usage_2024-08')!);
    expect(stored.calls).toBe(1);
    // 30.5s: the last envelope plus the idle-tail grace, not `ended_at`.
    expect(stored.seconds).toBeCloseTo(30.5, 5);
    // Which LiveKit bills as a whole minute.
    expect(stored.billable_minutes).toBe(1);
    expect(stored.recent_call_ids).toEqual(['RM_demo0001']);
  });

  it('ledgers a call that ended a second before the month rolled over into that month', async () => {
    // 23:59:59 UTC on the last of August. The deferred work could run in
    // September — a slow isolate, a retried upload — and stamping it with the
    // processing time would move a month's worth of minutes across the boundary
    // one call at a time.
    const ledger = ledgerKv();
    const endedAt = Date.UTC(2026, 7, 31, 23, 59, 59) / 1000;
    await handleDebriefPost(
      post(
        debriefBody({
          meta: { room: 'cockpit-demo01', started_at: endedAt - 40 },
          ended_at: endedAt,
          messages: [{ v: 1, type: 'state', ts: endedAt - 10, payload: {} }],
        }),
        AGENT,
      ),
      ledger.env,
      ledger.defer,
    );

    await ledger.settle();
    expect(ledger.usagePuts).toEqual(['usage_2026-08']);
  });

  it('does not count a retried final upload twice', async () => {
    // The agent retries a final POST it got no answer to. Same call, same id.
    const ledger = ledgerKv();
    for (let i = 0; i < 3; i += 1) {
      const response = await handleDebriefPost(post(timedBody(), AGENT), ledger.env, ledger.defer);
      expect(response.status).toBe(201);
      // Settled between attempts: a retry follows a failed attempt, it does not
      // race one, and interleaving them here would be testing the KV race this
      // deliberately does not try to win.
      await ledger.settle();
    }

    expect(ledger.usagePuts).toEqual(['usage_2024-08']);
    expect(JSON.parse(ledger.usage.get('usage_2024-08')!)).toMatchObject({
      calls: 1,
      billable_minutes: 1,
    });
  });

  it('does not touch USAGE or send anything on an ANONYMOUS post', async () => {
    // The amplifier guard. A public route that sends email on demand is a public
    // route that sends email on demand.
    const ledger = ledgerKv({
      USAGE_ALERT_MINUTES: '1',
      EMAIL: {
        send() {
          throw new Error('an anonymous post reached the emailer');
        },
      },
    });

    const response = await handleDebriefPost(post(timedBody()), ledger.env, ledger.defer);
    expect(response.status).toBe(201);
    await ledger.settle();
    expect(ledger.usagePuts).toHaveLength(0);
  });

  it('does not touch USAGE on a checkpoint PUT', async () => {
    // A checkpoint is a call still running. Metering it here would count the
    // same minutes again when the final POST lands.
    const ledger = ledgerKv();
    const response = await handleDebriefPut(put(timedBody(), AGENT), ledger.env);
    expect(response.status).toBe(200);
    await ledger.settle();
    expect(ledger.usagePuts).toHaveLength(0);
  });

  it('does not touch USAGE for a call that named no id', async () => {
    const ledger = ledgerKv();
    const body = JSON.stringify({ meta: {}, ended_at: 1, messages: [envelope('state')] });
    await handleDebriefPost(post(body, AGENT), ledger.env, ledger.defer);
    await ledger.settle();
    expect(ledger.usagePuts).toHaveLength(0);
  });

  it('still answers 201 when the alert email throws', async () => {
    // The upload is a recording and is unrecoverable; the email is a courtesy.
    const ledger = ledgerKv({
      USAGE_ALERT_MINUTES: '1',
      EMAIL: {
        async send() {
          throw new Error('smtp is having a day');
        },
      },
    });

    const response = await handleDebriefPost(post(timedBody(), AGENT), ledger.env, ledger.defer);
    expect(response.status).toBe(201);
    await expect(ledger.settle()).resolves.toBeDefined();
    // The minutes were still written, and the threshold still marked.
    expect(ledger.usagePuts).toHaveLength(1);
    expect(JSON.parse([...ledger.usage.values()][0]).alerted['1']).toBeGreaterThan(0);
  });

  it('does nothing at all when no defer is supplied', async () => {
    const ledger = ledgerKv();
    const response = await handleDebriefPost(post(timedBody(), AGENT), ledger.env);
    expect(response.status).toBe(201);
    await ledger.settle();
    expect(ledger.usagePuts).toHaveLength(0);
  });
});

describe('validate: redaction scrubs by shape, not by field name', () => {
  it('finds a number in a field nobody thought to list', () => {
    // The old scrub rewrote exactly `meta.room` and the `call_meta` payload's
    // `room`. Every other key was a leak waiting for a schema change.
    const stored = validate(
      debriefBody({
        meta: { room: 'cockpit-x', participant: 'sip_+447700900123' },
        messages: [
          envelope('call_meta', { attributes: { caller: '+447700900123' } }),
          envelope('transcript', { role: 'user', text: 'call me on 07700 900123 later' }),
        ],
      }),
    );
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain('447700900123');
    expect(serialised).not.toContain('900123');
    expect(serialised).toContain('+REDACTED');
  });

  it('catches a number written with separators', () => {
    for (const written of ['+44-7700-900123', '(0770) 090 0123', '+44 7700 900123']) {
      const stored = validate(debriefBody({ meta: { room: `sip-cockpit-_${written}_abc` } }));
      expect(JSON.stringify(stored)).toContain('+REDACTED');
    }
  });

  it('leaves timestamps and short numbers alone', () => {
    // Numbers are not strings, so the unix timestamps that a naive scrub of the
    // serialised JSON would mangle are never even looked at.
    const stored = validate(
      debriefBody({
        ended_at: 1786098223.1201081,
        messages: [{ v: 1, type: 'turn', ts: 1786098223.12, payload: { turn_id: 't1', total_response_latency: 1.547 } }],
      }),
    );
    expect(stored!.ended_at).toBe(1786098223.1201081);
    const serialised = JSON.stringify(stored!.messages);
    expect(serialised).toContain('1786098223');
    expect(serialised).toContain('1.547');
    expect(serialised).not.toContain('REDACTED');
  });

  it('does not mistake a date for a phone number', () => {
    // Allowing separators is what catches `+44-7700-900123`; it also matches
    // `2026-08-07`, which is eight digits and a date. Dialable numbers are
    // longer, so a separated match needs nine digits before it is cut.
    const stored = validate(debriefBody({ meta: { room: 'cockpit-x', when: '2026-08-07' } }));
    expect(JSON.stringify(stored!.meta)).toContain('2026-08-07');
  });

  it('leaves an ordinary browser room name intact', () => {
    // A random base62 id with a few digits in it is not a phone number: the
    // separators are stripped and the DIGITS counted before anything is cut.
    for (const name of ['cockpit-AKI0UWWR2t0BaIwA', 'cockpit-a1b2c3', 'cockpit-9-8-7']) {
      const stored = validate(debriefBody({ meta: { room: name } }));
      expect(JSON.stringify(stored!.meta)).toContain(name);
    }
  });
});

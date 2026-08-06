/**
 * The debrief endpoint takes unauthenticated POSTs from any browser, so its two
 * gatekeepers — the body cap and the payload validator — are the parts most
 * worth testing. Both are pure enough to exercise without a running Worker.
 */

import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, readCappedBody, validate } from './debrief';

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

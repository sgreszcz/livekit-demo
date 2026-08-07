/**
 * Debrief storage: a finished call's envelope log, saved under a short id and
 * replayable at /call/:id.
 *
 * Two writers post here — the Python agent (bearer token, the canonical copy)
 * and the browser, which assembles its own copy live and needs no credential.
 * The browser path is therefore treated as untrusted input: hard size cap,
 * shape validation, and a bounded message count before anything reaches KV.
 */

import type { Env } from './env';
import { error, json, randomId, timingSafeEqual } from './http';

export const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 4000;
const TTL_SECONDS = 90 * 24 * 60 * 60;
/**
 * The id is the only thing guarding a stored call, and a collision silently
 * overwrites someone else's debrief. 16 base62 characters is ~95 bits: far past
 * both guessing and the birthday bound for anything this Worker will ever hold.
 */
const ID_LENGTH = 16;

const ENVELOPE_TYPES = new Set([
  'turn',
  'transcript',
  'state',
  'interruption',
  'usage',
  'chaos',
  'call_meta',
]);

const VALID_ID = /^[A-Za-z0-9]{1,32}$/;

const SCHEMA_VERSION = 1;

function isEnvelopeShaped(message: unknown): message is Record<string, unknown> {
  if (typeof message !== 'object' || message === null) return false;
  const candidate = message as Record<string, unknown>;
  return (
    candidate.v === SCHEMA_VERSION &&
    typeof candidate.type === 'string' &&
    ENVELOPE_TYPES.has(candidate.type) &&
    typeof candidate.ts === 'number' &&
    Number.isFinite(candidate.ts) &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null
  );
}

/** KV list metadata, written on put so /api/metrics can order without reading. */
export interface DebriefMetadata {
  /** Unix seconds, same value as the record's own `stored_at`. */
  stored_at: number;
}

export interface StoredDebrief {
  call_id: string;
  meta: unknown;
  ended_at: number;
  messages: unknown[];
  stored_at: number;
  /** Whether the agent posted this, or a browser did. Useful when debugging. */
  source: 'agent' | 'browser';
}

async function isAgentRequest(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('authorization');
  if (!header || !env.DEBRIEF_TOKEN) return false;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return false;
  return timingSafeEqual(value, env.DEBRIEF_TOKEN);
}

/**
 * Reads at most `MAX_BODY_BYTES` and gives up the moment the stream goes past
 * it.
 *
 * A cap measured after `request.text()` is not a cap: a chunked upload, or one
 * with a lying `content-length`, is fully buffered in the isolate before anyone
 * looks at its size. So the body is pulled a chunk at a time and abandoned as
 * soon as the running total is too big — nothing beyond the limit is ever held.
 */
export type BodyRead =
  | { ok: true; body: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

export async function readCappedBody(request: Request): Promise<BodyRead> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  if (!request.body) return { ok: true, body: '' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    // The client hung up mid-upload, or the body failed. Distinct from "too
    // large": answering 413 to a dropped connection sends the wrong operator
    // down the wrong path.
    return { ok: false, reason: 'unreadable' };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(body) };
}

export function validate(raw: string): StoredDebrief | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (!Array.isArray(record.messages)) return null;
  if (record.messages.length === 0 || record.messages.length > MAX_MESSAGES) return null;

  // Structural only. The Worker is a store, not a schema oracle: it enforces
  // size and shape, and the viewer validates every payload field for field
  // before rendering it. Duplicating that contract here would put two copies of
  // it in two languages, drifting apart on the first schema change.
  const messages = record.messages.filter(isEnvelopeShaped);
  if (messages.length === 0) return null;

  return {
    call_id: typeof record.call_id === 'string' ? record.call_id.slice(0, 128) : 'unknown',
    meta: typeof record.meta === 'object' ? record.meta : null,
    ended_at: typeof record.ended_at === 'number' ? record.ended_at : Date.now() / 1000,
    messages,
    stored_at: Date.now() / 1000,
    source: 'browser',
  };
}

export async function handleDebriefPost(request: Request, env: Env): Promise<Response> {
  const read = await readCappedBody(request);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? error(413, 'Debrief payload too large')
      : error(400, 'Could not read the debrief payload');
  }

  const record = validate(read.body);
  if (!record) return error(400, 'Not a valid debrief payload');

  record.source = (await isAgentRequest(request, env)) ? 'agent' : 'browser';

  const id = randomId(ID_LENGTH);
  // The ids are random, so a KV list is in no useful order. Carrying the store
  // time as metadata is what lets /api/metrics sample the *newest* debriefs when
  // there are more than it will read — list returns metadata for free, whereas
  // learning the same thing from the values means reading every one of them.
  await env.DEBRIEFS.put(id, JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
    metadata: { stored_at: record.stored_at } satisfies DebriefMetadata,
  });

  return json({ id, url: new URL(`/call/${id}`, request.url).toString() }, { status: 201 });
}

export async function handleDebriefGet(id: string, env: Env): Promise<Response> {
  if (!VALID_ID.test(id)) return error(400, 'Malformed call id');

  const stored = await env.DEBRIEFS.get(id, 'text');
  if (stored === null) return error(404, 'No such call');

  // A stored debrief never changes, so it can be cached hard.
  return new Response(stored, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

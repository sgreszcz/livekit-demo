/**
 * Debrief storage: a call's envelope log, saved and replayable at /call/:id.
 *
 * Three writers post here:
 *
 *  * the Python agent, bearer-authenticated, posting the FINAL record when a
 *    call ends — the canonical copy;
 *  * the same agent, bearer-authenticated, PUTting a CHECKPOINT every few
 *    seconds while the call is still running;
 *  * the browser, which assembles its own copy live and holds no credential.
 *
 * The browser path is treated as untrusted input: hard size cap, recursive
 * shape validation, and a bounded message count before anything reaches KV. It
 * is stored so a visitor's share link keeps working, and it is marked
 * `source: "browser"` — which /api/metrics uses to keep it out of the fleet
 * aggregates entirely. Anyone on the internet can POST here; nobody but the
 * agent can move the dashboard.
 *
 * ## Why checkpoints exist
 *
 * The final POST used to be the only write, made from the agent's job-shutdown
 * callback — and the job does not shut down when the call ends. It shuts down
 * when the ROOM closes, which can be minutes or hours later, or never. A
 * production trace: a SIP caller hung up at 10:47:32, an observer was still
 * watching from the front page, and eleven minutes later the process had not
 * exited and no debrief existed. Any deploy rollout in that window loses the
 * call outright. Checkpoints mean a call that dies mid-flight still leaves a
 * record, and they are what lets /api/metrics show calls that are happening
 * right now instead of only calls that have finished.
 *
 * ## Two key spaces, deliberately non-overlapping
 *
 *  * A final debrief lands under a random 16-character base62 id. That id is
 *    the share link and is the ONLY thing guarding the transcript, so it is
 *    treated as a secret (see `handleDebriefGet`).
 *  * A checkpoint lands under `chk_<hash of call_id>`, so repeated PUTs for one
 *    call overwrite rather than accumulate. The underscore is what keeps the two
 *    spaces apart: `VALID_ID` rejects it, so a checkpoint can never be fetched
 *    through the public share route. Checkpoints are telemetry, not artefacts.
 */

import type { Env } from './env';
import { error, json, randomId, timingSafeEqual } from './http';
import { redactDeep } from './rooms';

export const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 4000;
const TTL_SECONDS = 90 * 24 * 60 * 60;
/**
 * Checkpoints expire far sooner than finished calls. A checkpoint is only
 * interesting until the call it describes ends, and a call that never produces
 * a final debrief — an orphaned room, a killed process — should stop being
 * reported as "in progress" the same day rather than sit in the fleet numbers
 * for three months.
 */
const CHECKPOINT_TTL_SECONDS = 6 * 60 * 60;
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
  // Browser-sourced WebRTC transport samples (schema v1.1). Its omission here
  // was silently stripping every transport envelope out of every stored
  // debrief, which is why a shared call always claimed the network panel was
  // "not recorded on this call" — the browser had recorded it and this filter
  // threw it away on the way to KV.
  'transport',
]);

/**
 * Envelope fields that survive to storage. Anything else a writer invents is
 * dropped rather than persisted.
 *
 * The allowlist stops at the envelope: the payload is validated structurally
 * (depth, size, dangerous keys) but not field by field. Enumerating payload
 * fields here would put a second copy of docs/TELEMETRY-SCHEMA.md in a second
 * language, and the two would disagree on the first schema change. The viewer
 * already validates every payload field before rendering it.
 */
const ENVELOPE_FIELDS = ['v', 'type', 'ts', 'speech_id', 'payload'] as const;

/**
 * Keys that are never legitimate data and are refused wherever they appear.
 *
 * The Worker itself is not at risk — it only ever `JSON.stringify`s this back
 * out. The risk is *persistence*: a stored `__proto__` key is handed to the SPA
 * later, and any `merge`-shaped code path there turns a stored record into a
 * prototype-pollution gadget with a stable public URL. Refusing them at the
 * store is the one place the fix applies to every reader.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Structural limits on a payload. The 256 KB body cap alone does not bound
 * shape: a few hundred kilobytes of `[[[[[…]]]]]` is cheap to send and can be
 * expensive to walk, and deep nesting has no legitimate use in this schema —
 * the deepest real payload is a `turn` with `llm.chain[]`, about four levels.
 */
const MAX_DEPTH = 12;
/** Nodes allowed in one payload. The deepest real payload is a few dozen. */
const MAX_NODES = 5000;
/**
 * Nodes allowed across a whole body. The 256 KB cap is the real bound — no
 * conforming body can hold more nodes than this — so it is a backstop against
 * a pathological shape, not a quota anybody legitimate approaches. Named, so it
 * cannot silently disagree with `MAX_NODES` the way an inline `* 20` did.
 */
const MAX_TOTAL_NODES = 100_000;

const VALID_ID = /^[A-Za-z0-9]{1,32}$/;

const SCHEMA_VERSION = 1;

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
  /** Whether the agent posted this, or a browser did. Load-bearing: only
   *  `agent` records are aggregated by /api/metrics. */
  source: 'agent' | 'browser';
  /** True for a checkpoint written while the call was still running. */
  in_progress: boolean;
}

/**
 * Three outcomes, not two: a request that presents no credential is a browser
 * and is stored as one, but a request that presents a credential which does not
 * verify is a configuration failure and must be told so.
 *
 * The old code collapsed the last two into "browser". That was harmless while
 * `source` was a debugging note; it stopped being harmless when /api/metrics
 * began aggregating agent records only. A single typo in `DEBRIEF_TOKEN` would
 * silently reclassify every real call as untrusted and empty the dashboard,
 * with a 201 returned on every upload and nothing anywhere saying why.
 */
type Auth = 'agent' | 'anonymous' | 'invalid';

async function authenticate(request: Request, env: Env): Promise<Auth> {
  const header = request.headers.get('authorization');
  if (!header) return 'anonymous';

  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return 'invalid';
  if (!env.DEBRIEF_TOKEN) return 'invalid';
  return (await timingSafeEqual(value, env.DEBRIEF_TOKEN)) ? 'agent' : 'invalid';
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

/** Node budget for one `sanitize` walk, shared across the whole structure. */
interface Budget {
  nodes: number;
}

/**
 * Returned when a value is not merely unstorable but *structurally illegal* —
 * too deep, past the node budget, or carrying a forbidden key.
 *
 * The distinction matters and is the whole reason this is not just `undefined`:
 *
 *  * An unstorable SCALAR (a NaN, a function) is dropped and the record keeps
 *    going. One odd extra field should not cost the measurements beside it.
 *  * An illegal STRUCTURE rejects everything containing it, all the way up to
 *    the envelope. Silently truncating an over-deep payload would store a
 *    record that differs from what the writer sent while still looking valid,
 *    and a reader has no way to tell. Refusing it is the honest answer.
 */
export const REJECT = Symbol('reject');

/**
 * Rebuild a JSON value, dropping or rejecting anything unacceptable.
 *
 * Rebuilding rather than validating-in-place is the point: whatever comes out
 * is a structure this function constructed, so there is no path by which an
 * exotic input object reaches KV because a check was written slightly wrong.
 */
export function sanitize(value: unknown, budget: Budget, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REJECT;
  if (budget.nodes <= 0) return REJECT;
  budget.nodes -= 1;

  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value;
    case 'number':
      // NaN and the infinities serialise to `null` and would be indistinguish-
      // able from a genuinely absent field on the way back out.
      return Number.isFinite(value) ? value : undefined;
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint: not JSON, not storable.
      return undefined;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const clean = sanitize(item, budget, depth + 1);
      // An array with a hole in it is not the array that was sent, and array
      // position is meaningful in this schema (`llm.chain[]` is per-invocation
      // and in order), so a bad element condemns the array.
      if (clean === REJECT || clean === undefined) return REJECT;
      out.push(clean);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) return REJECT;
    const clean = sanitize(item, budget, depth + 1);
    if (clean === REJECT) return REJECT;
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One envelope, rebuilt from the allowlist, or null if it is not an envelope.
 *
 * `payload` must be a plain object. An array passed the old `typeof === 'object'
 * && !== null` test and was stored as an envelope with a list where every reader
 * expects a record.
 */
export function sanitizeEnvelope(message: unknown, budget: Budget): Record<string, unknown> | null {
  const candidate = plainObject(message);
  if (!candidate) return null;

  if (candidate.v !== SCHEMA_VERSION) return null;
  if (typeof candidate.type !== 'string' || !ENVELOPE_TYPES.has(candidate.type)) return null;
  if (typeof candidate.ts !== 'number' || !Number.isFinite(candidate.ts)) return null;
  if (!plainObject(candidate.payload)) return null;

  const payload = sanitize(candidate.payload, budget);
  if (payload === REJECT || payload === undefined) return null;

  const out: Record<string, unknown> = {};
  for (const field of ENVELOPE_FIELDS) {
    if (!(field in candidate)) continue;
    if (field === 'payload') {
      out.payload = payload;
      continue;
    }
    const clean = sanitize(candidate[field], budget);
    if (clean === REJECT) return null;
    if (clean !== undefined) out[field] = clean;
  }
  return out;
}

/**
 * Strip caller phone numbers out of a whole debrief.
 *
 * SIP room names embed a phone number, and a debrief is echoed verbatim to
 * anyone holding its share link. This used to rewrite exactly two fields —
 * `meta.room` and the `call_meta` payload's `room` — which covered where the
 * room name lives *today* and nothing else. A SIP participant identity, a
 * `metadata` blob, an attribute, or a caller reading their own number into a
 * transcript were all the same leak under a different key, and an anonymous
 * browser can mint a public link carrying any of them.
 *
 * So it now scrubs by shape, over every string in the record, on the way in AND
 * on the way out — records stored before this existed are still in KV and still
 * being fetched.
 */
export function redactRooms(meta: unknown, messages: unknown[]): { meta: unknown; messages: unknown[] } {
  return { meta: redactDeep(meta), messages: redactDeep(messages) as unknown[] };
}

export function validate(raw: string): StoredDebrief | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const record = plainObject(parsed);
  if (!record) return null;

  if (!Array.isArray(record.messages)) return null;
  if (record.messages.length === 0 || record.messages.length > MAX_MESSAGES) return null;

  const budget: Budget = { nodes: MAX_TOTAL_NODES };
  const messages = record.messages
    .map((message) => sanitizeEnvelope(message, budget))
    .filter((message): message is Record<string, unknown> => message !== null);
  if (messages.length === 0) return null;

  // A meta block that is itself illegal costs the meta block, not the call: the
  // envelopes are the recording, and `meta` is a convenience copy of the first
  // one of them.
  const cleanedMeta = sanitize(plainObject(record.meta) ?? null, { nodes: MAX_NODES });
  const meta = cleanedMeta === REJECT || cleanedMeta === undefined ? null : cleanedMeta;
  const redacted = redactRooms(meta, messages);

  return {
    call_id: typeof record.call_id === 'string' ? record.call_id.slice(0, 128) : 'unknown',
    meta: redacted.meta,
    ended_at:
      typeof record.ended_at === 'number' && Number.isFinite(record.ended_at)
        ? record.ended_at
        : Date.now() / 1000,
    messages: redacted.messages,
    stored_at: Date.now() / 1000,
    source: 'browser',
    in_progress: false,
  };
}

/**
 * The KV key a call's checkpoints share.
 *
 * Hashed rather than used raw so the key space is fixed-width and free of
 * whatever a `call_id` might contain, and prefixed with an underscore-bearing
 * tag so it can never be reached through `/api/debrief/:id` — see `VALID_ID`.
 */
export async function checkpointKey(callId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(callId));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `chk_${hex.slice(0, 32)}`;
}

/**
 * PUT /api/debrief — an in-flight checkpoint, keyed by call.
 *
 * Bearer-only. A checkpoint is not a share link and returns no id: it exists so
 * that a call which never reaches its final POST is still visible, and so the
 * fleet dashboard can show calls in progress. Repeated PUTs for the same
 * `call_id` overwrite in place.
 */
export async function handleDebriefPut(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth !== 'agent') {
    return error(401, 'Checkpoints require the agent bearer token');
  }

  const read = await readCappedBody(request);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? error(413, 'Debrief payload too large')
      : error(400, 'Could not read the debrief payload');
  }

  const record = validate(read.body);
  if (!record) return error(400, 'Not a valid debrief payload');
  if (record.call_id === 'unknown') {
    // Without a call id there is nothing stable to key on, and storing it under
    // a random one would make every checkpoint a new "call" in the fleet count.
    return error(400, 'A checkpoint must carry a call_id');
  }

  record.source = 'agent';
  record.in_progress = true;

  await env.DEBRIEFS.put(await checkpointKey(record.call_id), JSON.stringify(record), {
    expirationTtl: CHECKPOINT_TTL_SECONDS,
    metadata: { stored_at: record.stored_at } satisfies DebriefMetadata,
  });

  return json({ ok: true, in_progress: true });
}

export async function handleDebriefPost(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (auth === 'invalid') {
    return error(401, 'Bearer token not accepted');
  }

  const read = await readCappedBody(request);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? error(413, 'Debrief payload too large')
      : error(400, 'Could not read the debrief payload');
  }

  const record = validate(read.body);
  if (!record) return error(400, 'Not a valid debrief payload');

  record.source = auth === 'agent' ? 'agent' : 'browser';
  record.in_progress = false;

  const id = randomId(ID_LENGTH);
  // The ids are random, so a KV list is in no useful order. Carrying the store
  // time as metadata is what lets /api/metrics sample the *newest* debriefs when
  // there are more than it will read — list returns metadata for free, whereas
  // learning the same thing from the values means reading every one of them.
  await env.DEBRIEFS.put(id, JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
    metadata: { stored_at: record.stored_at } satisfies DebriefMetadata,
  });

  // The call is over, so its checkpoint is superseded. /api/metrics also folds
  // the two together by call_id, because KV list is eventually consistent and
  // will keep returning this key for a while yet — the delete is the tidy-up,
  // the fold is what makes the number correct in the meantime.
  if (auth === 'agent' && record.call_id !== 'unknown') {
    try {
      await env.DEBRIEFS.delete(await checkpointKey(record.call_id));
    } catch {
      // A failed tidy-up must not fail an upload that already succeeded.
    }
  }

  return json({ id, url: new URL(`/call/${id}`, request.url).toString() }, { status: 201 });
}

export async function handleDebriefGet(id: string, env: Env): Promise<Response> {
  if (!VALID_ID.test(id)) return error(400, 'Malformed call id');

  const stored = await env.DEBRIEFS.get(id, 'text');
  if (stored === null) return error(404, 'No such call');

  // Records written before room names were redacted are still in KV and still
  // being fetched, so the scrub is applied on the way out too rather than only
  // to new writes.
  let body = stored;
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    if (Array.isArray(parsed.messages)) {
      const redacted = redactRooms(parsed.meta, parsed.messages);
      body = JSON.stringify({ ...parsed, meta: redacted.meta, messages: redacted.messages });
    }
  } catch {
    // Written by this Worker with JSON.stringify, so this is unreachable; if it
    // ever happens the record is not something to hand back verbatim.
    return error(500, 'Stored call is unreadable');
  }

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      /*
       * The id IS the credential. There is no other check on this route, so a
       * share link is a bearer token for a call transcript.
       *
       * It used to be served `public, max-age=31536000, immutable`, which told
       * every shared proxy and CDN on the path to keep a transcript for a year —
       * outliving the 90-day KV TTL, so deleting the record would not have
       * un-shared it. `private, no-store` keeps the copy in exactly one place:
       * the browser the visitor opened it in.
       */
      'cache-control': 'private, no-store',
      // Without this the id travels in the Referer of every outbound link and
      // image on the replay page.
      'referrer-policy': 'no-referrer',
    },
  });
}

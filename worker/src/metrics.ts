/**
 * Fleet metrics: what every stored debrief adds up to.
 *
 * The cockpit is a flight recorder for one call. This endpoint is the other
 * half — the same recordings, read across the whole fleet, in the shape a
 * Grafana panel wants (see `grafana/dashboard.json`). It is derived data only:
 * every number here comes from envelopes already stored, and no transcript,
 * room name or call id is ever emitted.
 *
 * Three things are easy to get wrong and are handled deliberately:
 *
 *  * **`usage` envelopes are running totals**, re-emitted after every turn. The
 *    last one in a call is that call's bill; adding them all up multiplies a
 *    ten-turn call's cost by about six.
 *  * **`turn` envelopes are partial** and merge by `turn_id`, last-write-wins,
 *    exactly as the cockpit merges them. Treating each envelope as a turn would
 *    count a single exchange three or four times.
 *  * **KV ids are random**, so a list is in no useful order. The read cap
 *    therefore samples by the `stored_at` metadata written at put time, newest
 *    first, and says so in the response rather than pretending to be complete.
 */

import type { DebriefMetadata, StoredDebrief } from './debrief';
import type { Env } from './env';

/** KV list ceiling for one page. One page is all this endpoint asks for. */
export const MAX_KEYS = 1000;
/**
 * Debriefs actually read per request. Each is a KV read costing money and
 * latency; 200 is enough for a stable fleet picture and keeps a cold response
 * inside a second or so. Beyond it the response is flagged `sampled: true`.
 */
export const READ_CAP = 200;
/** How many KV reads are in flight at once. */
const READ_CONCURRENCY = 25;
/** Days of history in the calls-per-day series. */
const HISTORY_DAYS = 14;
/** The latency budget a turn is "over" — matches the cockpit's own threshold. */
export const BUDGET_SECONDS = 1.0;
/** Isolate-local memo lifetime, matching the cache-control max-age. */
export const MEMO_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

interface MergedTurn {
  eou_delay: number | null;
  llm_ttft: number | null;
  tts_ttfb: number | null;
  total: number | null;
  degraded: boolean;
}

/** One call, reduced to numbers. Nothing textual survives this step. */
interface CallSummary {
  entry: string;
  source: string;
  /** Unix seconds the call ended — the bucket it lands in on the day series. */
  ended_at: number;
  duration_seconds: number | null;
  turns: number;
  completed: MergedTurn[];
  barge_ins: number;
  prompt_tokens: number;
  completion_tokens: number;
  stt_seconds: number;
  tts_characters: number;
  cost_usd: number;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reduce one stored debrief to its numbers, or null if it is not a debrief.
 *
 * Everything is optional as far as this function is concerned: a debrief posted
 * by an older agent, or truncated, still contributes whatever it does carry.
 * Only a payload with no recognisable structure at all is dropped.
 */
export function summariseCall(raw: string): CallSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const stored = record(parsed);
  if (!stored || !Array.isArray(stored.messages)) return null;

  const debrief = stored as unknown as StoredDebrief;
  const meta = record(debrief.meta) ?? {};
  const started_at = finite(meta.started_at);
  const ended_at = finite(debrief.ended_at) ?? finite(debrief.stored_at) ?? Date.now() / 1000;

  const turns = new Map<string, MergedTurn>();
  const bargedTurns = new Set<string>();
  let usage: Record<string, unknown> | null = null;

  for (const message of stored.messages) {
    const envelope = record(message);
    if (!envelope) continue;
    const payload = record(envelope.payload);
    if (!payload) continue;

    if (envelope.type === 'turn' && typeof payload.turn_id === 'string') {
      const turn = turns.get(payload.turn_id) ?? {
        eou_delay: null,
        llm_ttft: null,
        tts_ttfb: null,
        total: null,
        degraded: false,
      };
      const eou = record(payload.eou);
      const llm = record(payload.llm);
      const tts = record(payload.tts);
      // Last write wins per field, the same merge the cockpit does — a turn
      // arrives as three or four partial envelopes, never as one complete one.
      if (eou) turn.eou_delay = finite(eou.end_of_utterance_delay) ?? turn.eou_delay;
      if (llm) turn.llm_ttft = finite(llm.ttft) ?? turn.llm_ttft;
      if (tts) turn.tts_ttfb = finite(tts.ttfb) ?? turn.tts_ttfb;
      turn.total = finite(payload.total_response_latency) ?? turn.total;
      if (typeof payload.degraded === 'boolean') turn.degraded = payload.degraded;
      turns.set(payload.turn_id, turn);
    } else if (envelope.type === 'interruption' && payload.kind === 'barge_in') {
      // Counted per turn, not per envelope: a re-published interruption for a
      // turn already flagged is the same barge-in.
      if (typeof payload.turn_id === 'string') bargedTurns.add(payload.turn_id);
    } else if (envelope.type === 'usage') {
      usage = payload;
    }
  }

  const duration =
    started_at !== null && ended_at - started_at > 0 && ended_at - started_at < 12 * 60 * 60
      ? ended_at - started_at
      : null;

  return {
    entry: typeof meta.entry === 'string' ? meta.entry : 'unknown',
    source: debrief.source === 'agent' || debrief.source === 'browser' ? debrief.source : 'unknown',
    ended_at,
    duration_seconds: duration,
    turns: turns.size,
    completed: [...turns.values()].filter((turn) => turn.total !== null),
    barge_ins: bargedTurns.size,
    prompt_tokens: finite(usage?.llm_prompt_tokens) ?? 0,
    completion_tokens: finite(usage?.llm_completion_tokens) ?? 0,
    stt_seconds: finite(usage?.stt_audio_seconds) ?? 0,
    tts_characters: finite(usage?.tts_characters) ?? 0,
    cost_usd: finite(usage?.est_cost_usd) ?? 0,
  };
}

/** Nearest-rank percentile over an already-sorted ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function ms(seconds: number): number {
  return Math.round(seconds * 1000);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : round((part / whole) * 100, 1);
}

/** UTC midnight of the day a unix-seconds timestamp falls in, in epoch ms. */
function dayBucket(unixSeconds: number): number {
  return Math.floor((unixSeconds * 1000) / DAY_MS) * DAY_MS;
}

/**
 * Fold call summaries into the response body.
 *
 * Split out from the KV plumbing so the arithmetic can be tested against
 * synthetic debriefs without a Worker or a namespace.
 */
export function aggregate(
  calls: CallSummary[],
  options: { sampled: boolean; unreadable: number; now?: number },
): Record<string, unknown> {
  const now = options.now ?? Date.now();
  const completed = calls.flatMap((call) => call.completed);
  const totals = completed
    .map((turn) => turn.total)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  const byEntry = new Map<string, number>();
  const bySource = new Map<string, number>();
  for (const call of calls) {
    byEntry.set(call.entry, (byEntry.get(call.entry) ?? 0) + 1);
    bySource.set(call.source, (bySource.get(call.source) ?? 0) + 1);
  }

  // Fourteen fixed buckets ending today, so a quiet day is a zero and not a
  // gap — a Grafana series with holes in it reads as an outage.
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const perDay = new Map<number, number>();
  for (let i = HISTORY_DAYS - 1; i >= 0; i -= 1) perDay.set(today - i * DAY_MS, 0);
  for (const call of calls) {
    const bucket = dayBucket(call.ended_at);
    if (perDay.has(bucket)) perDay.set(bucket, (perDay.get(bucket) ?? 0) + 1);
  }

  const durations = calls
    .map((call) => call.duration_seconds)
    .filter((value): value is number => value !== null);

  const stage = (pick: (turn: MergedTurn) => number | null): number =>
    ms(mean(completed.map(pick).filter((value): value is number => value !== null)));

  const sum = (pick: (call: CallSummary) => number): number =>
    calls.reduce((total, call) => total + pick(call), 0);

  return {
    generated_at: Math.round(now / 1000),
    /** True when there are more debriefs stored than this response read. */
    sampled: options.sampled,
    calls_read: calls.length,
    calls_unreadable: options.unreadable,

    calls_total: calls.length,
    calls_entry_browser: byEntry.get('browser') ?? 0,
    calls_entry_sip: byEntry.get('sip') ?? 0,
    calls_entry_unknown: byEntry.get('unknown') ?? 0,
    calls_source_agent: bySource.get('agent') ?? 0,
    calls_source_browser: bySource.get('browser') ?? 0,

    calls_per_day: [...perDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({
        time,
        date: new Date(time).toISOString().slice(0, 10),
        value,
      })),

    turns_total: sum((call) => call.turns),
    turns_completed: completed.length,
    avg_turns_per_call: round(mean(calls.map((call) => call.turns)), 2),
    avg_call_seconds: round(mean(durations), 1),

    latency_count: totals.length,
    latency_avg_ms: ms(mean(totals)),
    latency_p50_ms: ms(percentile(totals, 50)),
    latency_p95_ms: ms(percentile(totals, 95)),
    latency_max_ms: totals.length === 0 ? 0 : ms(totals[totals.length - 1]),

    stage_eou_avg_ms: stage((turn) => turn.eou_delay),
    stage_llm_ttft_avg_ms: stage((turn) => turn.llm_ttft),
    stage_tts_ttfb_avg_ms: stage((turn) => turn.tts_ttfb),
    // The same three numbers as rows, which is what a bar gauge binds to.
    stages: [
      { stage: 'EOU delay', ms: stage((turn) => turn.eou_delay) },
      { stage: 'LLM TTFT', ms: stage((turn) => turn.llm_ttft) },
      { stage: 'TTS TTFB', ms: stage((turn) => turn.tts_ttfb) },
    ],

    over_budget_pct: pct(
      totals.filter((value) => value > BUDGET_SECONDS).length,
      totals.length,
    ),
    degraded_pct: pct(completed.filter((turn) => turn.degraded).length, completed.length),
    barge_in_total: sum((call) => call.barge_ins),

    tokens_prompt: sum((call) => call.prompt_tokens),
    tokens_completion: sum((call) => call.completion_tokens),
    stt_seconds: round(sum((call) => call.stt_seconds), 1),
    tts_characters: sum((call) => call.tts_characters),
    est_cost_usd: round(sum((call) => call.cost_usd), 4),
  };
}

async function readAll(env: Env, keys: string[]): Promise<{ calls: CallSummary[]; unreadable: number }> {
  const calls: CallSummary[] = [];
  let unreadable = 0;

  for (let i = 0; i < keys.length; i += READ_CONCURRENCY) {
    const batch = await Promise.all(
      keys.slice(i, i + READ_CONCURRENCY).map((key) => env.DEBRIEFS.get(key, 'text')),
    );
    for (const stored of batch) {
      // A null is a key that expired between the list and the read: gone, not
      // corrupt, and not worth reporting as damage.
      if (stored === null) continue;
      const summary = summariseCall(stored);
      if (summary === null) unreadable += 1;
      else calls.push(summary);
    }
  }

  return { calls, unreadable };
}

/** Compute the fleet aggregate from KV. Exported for tests; the route memoizes it. */
export async function collectMetrics(env: Env): Promise<Record<string, unknown>> {
  const listed = await env.DEBRIEFS.list<DebriefMetadata>({ limit: MAX_KEYS });

  // Newest first, so the sample under a read cap is the recent fleet rather
  // than an arbitrary slice of base62. Keys stored before metadata was written
  // sort last — they are also the oldest, which is the same answer.
  const keys = [...listed.keys]
    .sort((a, b) => (b.metadata?.stored_at ?? 0) - (a.metadata?.stored_at ?? 0))
    .map((key) => key.name);

  const { calls, unreadable } = await readAll(env, keys.slice(0, READ_CAP));
  return aggregate(calls, {
    sampled: keys.length > READ_CAP || !listed.list_complete,
    unreadable,
  });
}

let memo: { at: number; body: string } | null = null;

/** Drop the isolate memo. Tests only — a Worker has no reason to call this. */
export function resetMetricsMemo(): void {
  memo = null;
}

export async function handleMetricsGet(env: Env): Promise<Response> {
  const now = Date.now();
  if (memo === null || now - memo.at > MEMO_MS) {
    memo = { at: now, body: JSON.stringify(await collectMetrics(env)) };
  }

  return new Response(memo.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Public and short-lived: the numbers move only as calls finish, and a
      // Grafana stack scraping every 30 s should be answered by the edge cache,
      // not by a fresh fan-out over KV.
      'cache-control': 'public, max-age=60',
      // Read-only, no credentials, no PII — a Grafana instance on any origin
      // (including Grafana Cloud's browser-side Infinity queries) can read it.
      'access-control-allow-origin': '*',
    },
  });
}

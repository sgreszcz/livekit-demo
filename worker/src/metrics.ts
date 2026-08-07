/**
 * Fleet metrics: what every stored debrief adds up to.
 *
 * The cockpit is a flight recorder for one call. This endpoint is the other
 * half — the same recordings, read across the whole fleet, in the shape a
 * Grafana panel wants (see `grafana/dashboard.json`). It is derived data only:
 * every number here comes from envelopes already stored, and no transcript,
 * room name or call id is ever emitted.
 *
 * Six things are easy to get wrong and are handled deliberately:
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
 *  * **`ended_at` is when the agent's JOB stopped, not when the CALL ended** —
 *    see `callDuration` below. This is the single largest source of nonsense in
 *    this file's history and the reason `avg_call_seconds` once read 536.8.
 *  * **One call can be stored more than once**: the agent checkpoints while the
 *    call is live and posts a final debrief when it ends, and a browser may post
 *    its own copy too. Records are folded by `call_id` before anything is
 *    counted — see `dedupe`.
 *  * **Anonymous writes must not move these numbers.** `POST /api/debrief` takes
 *    unauthenticated bodies so a browser can keep its own share link working,
 *    and absent CORS headers do not stop a cross-site no-CORS POST. Only records
 *    the Worker itself marked `source: "agent"` — meaning the writer proved it
 *    held the bearer token — are aggregated. The agent is the authoritative
 *    observer anyway: it is the only participant present on every call,
 *    including phone-only SIP calls where no browser exists at all.
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

/**
 * How much silence at the end of a call still counts as part of the call.
 *
 * This is the fix for `avg_call_seconds: 536.8`, and it is worth stating exactly
 * what went wrong. `ended_at` is stamped when the agent's *job* shuts down, and
 * the job does not shut down when the caller hangs up — it shuts down when the
 * ROOM closes. A room stays open while anyone is still in it, including an
 * observer watching from the front page, or a browser tab someone left open and
 * walked away from. So `ended_at − started_at` measures "how long the room was
 * held open", which is not what any panel labelled "average call length" claims
 * to show.
 *
 * The real recordings say so plainly. Across ten stored calls the gap between
 * the last telemetry envelope and `ended_at` was 22–27 seconds on every call
 * that ended normally — that is LiveKit's own teardown — and 71 s, 131 s, 183 s
 * and **4366 s** on calls that were simply abandoned. That last one: 10.5
 * seconds of conversation inside a 73-minute room. On its own it contributed
 * 437 of the 536.8 second "average".
 *
 * So the call is treated as ending at its last telemetry envelope, plus a grace
 * long enough to cover the observed teardown. Thirty seconds keeps every
 * normally-ended call's duration untouched and truncates only the tails that are
 * measuring an empty room.
 */
export const IDLE_TAIL_SECONDS = 30;

/**
 * Absolute ceiling on a credible call duration. A demo call that claims to have
 * run longer than this is a clock problem, not a long conversation, and the old
 * twelve-hour guard was loose enough to admit every real outlier this endpoint
 * has ever seen.
 */
export const MAX_CALL_SECONDS = 2 * 60 * 60;

/*
 * Per-field magnitude bounds.
 *
 * `Number.isFinite` is not a range check: `1e308` is perfectly finite, and two
 * stored records carrying it sum to `Infinity`. `JSON.stringify` then emits
 * `null`, every downstream panel binds to a null, and the dashboard breaks in a
 * way that looks like an outage rather than like bad input. Since anyone could
 * once POST a debrief anonymously, that was reachable from the open internet.
 *
 * The bounds below are physical rather than defensive: they are what these
 * quantities can actually be on a voice call, generously rounded up.
 */
/** A single turn's latency, in seconds. A minute of TTFB is already absurd. */
const MAX_TURN_SECONDS = 600;
/** Tokens, per call, either direction. */
const MAX_TOKENS = 1e9;
/** Audio seconds, per call. */
const MAX_AUDIO_SECONDS = 1e6;
/** Synthesised characters, per call. */
const MAX_CHARACTERS = 1e9;
/** Estimated dollars, per call. */
const MAX_COST_USD = 1e6;

const DAY_MS = 24 * 60 * 60 * 1000;

interface MergedTurn {
  eou_delay: number | null;
  llm_ttft: number | null;
  tts_ttfb: number | null;
  total: number | null;
  degraded: boolean;
}

/** One call, reduced to numbers. Nothing textual survives this step. */
export interface CallSummary {
  entry: string;
  source: string;
  /**
   * The call this record describes, or null when the record did not name one.
   * Used only to fold checkpoints and re-posts together — it never leaves this
   * module. A null groups with nothing, so an unidentifiable record is counted
   * once, on its own.
   */
  call_id: string | null;
  /** A checkpoint posted mid-call, rather than a finished call's debrief. */
  in_progress: boolean;
  /** Unix seconds the record was written — the tie-break when folding. */
  stored_at: number;
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

/**
 * A finite number within a physically plausible range, or null.
 *
 * Out-of-range is dropped rather than clamped: clamping invents a measurement
 * that nothing observed, and a silently clamped `1e308` would still drag an
 * average to the ceiling. A dropped field simply does not contribute.
 */
function bounded(value: unknown, max: number, min = 0): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value >= min && value <= max ? value : null;
}

/** A timestamp that could plausibly be a unix time in seconds. */
function timestamp(value: unknown): number | null {
  // Rejects milliseconds-by-mistake (1.7e12) and pre-epoch nonsense alike.
  return bounded(value, 4e9, 0);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * How long the call actually lasted, or null if it cannot be known.
 *
 * See `IDLE_TAIL_SECONDS` for why this is not simply `ended_at − started_at`.
 */
export function callDuration(
  started_at: number | null,
  ended_at: number,
  last_activity_at: number | null,
): number | null {
  if (started_at === null) return null;

  /*
   * A call with no envelopes at all has no activity to trim against, so its
   * wall clock is the only evidence there is.
   *
   * `last_activity_at` is clamped to at least `started_at` because an envelope
   * timestamped BEFORE the call began — a clock step, a replayed fixture — would
   * otherwise pull the effective end backwards and shorten, or entirely void, a
   * call that really happened. Trimming is only ever allowed to remove trailing
   * silence, never to rewrite the start.
   */
  const effectiveEnd =
    last_activity_at === null
      ? ended_at
      : Math.min(ended_at, Math.max(last_activity_at, started_at) + IDLE_TAIL_SECONDS);

  const duration = effectiveEnd - started_at;
  return duration > 0 && duration <= MAX_CALL_SECONDS ? duration : null;
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
  const started_at = timestamp(meta.started_at);
  const stored_at = timestamp(debrief.stored_at) ?? 0;
  /*
   * `stored_at` falls back to 0, which is not null — so a nullish chain ending
   * in `Date.now()` could never reach its last branch, and a record carrying
   * neither timestamp dated itself to 1970 and silently dropped out of the
   * fourteen-day series while still counting in the totals. Written out as an
   * explicit zero check so the fallback is reachable and obvious.
   */
  const claimed = timestamp(debrief.ended_at) ?? stored_at;
  const ended_at = claimed === 0 ? Date.now() / 1000 : claimed;

  const turns = new Map<string, MergedTurn>();
  const bargedTurns = new Set<string>();
  let usage: Record<string, unknown> | null = null;
  let last_activity_at: number | null = null;

  for (const message of stored.messages) {
    const envelope = record(message);
    if (!envelope) continue;

    // Tracked across every envelope type, not just turns: the last thing that
    // happened on the call is the last thing that happened, whether that was a
    // measurement, a transcript or a state change.
    const ts = timestamp(envelope.ts);
    if (ts !== null && (last_activity_at === null || ts > last_activity_at)) {
      last_activity_at = ts;
    }

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
      if (eou) {
        turn.eou_delay = bounded(eou.end_of_utterance_delay, MAX_TURN_SECONDS) ?? turn.eou_delay;
      }
      if (llm) turn.llm_ttft = bounded(llm.ttft, MAX_TURN_SECONDS) ?? turn.llm_ttft;
      if (tts) turn.tts_ttfb = bounded(tts.ttfb, MAX_TURN_SECONDS) ?? turn.tts_ttfb;
      turn.total = bounded(payload.total_response_latency, MAX_TURN_SECONDS) ?? turn.total;
      // Absent never clears a set flag: the agent republishes `degraded` alone
      // when a late segment turns out to have been injected, and the schema is
      // explicit that a turn is degraded if ANY stage of it was.
      // OR, never assignment. The schema is explicit that a turn is degraded if
      // ANY stage of it was, and the agent republishes the flag on its own when
      // a late segment turns out to have been injected. A plain assignment let a
      // later envelope carrying `false` clear a `true` that had already been
      // established — losing exactly the turns chaos mode exists to show.
      if (payload.degraded === true) turn.degraded = true;
      turns.set(payload.turn_id, turn);
    } else if (envelope.type === 'interruption' && payload.kind === 'barge_in') {
      // Counted per turn, not per envelope: a re-published interruption for a
      // turn already flagged is the same barge-in.
      if (typeof payload.turn_id === 'string') bargedTurns.add(payload.turn_id);
    } else if (envelope.type === 'usage') {
      usage = payload;
    }
  }

  const call_id =
    typeof debrief.call_id === 'string' && debrief.call_id !== '' && debrief.call_id !== 'unknown'
      ? debrief.call_id
      : null;

  return {
    entry: typeof meta.entry === 'string' ? meta.entry : 'unknown',
    source: debrief.source === 'agent' || debrief.source === 'browser' ? debrief.source : 'unknown',
    call_id,
    in_progress: debrief.in_progress === true,
    stored_at,
    ended_at,
    duration_seconds: callDuration(started_at, ended_at, last_activity_at),
    turns: turns.size,
    completed: [...turns.values()].filter((turn) => turn.total !== null),
    barge_ins: bargedTurns.size,
    prompt_tokens: bounded(usage?.llm_prompt_tokens, MAX_TOKENS) ?? 0,
    completion_tokens: bounded(usage?.llm_completion_tokens, MAX_TOKENS) ?? 0,
    stt_seconds: bounded(usage?.stt_audio_seconds, MAX_AUDIO_SECONDS) ?? 0,
    tts_characters: bounded(usage?.tts_characters, MAX_CHARACTERS) ?? 0,
    cost_usd: bounded(usage?.est_cost_usd, MAX_COST_USD) ?? 0,
  };
}

/**
 * Fold every stored record of the same call into the one that describes it best.
 *
 * A single call can leave several records behind. The agent checkpoints every
 * few seconds while the call is live so that a call which dies mid-flight — a
 * dropped SIP leg, a worker redeploy — still leaves something behind, and it
 * posts a final debrief when the call ends. The final POST deletes the
 * checkpoint, but KV listing is eventually consistent, so for up to a minute
 * afterwards the deleted key can still come back from `list`. Without this fold
 * the same call would be counted twice, once as live and once as finished, and
 * `calls_in_progress` would never settle to zero.
 *
 * Preference order: a finished record beats a checkpoint; between two of a kind,
 * the one written most recently wins. Records with no `call_id` are folded with
 * nothing — they are counted individually, which is the conservative answer when
 * there is no evidence they describe the same call.
 */
export function dedupe(calls: CallSummary[]): CallSummary[] {
  const best = new Map<string, CallSummary>();
  const ungrouped: CallSummary[] = [];

  for (const call of calls) {
    if (call.call_id === null) {
      ungrouped.push(call);
      continue;
    }
    const held = best.get(call.call_id);
    if (held === undefined || wins(call, held)) best.set(call.call_id, call);
  }

  return [...best.values(), ...ungrouped];
}

function wins(candidate: CallSummary, held: CallSummary): boolean {
  if (candidate.in_progress !== held.in_progress) return !candidate.in_progress;
  return candidate.stored_at > held.stored_at;
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
 *
 * The line this function draws, and holds everywhere:
 *
 *  * **Volume numbers count everything**, including calls still in progress, so
 *    a Grafana board shows a call the moment it starts rather than minutes after
 *    it ends. `calls_in_progress` says how many of them are still live.
 *  * **Quality numbers describe finished calls only** — every `latency_*`, the
 *    stage averages, `over_budget_pct`, `degraded_pct` and `avg_call_seconds`.
 *    A call in flight has no duration yet, and half of its turns have not
 *    happened, so letting it into those aggregates would make every panel dip
 *    whenever the phone rang.
 *  * **Per-call averages additionally ignore calls that never talked** — see
 *    `engaged` below. `calls_no_turns` and `calls_averaged` keep that honest.
 */
export function aggregate(
  calls: CallSummary[],
  options: { sampled: boolean; unreadable: number; untrusted?: number; now?: number },
): Record<string, unknown> {
  const now = options.now ?? Date.now();

  const finished = calls.filter((call) => !call.in_progress);
  const live = calls.length - finished.length;

  const completed = finished.flatMap((call) => call.completed);
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

  /*
   * The calls the per-call averages are actually taken over.
   *
   * A finished call with no completed turn never became a conversation: the
   * agent greeted an empty room, or the caller hung up during the greeting, or
   * — the case that motivated this — a mid-call redeploy orphaned the room and
   * the agent sat in it alone until somebody deleted it. One such orphan ran for
   * 998 seconds with almost no turns and, averaged in, was indistinguishable
   * from a sixteen-minute conversation.
   *
   * They are not dropped from the fleet, only from the averages: `calls_total`
   * still counts them and `calls_no_turns` names them, so the ratio stays
   * visible instead of quietly disappearing.
   */
  const engaged = finished.filter((call) => call.completed.length > 0);

  const durations = engaged
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
    /**
     * Stored records skipped because they were not written by the agent. They
     * are still fetchable by share link; they simply do not move these numbers.
     */
    calls_untrusted: options.untrusted ?? 0,

    calls_total: calls.length,
    /** Live right now — a checkpoint arrived and no final debrief has. */
    calls_in_progress: live,
    calls_completed: finished.length,
    /**
     * Finished calls where no exchange ever completed — the agent greeted and
     * nobody replied, or the room was orphaned. Six of the first ten stored
     * calls were these. Excluded from `avg_call_seconds` and
     * `avg_turns_per_call`; counted here so the ratio stays visible.
     */
    calls_no_turns: finished.filter((call) => call.completed.length === 0).length,
    /**
     * The literal denominator behind `avg_call_seconds`: finished calls that
     * talked AND had a usable clock. Reporting `engaged.length` here instead
     * would be off by however many calls had an unusable `started_at`, which is
     * exactly the kind of quiet discrepancy this endpoint exists to expose.
     */
    calls_averaged: durations.length,
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
    avg_turns_per_call: round(mean(engaged.map((call) => call.turns)), 2),
    /**
     * Mean CONVERSATION length, in seconds, over finished calls that had at
     * least one completed turn — not mean room lifetime. See `IDLE_TAIL_SECONDS`
     * and `calls_averaged`.
     */
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

    over_budget_pct: pct(totals.filter((value) => value > BUDGET_SECONDS).length, totals.length),
    degraded_pct: pct(completed.filter((turn) => turn.degraded).length, completed.length),
    barge_in_total: sum((call) => call.barge_ins),

    tokens_prompt: sum((call) => call.prompt_tokens),
    tokens_completion: sum((call) => call.completion_tokens),
    stt_seconds: round(sum((call) => call.stt_seconds), 1),
    tts_characters: sum((call) => call.tts_characters),
    est_cost_usd: round(sum((call) => call.cost_usd), 4),
  };
}

async function readAll(
  env: Env,
  keys: string[],
): Promise<{ calls: CallSummary[]; unreadable: number; untrusted: number }> {
  const calls: CallSummary[] = [];
  let unreadable = 0;
  let untrusted = 0;

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
      // Anonymous writes are stored, but they are not evidence. See the module
      // note: `source` is set by the Worker from a verified bearer token, never
      // by the body, so this is a real trust boundary and not a hint.
      else if (summary.source !== 'agent') untrusted += 1;
      else calls.push(summary);
    }
  }

  return { calls, unreadable, untrusted };
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

  const { calls, unreadable, untrusted } = await readAll(env, keys.slice(0, READ_CAP));
  return aggregate(dedupe(calls), {
    sampled: keys.length > READ_CAP || !listed.list_complete,
    unreadable,
    untrusted,
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
      'x-content-type-options': 'nosniff',
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

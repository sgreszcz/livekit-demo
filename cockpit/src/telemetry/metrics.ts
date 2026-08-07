/**
 * The fleet view's data: what every stored debrief adds up to.
 *
 * `GET /api/metrics` is derived, public and uncredentialed — the same body a
 * Grafana panel scrapes (see `grafana/dashboard.json`), which is why the
 * dashboard footer can honestly claim the two show the same numbers. It carries
 * no transcript, no room name and no call id, so nothing here needs redacting.
 *
 * Everything is parsed field by field rather than cast, for the same reason the
 * envelope guard exists: this is a network payload, an older Worker may not
 * carry a field a newer page wants, and a tile that dereferences its way into
 * `undefined` prints the word "undefined" at a visitor.
 *
 * The distinction that matters throughout is **zero versus absent**. The
 * endpoint legitimately answers zeros when no calls have been recorded, and a
 * fleet with no calls in it genuinely has zero calls — that is a reading and it
 * prints as `0`. `null` here means the field was missing or malformed, and only
 * that prints as a dash.
 */

export interface DayCount {
  /** ISO date, `YYYY-MM-DD`, as the Worker bucketed it (UTC). */
  date: string;
  value: number;
}

export interface StageAverage {
  label: string;
  ms: number;
}

export interface FleetMetrics {
  /** Unix seconds the Worker computed this. */
  generatedAt: number | null;
  /** True when more debriefs are stored than this response read. */
  sampled: boolean;
  callsRead: number | null;

  calls: number | null;
  turns: number | null;
  avgCallSeconds: number | null;
  avgTurnsPerCall: number | null;
  bargeIns: number | null;
  costUsd: number | null;

  /** Fourteen fixed buckets ending today; a quiet day is a zero, not a gap. */
  perDay: DayCount[];

  latencyCount: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyMaxMs: number | null;

  /** EOU / TTFT / TTFB averages, in pipeline order. */
  stages: StageAverage[];

  overBudgetPct: number | null;
  degradedPct: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite number, or null. NaN and Infinity reach SVG geometry otherwise. */
function num(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The calls-per-day series, dropping any bucket that is not a real bucket. */
function parseDays(value: unknown): DayCount[] {
  if (!Array.isArray(value)) return [];
  const days: DayCount[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const count = num(entry, 'value');
    if (typeof entry.date !== 'string' || count === null || count < 0) continue;
    days.push({ date: entry.date, value: count });
  }
  return days;
}

/**
 * The stage breakdown.
 *
 * Preferred from the `stages` array the Worker emits for Grafana's bar gauge,
 * because that is the form that carries its own labels and therefore cannot
 * drift out of order. The three flat `stage_*_avg_ms` fields are the fallback
 * for a Worker that predates it.
 */
function parseStages(source: Record<string, unknown>): StageAverage[] {
  if (Array.isArray(source.stages)) {
    const stages: StageAverage[] = [];
    for (const entry of source.stages) {
      if (!isRecord(entry)) continue;
      const ms = num(entry, 'ms');
      if (typeof entry.stage !== 'string' || ms === null || ms < 0) continue;
      stages.push({ label: entry.stage, ms });
    }
    if (stages.length > 0) return stages;
  }

  const fallback: [string, string][] = [
    ['EOU delay', 'stage_eou_avg_ms'],
    ['LLM TTFT', 'stage_llm_ttft_avg_ms'],
    ['TTS TTFB', 'stage_tts_ttfb_avg_ms'],
  ];
  const stages: StageAverage[] = [];
  for (const [label, key] of fallback) {
    const ms = num(source, key);
    if (ms !== null && ms >= 0) stages.push({ label, ms });
  }
  return stages;
}

/**
 * Fields that only a real metrics body has. At least one must be present.
 *
 * Without this check any JSON object parses: `{"error":"upstream unavailable"}`
 * becomes a `FleetMetrics` of all-nulls, and a page of dashes is not the
 * failure it looks like — it is the *ready* state, so the lamp goes green and
 * the footer asserts "Complete: every stored recording is counted above" over a
 * response that counted nothing. A dashboard is allowed to say it does not
 * know; it is not allowed to claim completeness it cannot support.
 */
const SIGNATURE_FIELDS = [
  'calls_total',
  'turns_total',
  'calls_per_day',
  'latency_count',
  'generated_at',
  'est_cost_usd',
] as const;

/** Parses a `/api/metrics` body, or null if it is not one at all. */
export function parseMetrics(value: unknown): FleetMetrics | null {
  if (!isRecord(value)) return null;
  if (!SIGNATURE_FIELDS.some((field) => field in value)) return null;

  return {
    generatedAt: num(value, 'generated_at'),
    sampled: value.sampled === true,
    callsRead: num(value, 'calls_read'),

    calls: num(value, 'calls_total'),
    turns: num(value, 'turns_total'),
    avgCallSeconds: num(value, 'avg_call_seconds'),
    avgTurnsPerCall: num(value, 'avg_turns_per_call'),
    bargeIns: num(value, 'barge_in_total'),
    costUsd: num(value, 'est_cost_usd'),

    perDay: parseDays(value.calls_per_day),

    latencyCount: num(value, 'latency_count'),
    latencyP50Ms: num(value, 'latency_p50_ms'),
    latencyP95Ms: num(value, 'latency_p95_ms'),
    latencyMaxMs: num(value, 'latency_max_ms'),

    stages: parseStages(value),

    overBudgetPct: num(value, 'over_budget_pct'),
    degradedPct: num(value, 'degraded_pct'),
  };
}

/**
 * Fetches the fleet aggregate, or null.
 *
 * Null for every failure mode, deliberately: an unreachable endpoint, a 500 and
 * a body that is not JSON are the same event as far as this page is concerned,
 * and the dashboard's answer to all of them is the same empty state. There is
 * nothing a visitor could do differently knowing which it was.
 */
export async function fetchMetrics(signal?: AbortSignal): Promise<FleetMetrics | null> {
  try {
    const response = await fetch('/api/metrics', { signal });
    if (!response.ok) return null;
    return parseMetrics(await response.json());
  } catch {
    return null;
  }
}

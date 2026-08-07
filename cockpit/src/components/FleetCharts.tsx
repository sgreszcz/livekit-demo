/**
 * The fleet page's three drawings. Pure SVG, no chart library, no measurement.
 *
 * Geometry along the long axis is expressed in percentages and only the short
 * axis is in pixels — the same trick `MiniWaterfall` uses, and it is what lets
 * these scale with their column without a `ResizeObserver`, render identically
 * under `renderToStaticMarkup`, and stay testable without a DOM.
 *
 * They deliberately speak the waterfall's language rather than inventing a
 * second one: `rx` 1.5 corners, the stage ramp for stage bars, a labelled
 * `role="img"` so a screen reader gets the finding rather than a shrug, and a
 * `<title>` per mark so a pointer gets the exact figure. A visitor who has read
 * one call should not have to learn a new visual vocabulary to read a thousand.
 */

import { integer, ms } from '../format';
import type { DayCount, StageAverage } from '../telemetry/metrics';

const MISSING = '—';

/* ── Calls per day ─────────────────────────────────────────────────────── */

const DAY_CHART_HEIGHT = 132;
/** Share of each slot the column occupies; the rest is the gap. */
const DAY_BAR_SHARE = 0.62;
/** A day with calls always draws something, so a 1 next to a 40 is still visible. */
const DAY_MIN_HEIGHT = 2;

function shortDate(iso: string): string {
  // `2026-08-06` -> `06/08`. Sliced rather than parsed: these are already UTC
  // day buckets, and `new Date('2026-08-06')` in a browser west of Greenwich
  // renders the previous day.
  const [, month, day] = iso.split('-');
  return month && day ? `${day}/${month}` : iso;
}

export function CallsPerDay({ days }: { days: DayCount[] }) {
  if (days.length === 0) {
    return <p className="wf-empty">No call history yet — this fills in as calls are recorded.</p>;
  }

  const peak = days.reduce((max, day) => Math.max(max, day.value), 0);
  const total = days.reduce((sum, day) => sum + day.value, 0);
  const slot = 100 / days.length;
  const barWidth = slot * DAY_BAR_SHARE;
  const offset = (slot - barWidth) / 2;

  return (
    <div className="daychart">
      <svg
        className="daychart__svg"
        width="100%"
        height={DAY_CHART_HEIGHT}
        role="img"
        aria-label={`${total} calls over the last ${days.length} days, peaking at ${peak} in a day`}
      >
        {days.map((day, index) => {
          // A zero-call day draws no column at all rather than a stub: the
          // baseline underneath already says the day exists and was quiet.
          const height =
            peak > 0 && day.value > 0
              ? Math.max((day.value / peak) * (DAY_CHART_HEIGHT - 6), DAY_MIN_HEIGHT)
              : 0;
          return (
            <rect
              key={day.date}
              className="daychart__bar"
              x={`${index * slot + offset}%`}
              width={`${barWidth}%`}
              y={DAY_CHART_HEIGHT - height}
              height={height}
              rx={1.5}
            >
              <title>{`${day.date}: ${day.value} call${day.value === 1 ? '' : 's'}`}</title>
            </rect>
          );
        })}
        <line
          className="daychart__base"
          x1={0}
          x2="100%"
          y1={DAY_CHART_HEIGHT - 0.5}
          y2={DAY_CHART_HEIGHT - 0.5}
        />
      </svg>

      {/* Fourteen date labels do not fit on a phone and would not be read on a
          laptop. The ends anchor the axis, the middle states the finding, and
          every column carries its own exact figure in a tooltip. */}
      <div className="mini__foot">
        <span>{shortDate(days[0].date)}</span>
        <span>{peak === 0 ? 'no calls yet' : `peak ${peak}/day`}</span>
        <span>{shortDate(days[days.length - 1].date)}</span>
      </div>
    </div>
  );
}

/* ── Stage breakdown ───────────────────────────────────────────────────── */

const STAGE_ROW_HEIGHT = 10;

/**
 * The waterfall's own ramp, keyed off the labels the Worker emits.
 *
 * Matched on a substring rather than on equality so a Worker that renames
 * "LLM TTFT" to "LLM time to first token" keeps its violet instead of silently
 * dropping to neutral — and an unrecognised stage still draws, in a colour that
 * claims nothing.
 */
function stageFill(label: string): string {
  const name = label.toLowerCase();
  if (name.includes('eou')) return 'var(--stage-eou)';
  if (name.includes('ttft')) return 'var(--stage-ttft)';
  if (name.includes('ttfb')) return 'var(--stage-ttfb)';
  return 'var(--text-mute)';
}

export function StageBreakdown({ stages }: { stages: StageAverage[] }) {
  if (stages.length === 0) {
    return <p className="wf-empty">No completed turns to break down yet.</p>;
  }

  const longest = stages.reduce((max, stage) => Math.max(max, stage.ms), 0);

  return (
    <ul className="stagebars">
      {stages.map((stage) => (
        <li key={stage.label} className="stagebar">
          <span className="stagebar__label">{stage.label}</span>
          <span className="stagebar__track">
            <svg
              className="stagebar__svg"
              width="100%"
              height={STAGE_ROW_HEIGHT}
              aria-hidden="true"
            >
              <rect
                x={0}
                y={0}
                // Widths are a share of the longest stage, so the three are
                // comparable to each other. The figure beside each one carries
                // the magnitude — this is a ranking, not a second time axis.
                width={`${longest > 0 ? Math.max((stage.ms / longest) * 100, 0.5) : 0}%`}
                height={STAGE_ROW_HEIGHT}
                rx={1.5}
                fill={stageFill(stage.label)}
              />
            </svg>
          </span>
          <span className="stagebar__value num">
            {integer(stage.ms)}
            <small>ms</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ── Ratio gauge ───────────────────────────────────────────────────────── */

export type GaugeTone = 'warn' | 'alarm';

interface RatioGaugeProps {
  label: string;
  /** 0..100, or null when the endpoint did not report it. */
  pct: number | null;
  /**
   * Amber or red. Earned here rather than borrowed: both figures on this page
   * that use one are literally degradation rates, which is the only thing the
   * house rules spend these two colours on.
   */
  tone: GaugeTone;
  caption: string;
}

export function RatioGauge({ label, pct, tone, caption }: RatioGaugeProps) {
  const known = pct !== null;
  const width = known ? Math.min(100, Math.max(0, pct)) : 0;

  return (
    <div className="gauge">
      <div className="ledger__label">{label}</div>
      <div className={`gauge__value num${known && pct > 0 ? ` gauge__value--${tone}` : ''}`}>
        {known ? pct.toFixed(1) : MISSING}
        <small>%</small>
      </div>
      <div
        className="gauge__track"
        role="img"
        aria-label={`${label}: ${known ? `${pct.toFixed(1)} percent` : 'not reported'}`}
      >
        {/* No fill at all when nothing was reported — an empty track reads as
            "no reading", where a zero-width fill reads as a measured zero. */}
        {known ? <div className={`gauge__fill gauge__fill--${tone}`} style={{ width: `${width}%` }} /> : null}
      </div>
      <p className="gauge__caption">{caption}</p>
    </div>
  );
}

/* ── Stat tile ─────────────────────────────────────────────────────────── */

interface StatProps {
  label: string;
  /** Pre-formatted, because these are counts, seconds, ratios and dollars. */
  value: string;
  unit?: string;
  sub?: string;
  lead?: boolean;
}

/** The dashboard's headline figures, sharing the cockpit's ledger language. */
export function Stat({ label, value, unit, sub, lead = false }: StatProps) {
  return (
    <div className={`stat${lead ? ' stat--lead' : ''}`}>
      <div className="ledger__label">{label}</div>
      <div className="stat__value num">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {sub ? <p className="stat__sub">{sub}</p> : null}
    </div>
  );
}

/** Seconds as a human reads a call length: "48s", "2m 04s". */
export function callLength(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

/** A latency in milliseconds, or a dash. Shared by the percentile tiles. */
export function latencyValue(value: number | null): string {
  return value === null ? MISSING : ms(value / 1000);
}

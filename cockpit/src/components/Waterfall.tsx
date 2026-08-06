/**
 * The per-turn latency waterfall — the instrument this whole page exists for.
 *
 * One row per turn on a shared time axis, anchored at the moment the caller
 * stopped speaking, so turns are comparable at a glance and a regression shows
 * up as a shape rather than a number.
 *
 * The pipeline overlaps, and the drawing says so. The solid bar is the critical
 * path only — end of utterance, then time to first token, then time to first
 * audio byte — and its width is exactly the `total_response_latency` printed at
 * the end of the row. That is the only thing the dashed one-second budget rule
 * measures. Everything dimmed underneath happens while the caller is already
 * hearing audio, or inside a window the solid bar has already charged for.
 */

import { LATENCY_BUDGET_SECONDS, STAGE_LABELS, turnWaterfall } from '../telemetry/store';
import type { CriticalStage, OverlayStage, Turn, TurnWaterfall } from '../telemetry/store';
import { ms } from '../format';
import { useElementWidth } from '../useElementWidth';

const ROW_HEIGHT = 30;
const BAR_Y = 3;
const BAR_HEIGHT = 13;
/** Overlay lanes sit under the bar: same time axis, visibly not part of the wait. */
const LANE_HEIGHT = 3;
const LANE_Y: Record<OverlayStage, number> = { generation: 20, tts: 24.5 };

const CRITICAL_FILL: Record<CriticalStage, string> = {
  eou: 'var(--stage-eou)',
  ttft: 'var(--stage-ttft)',
  ttfb: 'var(--stage-ttfb)',
};

/** Overlays keep their stage's hue so the lane is identifiable, but dimmed. */
const OVERLAY_FILL: Record<OverlayStage, string> = {
  generation: 'var(--stage-ttft)',
  tts: 'var(--stage-ttfb)',
};

const CRITICAL_ORDER: CriticalStage[] = ['eou', 'ttft', 'ttfb'];

/**
 * Rounds the axis up to a readable half-second, never tighter than the budget.
 * Exported because it is the one piece of the drawing with real arithmetic in
 * it — everything else is `seconds / scale * width`.
 */
export function axisScale(rows: TurnWaterfall[]): number {
  const longest = rows.reduce((max, row) => Math.max(max, row.spanSeconds), 0);
  return Math.max(Math.ceil(Math.max(longest, LATENCY_BUDGET_SECONDS * 1.6) * 2) / 2, 1.5);
}

function tickStep(scale: number): number {
  if (scale <= 2.5) return 0.5;
  if (scale <= 6) return 1;
  return 2;
}

export function Waterfall({ turns }: { turns: Turn[] }) {
  // The axis row is always mounted, so it is the stable thing to measure; every
  // turn row shares its grid template and therefore its chart-column width.
  const [axisRef, width] = useElementWidth<HTMLDivElement>();

  // Only turns the caller started are numbered: counting the agent's greeting as
  // turn one would put every subsequent row one ahead of the id in the logs.
  let ordinal = 0;
  const rows = turns.map((turn) => {
    const waterfall = turnWaterfall(turn);
    if (!waterfall.agentInitiated) ordinal += 1;
    return { turn, waterfall, label: waterfall.agentInitiated ? 'GREET' : `T${ordinal}` };
  });

  const scale = axisScale(rows.map((row) => row.waterfall));
  const budgetX = (LATENCY_BUDGET_SECONDS / scale) * width;

  return (
    <div>
      {rows.length === 0 ? (
        <p className="wf-empty">No turns yet — the waterfall draws itself as the call unfolds.</p>
      ) : (
        <div className="waterfall">
          {rows.map(({ turn, waterfall, label }) => (
            <WaterfallRow
              key={turn.turnId}
              turn={turn}
              waterfall={waterfall}
              label={label}
              scale={scale}
              width={width}
              budgetX={budgetX}
            />
          ))}
        </div>
      )}

      <div className="wf-row wf-row--axis">
        <span className="wf-row__id" />
        <div className="wf-row__chart" ref={axisRef}>
          {width > 0 && rows.length > 0 ? (
            <Axis width={width} scale={scale} budgetX={budgetX} />
          ) : null}
        </div>
        <span className="wf-row__total" />
      </div>

      <Key />
    </div>
  );
}

interface RowProps {
  turn: Turn;
  waterfall: TurnWaterfall;
  /** Gutter placard: the caller-turn ordinal, or GREET for the agent's opener. */
  label: string;
  scale: number;
  width: number;
  budgetX: number;
}

function WaterfallRow({ turn, waterfall, label, scale, width, budgetX }: RowProps) {
  const { critical, overlays, transcriptionTick, spanSeconds } = waterfall;
  const total = turn.totalResponseLatency;
  const bargedIn = turn.interruptions.includes('barge_in');
  const llmCalls = turn.llm?.llm_calls ?? 1;
  const x = (seconds: number) => (seconds / scale) * width;

  const totalClass = turn.degraded
    ? 'wf-row__total--degraded'
    : (total ?? 0) > LATENCY_BUDGET_SECONDS
      ? 'wf-row__total--over'
      : '';

  const description = [
    waterfall.agentInitiated ? 'Agent greeting' : `Turn ${label.slice(1)}`,
    waterfall.agentInitiated
      ? 'agent-initiated, no caller wait to measure'
      : total !== undefined
        ? `${ms(total)} milliseconds until the caller heard audio`
        : 'in progress',
    llmCalls > 1 ? `${llmCalls} model calls` : null,
    turn.degraded ? 'degraded by injected latency' : null,
    bargedIn ? 'interrupted by the caller' : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className={`wf-row${turn.degraded ? ' wf-row--degraded' : ''}`}>
      {/* The gutter fits two chips at most; a barge-in has its own bar marker. */}
      <div className="wf-row__id">
        <span className="wf-row__ord">{label}</span>
        {turn.degraded ? <span className="chip chip--alarm">Chaos</span> : null}
        {llmCalls > 1 ? (
          <span className="chip chip--quiet" title={`${llmCalls} LLM calls — tool chain`}>
            ×{llmCalls}
          </span>
        ) : null}
      </div>

      <div className="wf-row__chart">
        {width > 0 ? (
          <svg
            className="wf-svg"
            width={width}
            height={ROW_HEIGHT}
            role="img"
            aria-label={description}
          >
            {/* Everything right of the rule is time the caller should not have
                spent waiting. A wash, not an alarm — the alarm is the figure. */}
            {width > budgetX ? (
              <rect
                className="wf-overrun"
                x={budgetX}
                y={0}
                width={width - budgetX}
                height={ROW_HEIGHT}
              />
            ) : null}

            <line className="wf-budget-rule" x1={budgetX} x2={budgetX} y1={0} y2={ROW_HEIGHT} />

            {critical.map((span) => (
              <rect
                key={span.key}
                className="wf-seg"
                x={x(span.start)}
                y={BAR_Y}
                width={Math.max(x(span.seconds), 1)}
                height={BAR_HEIGHT}
                fill={CRITICAL_FILL[span.key]}
                rx={1.5}
              >
                <title>{`${span.label}: ${ms(span.seconds)} ms — the caller is waiting`}</title>
              </rect>
            ))}

            {/* Transcription finishes inside the EOU window, so it is a mark on
                the bar rather than a segment of it. */}
            {transcriptionTick !== null ? (
              <line
                className="wf-tick"
                x1={x(transcriptionTick)}
                x2={x(transcriptionTick)}
                y1={BAR_Y}
                y2={BAR_Y + BAR_HEIGHT}
              >
                <title>
                  {`${STAGE_LABELS.transcription} at ${ms(transcriptionTick)} ms — inside the ` +
                    `end-of-utterance window, not added to it`}
                </title>
              </line>
            ) : null}

            {overlays.map((span) => (
              <rect
                key={span.key}
                className="wf-overlay"
                x={x(span.start)}
                y={LANE_Y[span.key]}
                width={Math.max(x(span.seconds), 1)}
                height={LANE_HEIGHT}
                fill={OVERLAY_FILL[span.key]}
                rx={1.5}
              >
                <title>
                  {`${span.label}: ${ms(span.seconds)} ms running under audio the caller can ` +
                    `already hear — not part of the wait`}
                </title>
              </rect>
            ))}

            {bargedIn ? <BargeInMarker x={x(spanSeconds)} /> : null}
          </svg>
        ) : null}
      </div>

      <div className={`wf-row__total num ${totalClass}`}>
        {total !== undefined ? (
          <>
            {ms(total)}
            <small>ms</small>
          </>
        ) : waterfall.agentInitiated ? (
          <span
            className="wf-row__partial"
            title="The agent opened this turn, so there is no caller utterance to measure a wait from."
          >
            agent-initiated
          </span>
        ) : (
          <span className="wf-row__pending">···</span>
        )}
      </div>
    </div>
  );
}

/** Where the caller cut the agent off, drawn at the end of the agent's audio. */
function BargeInMarker({ x }: { x: number }) {
  return (
    <g transform={`translate(${x + 3} 0)`}>
      <line x1={0} x2={0} y1={2} y2={ROW_HEIGHT - 3} stroke="var(--caller)" strokeWidth={1.5} />
      <path d={`M0 ${BAR_Y} L6 ${BAR_Y + 4.5} L0 ${BAR_Y + 9} Z`} fill="var(--caller)" />
      <title>Caller barged in while the agent was still speaking</title>
    </g>
  );
}

/** What the dashed rule is, spelled out — "BUDGET" alone answered nothing. */
const BUDGET_LABEL = `${LATENCY_BUDGET_SECONDS.toFixed(1)} s response budget`;
/** Enough room to print BUDGET_LABEL to the right of the rule instead of left. */
const BUDGET_LABEL_WIDTH = 132;

function Axis({ width, scale, budgetX }: { width: number; scale: number; budgetX: number }) {
  const step = tickStep(scale);
  const ticks: number[] = [];
  for (let tick = 0; tick <= scale + 1e-6; tick += step) ticks.push(Number(tick.toFixed(2)));

  // The label hangs off the rule on whichever side can hold it, so it never
  // runs off the card on a phone or collides with the zero tick.
  const labelRight = width - budgetX >= BUDGET_LABEL_WIDTH;

  return (
    <svg className="wf-axis" width={width} height={36} aria-hidden="true">
      <line x1={0} x2={width} y1={0.5} y2={0.5} stroke="var(--line-strong)" strokeWidth={1} />
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={(tick / scale) * width}
            x2={(tick / scale) * width}
            y1={0}
            y2={4}
            stroke="var(--line-strong)"
            strokeWidth={1}
          />
          {/* The budget rule descends through this slot and its own label
              prints the same time; a tick here would be struck through. */}
          {Math.abs(tick - LATENCY_BUDGET_SECONDS) < 1e-6 ? null : (
            <text x={(tick / scale) * width} y={15} textAnchor={tick === 0 ? 'start' : 'middle'}>
              {tick === 0 ? '0' : `${tick.toFixed(1)}s`}
            </text>
          )}
        </g>
      ))}
      <line
        className="wf-budget-rule"
        x1={budgetX}
        x2={budgetX}
        y1={0}
        y2={22}
      />
      <text
        className="wf-budget-note"
        x={labelRight ? budgetX + 6 : budgetX - 6}
        y={31}
        textAnchor={labelRight ? 'start' : 'end'}
      >
        {BUDGET_LABEL}
      </text>
    </svg>
  );
}

function Key() {
  return (
    <div className="wf-key">
      <div className="wf-key__row">
        {CRITICAL_ORDER.map((key) => (
          <span key={key} className="wf-key__item">
            <span className="wf-key__swatch" style={{ background: CRITICAL_FILL[key] }} />
            {STAGE_LABELS[key]}
          </span>
        ))}
        <span className="wf-key__item">
          <svg width="16" height="10" aria-hidden="true" className="wf-key__swatch">
            <line x1={8} x2={8} y1={0} y2={10} stroke="var(--stage-transcription)" strokeWidth={1.5} />
          </svg>
          {STAGE_LABELS.transcription}
        </span>
        {/* Two dimmed lanes, two entries: one entry could not say which hue was
            the model finishing its answer and which was the voice playing it. */}
        <span className="wf-key__item">
          <span
            className="wf-key__swatch wf-key__swatch--lane"
            style={{ background: OVERLAY_FILL.generation }}
          />
          {STAGE_LABELS.generation}
        </span>
        <span className="wf-key__item">
          <span
            className="wf-key__swatch wf-key__swatch--lane"
            style={{ background: OVERLAY_FILL.tts }}
          />
          {STAGE_LABELS.tts}
        </span>
        <span className="wf-key__item">
          <svg width="16" height="10" aria-hidden="true" className="wf-key__swatch">
            <line x1={1} x2={1} y1={0} y2={10} stroke="var(--caller)" strokeWidth={1.5} />
            <path d="M1 1 L7 5 L1 9 Z" fill="var(--caller)" />
          </svg>
          Barge-in (caller interrupted)
        </span>
        {/* The figures at the end of each row change colour; nothing else on the
            page says what that means, so the legend does. */}
        <span className="wf-key__item">
          <b className="wf-key__amber num">amber</b> = over budget
        </span>
      </div>

      <p className="wf-key__note">
        Solid bar = what the caller waits through; dimmed lanes overlap audio they can already hear.
      </p>
    </div>
  );
}

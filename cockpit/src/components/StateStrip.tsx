/**
 * Agent state as a strip-chart: how the call actually divided between waiting
 * for the caller, thinking, and talking. Silence that should have been speech
 * shows up here as an over-wide amber band.
 *
 * The listed durations reconcile with the elapsed time printed in the panel
 * head. They only do so because the strip also accounts for the lead-in: the
 * agent is initializing between the first telemetry envelope and its first
 * state report, and that time is real. Leaving it out made the legend look like
 * arithmetic that did not add up.
 */

import type { AgentState } from '../telemetry/schema';
import type { StateSample } from '../telemetry/store';
import { duration } from '../format';

const STATE_ORDER: AgentState[] = ['initializing', 'listening', 'thinking', 'speaking'];

const STATE_LABELS: Record<AgentState, string> = {
  initializing: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

/* The strip speaks the same colour language as the waterfall: the caller's
   time is blue, the model's is violet, the agent's voice is green. Setting up
   is none of those, so it is plain grey. */
const STATE_SWATCH: Record<AgentState, string> = {
  initializing: 'rgba(154, 167, 189, 0.55)',
  listening: 'var(--stage-eou)',
  thinking: 'var(--stage-ttft)',
  speaking: 'var(--stage-ttfb)',
};

interface Segment {
  state: AgentState;
  seconds: number;
  startTs: number;
}

export interface StateTotal {
  state: AgentState;
  label: string;
  seconds: number;
}

export interface StateBreakdown {
  segments: Segment[];
  /** Legend entries, in pipeline order. Sums to `total` by construction. */
  totals: StateTotal[];
  total: number;
}

/**
 * Splits the call into contiguous state segments covering `startTs`→`endTs`
 * with no gaps: each sample runs until the next one, the last runs to the end
 * of the call, and anything before the first sample is the initializing lead-in.
 */
function toSegments(states: StateSample[], startTs: number, endTs: number): Segment[] {
  if (states.length === 0) return [];

  const segments: Segment[] = [];
  const lead = states[0].ts - startTs;
  if (lead > 0) segments.push({ state: 'initializing', startTs, seconds: lead });

  for (const [index, sample] of states.entries()) {
    segments.push({
      state: sample.state,
      startTs: sample.ts,
      seconds: Math.max((states[index + 1]?.ts ?? endTs) - sample.ts, 0),
    });
  }

  return segments;
}

/**
 * Exported so the reconciliation between this legend and the elapsed figure in
 * the panel head is a property a test can assert rather than a coincidence.
 */
export function stateBreakdown(
  states: StateSample[],
  startTs: number,
  endTs: number,
): StateBreakdown {
  const segments = toSegments(states, startTs, endTs);
  const seen = new Map<AgentState, number>();
  for (const segment of segments) {
    seen.set(segment.state, (seen.get(segment.state) ?? 0) + segment.seconds);
  }

  const totals: StateTotal[] = [];
  for (const state of STATE_ORDER) {
    const seconds = seen.get(state) ?? 0;
    // A state the call never entered earns no legend entry; neither does a
    // lead-in too short to print as anything but 0.0s.
    if (state === 'initializing' ? seconds >= 0.05 : seen.has(state)) {
      totals.push({ state, label: STATE_LABELS[state], seconds });
    }
  }

  return {
    segments,
    totals,
    total: segments.reduce((sum, segment) => sum + segment.seconds, 0),
  };
}

interface StateStripProps {
  states: StateSample[];
  /** First envelope of the call — the strip starts here, not at the first state. */
  startTs: number;
  endTs: number;
}

export function StateStrip({ states, startTs, endTs }: StateStripProps) {
  const { segments, totals, total } = stateBreakdown(states, startTs, endTs);

  if (segments.length === 0) {
    return <p className="wf-empty">Awaiting the agent's first state report.</p>;
  }

  return (
    <div>
      <div className="strip" role="img" aria-label={`Agent state timeline over ${duration(total)}`}>
        {segments.map((segment) => (
          <div
            key={`${segment.state}-${segment.startTs}`}
            className={`strip__seg strip__seg--${segment.state}`}
            style={{ flexGrow: Math.max(segment.seconds, 0.05) }}
            title={`${STATE_LABELS[segment.state]} — ${duration(segment.seconds)}`}
          />
        ))}
      </div>

      <div className="strip-legend">
        {totals.map((entry) => (
          <span key={entry.state} className="strip-legend__item">
            <span className="strip-legend__dot" style={{ background: STATE_SWATCH[entry.state] }} />
            {entry.label} <b className="num">{duration(entry.seconds)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

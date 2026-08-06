/**
 * The instrument cluster. Identical for a live call, a fixture replay and a
 * stored debrief — only the source of envelopes and the presence of the chaos
 * control differ.
 */

import { Panel } from './Panel';
import { Waterfall } from './Waterfall';
import { StateStrip } from './StateStrip';
import { Transcript } from './Transcript';
import { CostLedger } from './CostLedger';
import { ConnectionInfo } from './ConnectionInfo';
import { ChaosControl } from './ChaosControl';
import { callDurationSeconds, type CockpitState } from '../telemetry/store';
import { duration, ms } from '../format';

export interface ChaosControls {
  delayMs: number;
  disabled: boolean;
  onChange: (delayMs: number) => void;
}

interface CockpitBoardProps {
  state: CockpitState;
  /** Live calls and replays follow the transcript tail; debriefs do not. */
  follow: boolean;
  chaos?: ChaosControls;
}

export function CockpitBoard({ state, follow, chaos }: CockpitBoardProps) {
  const elapsed = callDurationSeconds(state);
  const measured = state.turns.filter((turn) => turn.totalResponseLatency !== undefined);
  const median = medianLatency(measured.map((turn) => turn.totalResponseLatency!));
  const worst = measured.reduce((max, turn) => Math.max(max, turn.totalResponseLatency!), 0);

  return (
    <div className="cockpit">
      <Panel legend="Agent state" aside={duration(elapsed)}>
        {/* Same first and last envelope the elapsed figure above is measured
            from, so the strip's own totals reconcile with it. */}
        <StateStrip
          states={state.states}
          startTs={state.firstTs ?? 0}
          endTs={state.lastTs ?? 0}
        />
      </Panel>

      <div className="cockpit__body">
        <div className="cockpit__main">
          <Panel
            legend="Response latency · per turn"
            aside={
              measured.length > 0
                ? `median ${ms(median)} ms · worst ${ms(worst)} ms`
                : `${state.turns.length} turns`
            }
          >
            <Waterfall turns={state.turns} />
          </Panel>

          <Panel legend="Transcript" aside={`${state.transcript.length} lines`}>
            <Transcript lines={state.transcript} turns={state.turns} follow={follow} />
          </Panel>
        </div>

        <div className="cockpit__rail">
          <Panel legend="Connection" collapsible>
            <ConnectionInfo
              meta={state.meta}
              durationSeconds={elapsed}
              turnCount={state.turns.length}
            />
          </Panel>

          {chaos ? (
            <Panel
              legend="Chaos injection"
              aside={state.chaos.active ? `+${state.chaos.llmDelayMs} ms` : 'nominal'}
            >
              <ChaosControl
                delayMs={chaos.delayMs}
                acknowledged={state.chaos.active && state.chaos.llmDelayMs === chaos.delayMs}
                disabled={chaos.disabled}
                onChange={chaos.onChange}
              />
            </Panel>
          ) : null}

          <Panel legend="Cost ledger" collapsible>
            <CostLedger usage={state.usage} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function medianLatency(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

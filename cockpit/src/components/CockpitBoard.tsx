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
import { TransportLamp, TransportPanel } from './TransportPanel';
import {
  activeInjectionCount,
  callDurationSeconds,
  interruptionTotals,
  latencyAggregates,
  latestTransport,
  type ChaosState,
  type CockpitState,
  type InterruptionTotals,
  type LatencyAggregates,
} from '../telemetry/store';
import type { ChaosInjections } from '../telemetry/schema';
import { duration, ms } from '../format';

export interface ChaosControls {
  /** What this browser has asked the agent for. */
  request: ChaosInjections;
  disabled: boolean;
  /** Overrides the disabled-state copy where the usual reason does not apply. */
  note?: string;
  onChange: (patch: Partial<ChaosInjections>) => void;
}

interface CockpitBoardProps {
  state: CockpitState;
  /** Live calls and replays follow the transcript tail; debriefs do not. */
  follow: boolean;
  /**
   * True only while this browser is actually on the call. A replay follows the
   * tail like a live call does but records nothing, so `follow` cannot stand in
   * for this — the transport panel needs to know whether missing samples are
   * still coming or never existed.
   */
  live?: boolean;
  chaos?: ChaosControls;
}

export function CockpitBoard({ state, follow, live = false, chaos }: CockpitBoardProps) {
  const elapsed = callDurationSeconds(state);
  const latency = latencyAggregates(state.turns);
  const interruptions = interruptionTotals(state.turns);
  const transport = latestTransport(state);

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
              latency.measured > 0
                ? latencyReadout(latency)
                : `${state.turns.length} turns`
            }
            asideWrap
          >
            <Waterfall turns={state.turns} />
          </Panel>

          {/* Interruptions live here rather than on the waterfall head: a
              barge-in is a thing the caller said over the agent, and it reads
              as conversation, not as latency. */}
          <Panel
            legend="Transcript"
            aside={`${state.transcript.length} lines${interruptionReadout(interruptions)}`}
          >
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

          <Panel
            legend="Transport"
            aside={transport ? <TransportLamp quality={transport.quality} /> : undefined}
          >
            <TransportPanel samples={state.transport} live={live} />
          </Panel>

          {chaos ? (
            <Panel legend="Chaos engineering" aside={chaosReadout(state.chaos)}>
              <ChaosControl
                request={chaos.request}
                acked={state.chaos}
                disabled={chaos.disabled}
                disabledNote={chaos.note}
                onChange={chaos.onChange}
              />
            </Panel>
          ) : null}

          <Panel legend="Cost ledger" collapsible>
            <CostLedger usage={state.usage} elapsedSeconds={elapsed} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * The one-line summary of the whole waterfall. `p95` appears only once there
 * are enough turns for it to mean anything, and the over-budget count is
 * printed as a fraction because "2 over budget" is a very different call
 * depending on whether it was 2 of 3 or 2 of 60.
 */
function latencyReadout(latency: LatencyAggregates): string {
  const parts = [`median ${ms(latency.median)} ms`];
  if (latency.p95 !== null) parts.push(`p95 ${ms(latency.p95)} ms`);
  parts.push(`worst ${ms(latency.worst)} ms`);
  parts.push(`${latency.overBudget} of ${latency.measured} over budget`);
  return parts.join(' · ');
}

/**
 * The panel head's one-line verdict on chaos.
 *
 * Counted from the ack rather than from the switches, and phrased as a count
 * rather than as a value, because four injections no longer fit on one line —
 * and "2 active" is the thing a viewer needs from six feet away. Which two is
 * printed against each control inside the panel.
 */
function chaosReadout(chaos: ChaosState): string {
  const active = activeInjectionCount(chaos);
  return active === 0 ? 'nominal' : `${active} active`;
}

function interruptionReadout({ bargeIns, falseInterruptions }: InterruptionTotals): string {
  const parts: string[] = [];
  if (bargeIns > 0) parts.push(`${bargeIns} barge-in${bargeIns === 1 ? '' : 's'}`);
  if (falseInterruptions > 0) {
    parts.push(`${falseInterruptions} false interruption${falseInterruptions === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

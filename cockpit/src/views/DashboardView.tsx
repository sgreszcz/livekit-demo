/**
 * The fleet view: the cockpit is a flight recorder for one call, this is every
 * call the recorder ever kept.
 *
 * All of it comes from `GET /api/metrics`, which is derived and public — no
 * transcript, no room name, no call id ever reaches it. That is also why the
 * footer can link the Grafana board and claim it shows the same data: both
 * scrape the identical body.
 *
 * The page renders its full layout in every state, with dashes where a figure
 * is missing. Loading, an unreachable endpoint and a fleet with no calls in it
 * are three different things, but none of them is a reason to collapse the
 * layout — a dashboard that reflows as its data lands is a dashboard nobody can
 * screenshot, and a blank one tells a visitor less than an honest row of
 * dashes does.
 */

import { Footer } from '../components/Footer';
import { Mark } from '../components/Mark';
import { Panel } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import {
  CallsPerDay,
  RatioGauge,
  Stat,
  StageBreakdown,
  callLength,
  latencyValue,
} from '../components/FleetCharts';
import { GRAFANA_PUBLIC_URL } from '../config';
import { LATENCY_BUDGET_SECONDS } from '../telemetry/store';
import type { FleetMetrics } from '../telemetry/metrics';
import { useMetrics } from '../useMetrics';
import { clockTime, integer, usd } from '../format';

const MISSING = '—';

/** Nothing known about anything — the shape loading and failure both render. */
const UNKNOWN: FleetMetrics = {
  generatedAt: null,
  sampled: false,
  callsRead: null,
  calls: null,
  turns: null,
  avgCallSeconds: null,
  avgTurnsPerCall: null,
  bargeIns: null,
  costUsd: null,
  perDay: [],
  latencyCount: null,
  latencyP50Ms: null,
  latencyP95Ms: null,
  latencyMaxMs: null,
  stages: [],
  overBudgetPct: null,
  degradedPct: null,
};

const count = (value: number | null): string => (value === null ? MISSING : integer(value));

export function DashboardView() {
  const load = useMetrics();
  const metrics = load.status === 'ready' ? load.metrics : UNKNOWN;

  const lamp =
    load.status === 'ready'
      ? {
          className: 'lamp--ok',
          label:
            metrics.generatedAt !== null ? `Updated ${clockTime(metrics.generatedAt)}` : 'Live',
        }
      : load.status === 'error'
        ? { className: 'lamp--idle', label: 'Unavailable' }
        : { className: 'lamp--idle', label: 'Loading' };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__mark">
          <Mark />
          Glass <span>Cockpit</span>
        </div>
        <Tabs route="dashboard" />
        <span className={`lamp ${lamp.className}`}>{lamp.label}</span>
        <div className="topbar__spacer" />
      </header>

      <div className="fleet">
        <div className="fleet__lead">
          <h1 className="fleet__title">Fleet</h1>
          <p className="fleet__lede">
            Every call this recorder kept, added up. One row of a Grafana board and one page of a
            cockpit, drawn from the same public endpoint.
          </p>
        </div>

        {load.status === 'error' ? (
          <div className="notice">
            <span>The metrics endpoint did not answer. Every figure below is unread, not zero.</span>
            <a className="notice__action" href="/">
              Back to the cockpit
            </a>
          </div>
        ) : null}

        <div className="stats">
          <Stat label="Calls" value={count(metrics.calls)} />
          <Stat label="Turns" value={count(metrics.turns)} />
          <Stat
            label="Avg call"
            value={metrics.avgCallSeconds === null ? MISSING : callLength(metrics.avgCallSeconds)}
          />
          <Stat
            label="Turns / call"
            value={metrics.avgTurnsPerCall === null ? MISSING : metrics.avgTurnsPerCall.toFixed(1)}
          />
          <Stat label="Barge-ins" value={count(metrics.bargeIns)} />
          <Stat
            label="Est. cost"
            value={metrics.costUsd === null ? MISSING : usd(metrics.costUsd)}
            sub="approximate, from the agent's price table"
            lead
          />
        </div>

        <Panel legend="Calls per day" aside="last 14 days">
          <CallsPerDay days={metrics.perDay} />
        </Panel>

        <div className="fleet__pair">
          <Panel
            legend="Response latency"
            aside={
              metrics.latencyCount === null
                ? undefined
                : `${integer(metrics.latencyCount)} measured turns`
            }
          >
            <div className="ledger ledger--three">
              <Percentile label="p50" value={metrics.latencyP50Ms} />
              <Percentile label="p95" value={metrics.latencyP95Ms} />
              <Percentile label="Max" value={metrics.latencyMaxMs} />
            </div>
            <p className="ledger__caveat">
              Where the caller's wait actually landed, across every recorded turn. The stage
              averages below say which part of the pipeline spent it.
            </p>
            <StageBreakdown stages={metrics.stages} />
          </Panel>

          <Panel legend="Degradation">
            <div className="gauges">
              <RatioGauge
                label="Over budget"
                pct={metrics.overBudgetPct}
                tone="warn"
                caption={`Turns slower than the ${LATENCY_BUDGET_SECONDS.toFixed(1)} s response budget.`}
              />
              <RatioGauge
                label="Degraded"
                pct={metrics.degradedPct}
                tone="alarm"
                caption="Turns that ran with a chaos injection armed — deliberate, not a fault."
              />
            </div>
          </Panel>
        </div>

        <p className="fleet__foot">
          {metrics.sampled
            ? `Sampled: more recordings are stored than this reading covers${
                metrics.callsRead === null ? '' : ` — the newest ${integer(metrics.callsRead)}`
              }.`
            : load.status === 'ready'
              ? 'Complete: every stored recording is counted above.'
              : 'No reading yet.'}{' '}
          <a href={GRAFANA_PUBLIC_URL} target="_blank" rel="noreferrer noopener">
            same data in Grafana
          </a>
        </p>
      </div>

      <Footer />
    </div>
  );
}

function Percentile({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="ledger__cell">
      <div className="ledger__label">{label}</div>
      <div className="ledger__value ledger__value--tight num">
        {latencyValue(value)}
        <small>ms</small>
      </div>
    </div>
  );
}

/**
 * The fleet aggregate, fetched on mount and refreshed while the tab is watched.
 *
 * Split the same way `useActiveRooms` is, and for the same reason: this suite
 * runs without a DOM, so the rules worth asserting — one immediate fetch, no
 * overlapping requests, a reply that arrives after the poller stopped is
 * dropped — live in `createMetricsPoller`, and the hook below is thin enough to
 * read in one sitting.
 *
 * Sixty seconds because that is the Worker's own `cache-control: max-age=60`
 * and its isolate memo. Polling faster would not produce a newer number; it
 * would produce the same number again, from a cache, at somebody's expense.
 */

import { useEffect, useState } from 'react';
import { fetchMetrics, type FleetMetrics } from './telemetry/metrics';

export const METRICS_POLL_MS = 60_000;

export interface MetricsPoller {
  start(): void;
  stop(): void;
  setVisible(visible: boolean): void;
}

interface MetricsPollerOptions {
  fetchSnapshot: () => Promise<FleetMetrics | null>;
  onSnapshot: (snapshot: FleetMetrics | null) => void;
  intervalMs?: number;
}

export function createMetricsPoller({
  fetchSnapshot,
  onSnapshot,
  intervalMs = METRICS_POLL_MS,
}: MetricsPollerOptions): MetricsPoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let visible = true;
  /** A fetch is outstanding — the interval skips rather than queues behind it. */
  let inFlight = false;
  /**
   * Bumped whenever polling halts, so a reply already in flight cannot repaint
   * a page that has navigated away from the dashboard.
   */
  let generation = 0;

  const clearTimer = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const halt = () => {
    generation += 1;
    // Cleared here rather than when the orphaned fetch settles, so a restart is
    // never suppressed by the in-flight flag of a poller that already stopped.
    inFlight = false;
    clearTimer();
  };

  const settle = (mine: number, snapshot: FleetMetrics | null) => {
    if (generation !== mine) return;
    inFlight = false;
    onSnapshot(snapshot);
  };

  const poll = () => {
    if (inFlight) return;
    inFlight = true;
    const mine = generation;
    try {
      fetchSnapshot().then(
        (snapshot) => settle(mine, snapshot),
        () => settle(mine, null),
      );
    } catch {
      settle(mine, null);
    }
  };

  const resume = () => {
    clearTimer();
    poll();
    timer = setInterval(poll, intervalMs);
  };

  return {
    start() {
      if (started) return;
      started = true;
      if (visible) resume();
    },
    stop() {
      started = false;
      halt();
    },
    setVisible(next: boolean) {
      if (next === visible) return;
      visible = next;
      if (!started) return;
      if (next) resume();
      else halt();
    },
  };
}

export type MetricsLoad =
  | { status: 'loading' }
  /** The endpoint answered nothing usable. Distinct from an empty fleet. */
  | { status: 'error' }
  | { status: 'ready'; metrics: FleetMetrics };

export function useMetrics(): MetricsLoad {
  const [load, setLoad] = useState<MetricsLoad>({ status: 'loading' });

  useEffect(() => {
    const poller = createMetricsPoller({
      fetchSnapshot: fetchMetrics,
      onSnapshot: (metrics) =>
        // A refresh that fails leaves the last good numbers on screen rather
        // than blanking a dashboard somebody is presenting from: only the
        // first load can land in the error state.
        setLoad((current) =>
          metrics === null
            ? current.status === 'ready'
              ? current
              : { status: 'error' }
            : { status: 'ready', metrics },
        ),
    });
    const syncVisibility = () => poller.setVisible(document.visibilityState !== 'hidden');

    syncVisibility();
    poller.start();
    document.addEventListener('visibilitychange', syncVisibility);

    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      poller.stop();
    };
  }, []);

  return load;
}

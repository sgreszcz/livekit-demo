/**
 * The dashboard's polling rules, asserted without a DOM.
 *
 * Same shape of claim as the hero's room poller and the same reason for it:
 * this one runs for as long as somebody leaves a dashboard open on a wall
 * screen, so the failure modes that matter are the ones that compound —
 * requests stacking behind a slow Worker, an interval outliving the page, a
 * reply from a poller that already stopped repainting a view that moved on.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { METRICS_POLL_MS, createMetricsPoller } from './useMetrics';
import type { FleetMetrics } from './telemetry/metrics';

const METRICS = { calls: 12 } as unknown as FleetMetrics;
const OTHER = { calls: 13 } as unknown as FleetMetrics;

const INTERVAL = 1000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets pending promise callbacks run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('createMetricsPoller', () => {
  const onSnapshot = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    onSnapshot.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches the Worker’s own cache lifetime', () => {
    // Polling faster than `cache-control: max-age=60` cannot produce a newer
    // number — only the same one again, from a cache, at somebody's expense.
    expect(METRICS_POLL_MS).toBe(60_000);
  });

  it('fetches immediately rather than showing an empty page for a minute', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(METRICS);
    const poller = createMetricsPoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    await flush();
    expect(onSnapshot).toHaveBeenCalledWith(METRICS);
    poller.stop();
  });

  it('refreshes once per interval and stops dead when told to', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(METRICS);
    const poller = createMetricsPoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(fetchSnapshot).toHaveBeenCalledTimes(4);

    poller.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(fetchSnapshot).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips an interval rather than stacking behind a slow Worker', async () => {
    const pending = deferred<FleetMetrics | null>();
    const fetchSnapshot = vi.fn().mockReturnValue(pending.promise);
    const poller = createMetricsPoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    // A cold /api/metrics fans out over KV and can take a second or two. Four
    // ticks must not become four in-flight requests.
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    pending.resolve(METRICS);
    await flush();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('drops a reply that lands after it stopped', async () => {
    const pending = deferred<FleetMetrics | null>();
    const fetchSnapshot = vi.fn().mockReturnValue(pending.promise);
    const poller = createMetricsPoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    poller.stop();
    pending.resolve(OTHER);
    await flush();

    // The visitor navigated away from the dashboard; this reply belongs to a
    // page that no longer exists.
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('reports a rejection as an absent reading rather than crashing the page', async () => {
    const fetchSnapshot = vi.fn().mockRejectedValue(new Error('offline'));
    const poller = createMetricsPoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    await flush();
    expect(onSnapshot).toHaveBeenCalledWith(null);

    // And it keeps trying: an offline blip must not end the refresh for good.
    fetchSnapshot.mockResolvedValue(METRICS);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onSnapshot).toHaveBeenLastCalledWith(METRICS);
    poller.stop();
  });

  it('survives a fetcher that throws synchronously', async () => {
    const fetchSnapshot = vi.fn(() => {
      throw new Error('nope');
    });
    const poller = createMetricsPoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    expect(() => poller.start()).not.toThrow();
    expect(onSnapshot).toHaveBeenCalledWith(null);
    poller.stop();
  });

  it('stops fetching for a hidden tab and resumes when it comes back', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(METRICS);
    const poller = createMetricsPoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    poller.setVisible(false);
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    // A dashboard in a background tab is a dashboard nobody is reading.
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    poller.setVisible(true);
    // Coming back refreshes at once: the figures on screen are minutes stale.
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('never starts polling from a visibility change alone', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(METRICS);
    const poller = createMetricsPoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.setVisible(false);
    poller.setVisible(true);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('ignores a second start rather than running two intervals', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(METRICS);
    const poller = createMetricsPoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    poller.start();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    poller.stop();
  });
});

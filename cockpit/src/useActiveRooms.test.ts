/**
 * The polling rules, asserted without a DOM.
 *
 * Every claim here is about restraint rather than about fetching: a poller that
 * keeps running after the page moved on, or stacks requests behind a slow one,
 * or dies on the first offline blip, is a background tax on a page whose whole
 * job is to sit on a hero and wait.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ACTIVE_POLL_MS, createActivePoller } from './useActiveRooms';
import type { ActiveSnapshot } from './telemetry/activeRooms';

const SNAPSHOT: ActiveSnapshot = { rooms: [], generatedAt: 1, degraded: false, fetchedAtMs: 0 };

const INTERVAL = 1000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('createActivePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const onSnapshot = vi.fn();

  beforeEach(() => {
    onSnapshot.mockClear();
  });

  it('polls immediately rather than making the visitor wait out the first interval', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT);
    const poller = createActivePoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    await flush();
    expect(onSnapshot).toHaveBeenCalledWith(SNAPSHOT);

    poller.stop();
  });

  it('polls exactly once per interval thereafter', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT);
    const poller = createActivePoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(fetchSnapshot).toHaveBeenCalledTimes(4);

    // A second start() is not a second poller.
    poller.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(5);

    poller.stop();
  });

  it('defaults to the shipped five-second interval', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT);
    const poller = createActivePoller({ fetchSnapshot, onSnapshot });

    poller.start();
    await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS - 1);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('stops polling a hidden tab and resumes with an immediate poll', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT);
    const poller = createActivePoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    await flush();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    poller.setVisible(false);
    // Not merely skipped ticks — the timer itself is gone.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    poller.setVisible(true);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  it('never starts polling because of visibility alone', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(SNAPSHOT);
    const poller = createActivePoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    // Never started: a tab coming to the foreground is not a request to poll.
    poller.setVisible(false);
    poller.setVisible(true);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(fetchSnapshot).not.toHaveBeenCalled();

    // And a stopped poller stays stopped for the same reason.
    poller.start();
    poller.stop();
    poller.setVisible(false);
    poller.setVisible(true);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('leaves no timer behind and drops a reply that lands after it stopped', async () => {
    const pending = deferred<ActiveSnapshot | null>();
    const fetchSnapshot = vi.fn().mockReturnValue(pending.promise);
    const poller = createActivePoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    poller.stop();
    expect(vi.getTimerCount()).toBe(0);

    // The page has moved on to a call by the time this lands; reporting it would
    // repopulate a list that is no longer on screen.
    pending.resolve(SNAPSHOT);
    await flush();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('polls again after a restart even though the abandoned fetch never settled', async () => {
    const stale = deferred<ActiveSnapshot | null>();
    const fetchSnapshot = vi.fn().mockReturnValue(stale.promise);
    const poller = createActivePoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    poller.stop();
    poller.start();

    // The in-flight flag belongs to the stopped run, not to this one.
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    poller.stop();
    stale.resolve(null);
    await flush();
  });

  it('skips a tick rather than queueing behind a fetch still in flight', async () => {
    const slow = deferred<ActiveSnapshot | null>();
    const fetchSnapshot = vi.fn().mockReturnValue(slow.promise);
    const poller = createActivePoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    slow.resolve(SNAPSHOT);
    await flush();
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    // Once it is clear, the next tick polls normally.
    fetchSnapshot.mockResolvedValue(SNAPSHOT);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('reports a rejected fetch as an absent list and keeps polling', async () => {
    const fetchSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(SNAPSHOT);
    const poller = createActivePoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    await flush();
    expect(onSnapshot).toHaveBeenNthCalledWith(1, null);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onSnapshot).toHaveBeenNthCalledWith(2, SNAPSHOT);

    poller.stop();
  });

  it('survives a fetcher that throws before it ever returns a promise', async () => {
    const fetchSnapshot = vi.fn(() => {
      throw new Error('nope');
    });
    const poller = createActivePoller({ fetchSnapshot, onSnapshot, intervalMs: INTERVAL });

    poller.start();
    expect(onSnapshot).toHaveBeenCalledWith(null);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    poller.stop();
  });
});

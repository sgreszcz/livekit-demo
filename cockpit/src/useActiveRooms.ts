/**
 * Polls `/api/active` while the visitor is looking at the hero.
 *
 * The polling itself is a plain object rather than a hook, and that split is the
 * whole design: this suite runs without a DOM, so anything expressed as a hook
 * is untestable here. Every rule worth asserting — the immediate first poll, the
 * suppression of overlapping fetches, what a stopped poller does with a reply
 * that arrives after it stopped — lives in `createActivePoller`. The hook below
 * is deliberately thin enough to read in one sitting.
 */

import { useEffect, useState } from 'react';
import { fetchActiveRooms, type ActiveSnapshot } from './telemetry/activeRooms';

/**
 * Slow enough that a room list is not a load generator, fast enough that a
 * visitor who dials the number sees their own call appear while the phone is
 * still ringing.
 */
export const ACTIVE_POLL_MS = 5000;

export interface ActivePoller {
  start(): void;
  stop(): void;
  setVisible(visible: boolean): void;
}

interface ActivePollerOptions {
  fetchSnapshot: () => Promise<ActiveSnapshot | null>;
  onSnapshot: (snapshot: ActiveSnapshot | null) => void;
  intervalMs?: number;
}

export function createActivePoller({
  fetchSnapshot,
  onSnapshot,
  intervalMs = ACTIVE_POLL_MS,
}: ActivePollerOptions): ActivePoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let visible = true;
  /** A fetch is outstanding — the interval skips rather than queues behind it. */
  let inFlight = false;
  /**
   * Bumped every time polling is halted, for the same reason `useCockpit`
   * carries one: a fetch in flight cannot be cancelled, and its reply must not
   * repopulate a list belonging to a page that has moved on to a call.
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

  const settle = (mine: number, snapshot: ActiveSnapshot | null) => {
    if (generation !== mine) return;
    inFlight = false;
    onSnapshot(snapshot);
  };

  const poll = () => {
    if (inFlight) return;
    inFlight = true;
    const mine = generation;
    try {
      // `.then(onFulfilled, onRejected)` rather than a trailing `.catch`: a
      // network failure is expected here, and an unhandled rejection every five
      // seconds would drown a console for the whole time a hero is on screen.
      fetchSnapshot().then(
        (snapshot) => settle(mine, snapshot),
        () => settle(mine, null),
      );
    } catch {
      // A fetcher that threw synchronously is still just an absent answer.
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
      // A poller started while the tab is in the background waits for the tab.
      if (visible) resume();
    },
    stop() {
      started = false;
      halt();
    },
    setVisible(next: boolean) {
      if (next === visible) return;
      visible = next;
      // Visibility never starts polling on its own: a poller that was never
      // started, or was stopped, stays stopped whatever the tab does.
      if (!started) return;
      if (next) resume();
      else halt();
    },
  };
}

/**
 * The live room list, or null when there is nothing to show or nothing was
 * asked for. `enabled` is false during a call, a replay and a debrief — the
 * visitor is looking at instruments, not at a lobby.
 */
export function useActiveRooms(enabled: boolean): ActiveSnapshot | null {
  const [snapshot, setSnapshot] = useState<ActiveSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) {
      // A stale list rendered the moment a call ends would advertise calls that
      // may have hung up while this browser was busy.
      setSnapshot(null);
      return;
    }

    const poller = createActivePoller({ fetchSnapshot: fetchActiveRooms, onSnapshot: setSnapshot });
    const syncVisibility = () => poller.setVisible(document.visibilityState !== 'hidden');

    syncVisibility();
    poller.start();
    document.addEventListener('visibilitychange', syncVisibility);

    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      poller.stop();
    };
  }, [enabled]);

  return snapshot;
}

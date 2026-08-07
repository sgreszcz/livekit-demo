/**
 * Notices when the tab is running a bundle the server has replaced.
 *
 * A single-page app is a program the visitor downloaded once. Deploy a fix and
 * every open tab keeps running the old one until somebody happens to refresh —
 * which cost a live session an hour of confusion when a fix that was visibly
 * deployed was invisibly absent from the page being demonstrated.
 *
 * The mechanism, end to end:
 *
 *   - Vite emits the entry chunk as `/assets/index-<hash>.js`, where the hash is
 *     the content. A new deploy of changed code is a new filename, always.
 *   - `import.meta.url` in a bundled module is the URL of the chunk that module
 *     ended up in. This file is imported statically from the entry, so it lands
 *     in the entry chunk, and its `import.meta.url` IS the running bundle's URL.
 *     No build-time injection, no `__BUILD_ID__` define, nothing to keep in sync.
 *   - `index.html` names the current entry chunk in its script tag. Fetching it
 *     with `cache: 'reload'` gets the deployed one rather than the one in the
 *     HTTP cache, which would otherwise be the very bundle we are questioning.
 *   - Different filenames, different code. Reload.
 *
 * Both sides are parsed by the same function against the same pattern, so the
 * comparison cannot be fooled by a difference in how each side was read. And if
 * the running URL does not match that pattern at all — a dev server, where this
 * module is `/src/bundleWatch.ts`, or a future build that splits the entry into
 * a differently-named chunk — the watcher disables itself rather than guessing.
 * A watcher that is wrong about what it is running would reload forever.
 *
 * Everything here fails soft. A failed fetch, an unparseable page, a proxy
 * serving something that is not the app: all of them mean "no information", and
 * no information never reloads.
 */

import { useEffect, useRef } from 'react';
import type { CockpitMode } from './useCockpit';

/**
 * Five minutes. A deploy landing mid-demo is the case this exists for, and a
 * tab that catches up within five minutes catches up in time to matter; more
 * often than that is a request-per-visitor cost for no additional rescue.
 */
export const BUNDLE_CHECK_MS = 5 * 60 * 1000;

/**
 * Long enough for a slow mobile round trip, short enough that a dead socket
 * costs one check rather than the rest of the session — the in-flight guard
 * below would otherwise be held forever by a request that never settles.
 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * The entry chunk Vite emits, as it appears in both `index.html` and in a module
 * URL. Vite's hashes are base64url-ish, hence the `-` and `_`.
 */
const BUNDLE_ASSET = /\/assets\/(index-[A-Za-z0-9_-]+\.js)\b/;

/**
 * The entry chunk's filename found in any text — a served HTML document or the
 * URL of the running module. Null when there is not one, which is the answer
 * for a dev server, an error page, or a proxy that returned something else
 * entirely.
 *
 * Returns the whole filename rather than the hash alone: it is the same
 * comparison and one less thing to parse, and a mismatch in the `index-` prefix
 * is exactly the case where we would rather return null than a bare hash that
 * came from some other asset.
 */
export function extractBundleAsset(text: string): string | null {
  if (typeof text !== 'string') return null;
  const match = BUNDLE_ASSET.exec(text);
  return match === null ? null : match[1];
}

/**
 * Where the code currently executing came from. See the header: null in dev and
 * null for any build whose entry chunk is not `assets/index-*.js`, and null
 * means the watcher never runs.
 */
export function runningBundleAsset(): string | null {
  try {
    return extractBundleAsset(import.meta.url);
  } catch {
    return null;
  }
}

/**
 * `AbortSignal.timeout` is well supported but not universal; a browser without
 * it gets an un-timed fetch, which is what this code would have done anyway.
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * The deployed `index.html`, or null for every possible disappointment.
 *
 * `cache: 'reload'` is the load-bearing option: without it the browser may
 * answer from the same cache that is keeping the stale bundle alive, and the
 * check would compare the running bundle against a record of itself.
 */
export async function fetchDeployedHtml(): Promise<string | null> {
  try {
    const response = await fetch('/', {
      cache: 'reload',
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Where a reload is allowed to happen.
 *
 * The hero and the `/live` holding screen hold no state a visitor could lose —
 * they are a pitch and a waiting room. Everything else does: a call would be
 * hung up mid-sentence, a replay restarted, a debrief's scroll position and its
 * selected turn thrown away. So this is an allow-list of two rather than a
 * deny-list of the rest, because the next mode someone adds should have to opt
 * in to being interruptible.
 */
export function reloadableMode(mode: CockpitMode): boolean {
  return mode === 'idle' || mode === 'error';
}

export interface BundleWatcher {
  /** Enable or suspend checking. Suspending never reloads. */
  setActive(active: boolean): void;
  stop(): void;
}

export interface BundleWatcherOptions {
  /** The running entry chunk. Null disables the watcher entirely. */
  running: string | null;
  fetchHtml: () => Promise<string | null>;
  reload: () => void;
  intervalMs?: number;
  now?: () => number;
}

export function createBundleWatcher({
  running,
  fetchHtml,
  reload,
  intervalMs = BUNDLE_CHECK_MS,
  now = Date.now,
}: BundleWatcherOptions): BundleWatcher {
  let timer: ReturnType<typeof setInterval> | null = null;
  let active = false;
  let stopped = false;
  /** A fetch is outstanding — a tick skips rather than queues behind it. */
  let inFlight = false;
  /**
   * Loading the page WAS a check: the bundle running is by definition the one
   * the server served a moment ago. Tracking the timestamp rather than simply
   * restarting the interval is what stops a visitor who dips in and out of the
   * hero from being checked constantly — and what stops one who spent twenty
   * minutes on a call from waiting another five on their return.
   */
  let lastCheck = now();

  const clearTimer = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const check = () => {
    if (inFlight || stopped || !active) return;
    inFlight = true;
    lastCheck = now();

    const settle = (html: string | null) => {
      inFlight = false;
      /*
       * Re-checked on the way out, and this is the guard that matters most: a
       * request started on the hero can settle a second after the visitor
       * pressed "Call from browser". Reloading then would hang up a call that
       * had just connected — the exact failure this feature is supposed to
       * prevent a subtler version of.
       */
      if (stopped || !active) return;
      if (html === null) return;
      const deployed = extractBundleAsset(html);
      if (deployed === null || deployed === running) return;
      reload();
    };

    try {
      // `.then(onFulfilled, onRejected)` rather than a trailing `.catch`, as in
      // the room poller: a failed check is expected and unremarkable, and an
      // unhandled rejection every five minutes is neither.
      fetchHtml().then(settle, () => settle(null));
    } catch {
      settle(null);
    }
  };

  return {
    setActive(next: boolean) {
      // A watcher that does not know what it is running has nothing to compare
      // against, so it does nothing at all — see the header.
      if (stopped || running === null || next === active) return;
      active = next;
      clearTimer();
      if (!next) return;
      // Enough time has already passed while the visitor was elsewhere, so the
      // check is owed now rather than one full interval from now.
      if (now() - lastCheck >= intervalMs) check();
      timer = setInterval(check, intervalMs);
    },
    stop() {
      stopped = true;
      active = false;
      clearTimer();
    },
  };
}

/**
 * The hook the views use. Thin by design — every rule worth asserting lives in
 * `createBundleWatcher`, which needs no DOM.
 *
 * The watcher is built once and kept across `active` changes, so its sense of
 * when it last checked survives a call: rebuilding it on every mode change
 * would reset that clock and a visitor moving between the hero and a call would
 * never accumulate five minutes of eligibility.
 */
export function useBundleWatch(active: boolean): void {
  const watcherRef = useRef<BundleWatcher | null>(null);
  if (watcherRef.current === null) {
    watcherRef.current = createBundleWatcher({
      running: runningBundleAsset(),
      fetchHtml: fetchDeployedHtml,
      reload: () => window.location.reload(),
    });
  }

  useEffect(() => {
    const watcher = watcherRef.current;
    if (watcher === null) return;

    // A background tab is not looking at anything, and reloading one is a way
    // to lose whatever the visitor scrolled to before they switched away.
    const sync = () => watcher.setActive(active && document.visibilityState !== 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);

    /*
     * Suspended rather than stopped, and that distinction is load-bearing under
     * StrictMode: React deliberately mounts, unmounts and remounts effects in
     * development, so a cleanup that called `stop()` would permanently retire a
     * watcher held in a ref — the feature would be dead for the whole dev
     * session, in exactly the environment where it is being worked on.
     *
     * Nothing leaks by suspending instead. `setActive(false)` clears the
     * interval, and a reply still in flight settles into a no-op because the
     * watcher is no longer active; the object itself is collected with the
     * component that holds it.
     */
    return () => {
      document.removeEventListener('visibilitychange', sync);
      watcher.setActive(false);
    };
  }, [active]);
}

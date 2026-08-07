/**
 * The stale-bundle watcher.
 *
 * Two things are under test and they pull in opposite directions. It has to
 * reload a tab running code the server has replaced — the failure that made this
 * necessary was a fix deployed mid-session that was invisible on the page being
 * demonstrated. And it must never reload for any other reason, because a
 * spurious reload during a call hangs up the call.
 *
 * So most of what follows asserts that nothing happened: a failed fetch, a page
 * that is not the app, a build it cannot identify, a visitor who started a call
 * while the check was in flight. Every one of those is "no information", and no
 * information never reloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  BUNDLE_CHECK_MS,
  createBundleWatcher,
  extractBundleAsset,
  reloadableMode,
} from './bundleWatch';
import type { CockpitMode } from './useCockpit';

/** What Vite actually emits — script tag, modulepreload, stylesheet. */
const DEPLOYED_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Glass Cockpit</title>
    <script type="module" crossorigin src="/assets/index-CU_yuzJn.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/session-BDCeuMe6.js" />
    <link rel="stylesheet" crossorigin href="/assets/index-BtR98gKp.css" />
  </head>
  <body><div id="root"></div></body>
</html>`;

const RUNNING = 'index-CU_yuzJn.js';

describe('extractBundleAsset', () => {
  it('finds the entry chunk in a served document', () => {
    expect(extractBundleAsset(DEPLOYED_HTML)).toBe(RUNNING);
  });

  it('reads a running module URL with the same pattern', () => {
    // The comparison is only sound because both sides are parsed identically —
    // one side is `import.meta.url` at runtime, the other is the served HTML.
    expect(extractBundleAsset('https://cockpit.example/assets/index-CU_yuzJn.js')).toBe(RUNNING);
    expect(extractBundleAsset('https://cockpit.example/assets/index-CU_yuzJn.js?t=1')).toBe(
      RUNNING,
    );
  });

  it('takes the entry chunk rather than the stylesheet beside it', () => {
    // `index-*.css` sits next to `index-*.js` and hashes differently. Matching
    // it would mean comparing a stylesheet against a script forever.
    expect(extractBundleAsset(DEPLOYED_HTML)).toMatch(/\.js$/);
  });

  it('returns null for anything that is not the app', () => {
    for (const text of [
      '', // an empty response
      '<html><body>502 Bad Gateway</body></html>', // a proxy, not the app
      '<script type="module" src="/src/main.tsx"></script>', // the dev server
      '<script src="/assets/vendor-abc123.js"></script>', // some other chunk
      '<script src="/static/index-abc123.js"></script>', // some other path
      'file:///Users/someone/cockpit/src/bundleWatch.ts', // a test runner
    ]) {
      expect(extractBundleAsset(text)).toBeNull();
    }
  });

  it('survives being handed something that is not a string', () => {
    expect(extractBundleAsset(undefined as unknown as string)).toBeNull();
    expect(extractBundleAsset(null as unknown as string)).toBeNull();
  });
});

describe('reloadableMode', () => {
  it('allows a reload only where there is nothing to lose', () => {
    // The hero and the `/live` holding screen. Both are stateless.
    expect(reloadableMode('idle')).toBe(true);
    expect(reloadableMode('error')).toBe(true);
  });

  it('refuses to reload anything a visitor is in the middle of', () => {
    // A call hung up mid-sentence, a replay restarted, a debrief's open turn and
    // scroll position thrown away.
    const busy: CockpitMode[] = ['connecting', 'live', 'replay', 'observing', 'ended'];
    for (const mode of busy) {
      expect(reloadableMode(mode)).toBe(false);
    }
  });
});

describe('createBundleWatcher', () => {
  /** A clock advanced alongside the timers, so "how long since" is explicit. */
  let clock = 0;
  let reload: Mock<() => void>;
  let fetchHtml: Mock<() => Promise<string | null>>;

  const watcher = (overrides: { running?: string | null } = {}) =>
    createBundleWatcher({
      running: overrides.running === undefined ? RUNNING : overrides.running,
      fetchHtml,
      reload,
      now: () => clock,
    });

  /** Moves the world forward: the injected clock and the timer queue together. */
  const advance = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    reload = vi.fn();
    fetchHtml = vi.fn(async () => DEPLOYED_HTML);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not check the moment it is switched on', async () => {
    // The page just loaded the bundle it is running; asking the server about it
    // immediately is a request that can only confirm what we already know.
    const w = watcher();
    w.setActive(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchHtml).not.toHaveBeenCalled();
    w.stop();
  });

  it('checks once an interval has passed, and does nothing when the build matches', async () => {
    const w = watcher();
    w.setActive(true);

    await advance(BUNDLE_CHECK_MS);

    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    w.stop();
  });

  it('reloads when the deployed build is a different one', async () => {
    const w = watcher({ running: 'index-OLDoldOL.js' });
    w.setActive(true);

    await advance(BUNDLE_CHECK_MS);

    expect(reload).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('keeps checking on an interval', async () => {
    const w = watcher();
    w.setActive(true);

    await advance(BUNDLE_CHECK_MS);
    await advance(BUNDLE_CHECK_MS);
    await advance(BUNDLE_CHECK_MS);

    expect(fetchHtml).toHaveBeenCalledTimes(3);
    w.stop();
  });

  it('never reloads on a failed fetch', async () => {
    fetchHtml.mockResolvedValue(null);
    const w = watcher();
    w.setActive(true);

    await advance(BUNDLE_CHECK_MS);

    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    w.stop();
  });

  it('never reloads on a rejected fetch', async () => {
    fetchHtml.mockRejectedValue(new TypeError('Failed to fetch'));
    const w = watcher();
    w.setActive(true);

    await advance(BUNDLE_CHECK_MS);

    expect(reload).not.toHaveBeenCalled();
    // And the failure does not wedge the watcher — the next interval still runs.
    fetchHtml.mockResolvedValue(DEPLOYED_HTML);
    await advance(BUNDLE_CHECK_MS);
    expect(fetchHtml).toHaveBeenCalledTimes(2);
    w.stop();
  });

  it('never reloads on a page it cannot parse', async () => {
    // A captive portal, a 502 from a proxy, an origin serving the wrong site:
    // all of them are "no information", none of them is a new deploy.
    fetchHtml.mockResolvedValue('<html><body>502 Bad Gateway</body></html>');
    const w = watcher();
    w.setActive(true);

    await advance(BUNDLE_CHECK_MS);

    expect(reload).not.toHaveBeenCalled();
    w.stop();
  });

  it('does nothing whatsoever when it cannot identify what it is running', async () => {
    // A dev server, or a build whose entry chunk is named something else. A
    // watcher that is wrong about the running bundle would reload forever, so
    // it does not even ask.
    const w = watcher({ running: null });
    w.setActive(true);

    await advance(BUNDLE_CHECK_MS * 3);

    expect(fetchHtml).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    w.stop();
  });

  it('does not reload a visitor who started a call while the check was in flight', async () => {
    // The guard that matters most. The reply lands a moment after the hero
    // became a call, and reloading then hangs up that call.
    let release: (html: string) => void = () => {};
    fetchHtml.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const w = watcher({ running: 'index-OLDoldOL.js' });
    w.setActive(true);
    await advance(BUNDLE_CHECK_MS);
    expect(fetchHtml).toHaveBeenCalledTimes(1);

    // The visitor presses "Call from browser"; the answer arrives afterwards.
    w.setActive(false);
    release(DEPLOYED_HTML);
    await vi.advanceTimersByTimeAsync(0);

    expect(reload).not.toHaveBeenCalled();
    w.stop();
  });

  it('stops checking once suspended, and leaves no timer behind', async () => {
    const w = watcher();
    w.setActive(true);
    await advance(BUNDLE_CHECK_MS);
    expect(fetchHtml).toHaveBeenCalledTimes(1);

    w.setActive(false);
    // Suspending has to be a complete stand-down on its own, because that is
    // all the hook's cleanup does — see the StrictMode note in `useBundleWatch`.
    expect(vi.getTimerCount()).toBe(0);

    await advance(BUNDLE_CHECK_MS * 3);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });

  it('can be suspended and resumed indefinitely', async () => {
    // The hook suspends rather than stops precisely so that this holds: under
    // StrictMode a component mounts, unmounts and remounts, and a watcher that
    // treated the first cleanup as final would be dead for the whole session.
    const w = watcher();
    w.setActive(true);
    w.setActive(false);
    w.setActive(true);

    await advance(BUNDLE_CHECK_MS);

    expect(fetchHtml).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('checks straight away for a visitor returning after a long call', async () => {
    // Twenty minutes on a call, then back to the hero: the check is already
    // owed, and making them wait another five minutes would be the same bug in
    // slow motion.
    const w = watcher();
    w.setActive(true);
    w.setActive(false);

    await advance(BUNDLE_CHECK_MS * 4);
    expect(fetchHtml).not.toHaveBeenCalled();

    w.setActive(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchHtml).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('does not check again for a visitor who merely glanced away', async () => {
    // Toggling between the hero and a replay a few times must not turn into a
    // request per toggle.
    const w = watcher();
    w.setActive(true);
    await advance(BUNDLE_CHECK_MS);
    expect(fetchHtml).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      w.setActive(false);
      await advance(1000);
      w.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(fetchHtml).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('leaves no timer behind when stopped', async () => {
    const w = watcher();
    w.setActive(true);
    expect(vi.getTimerCount()).toBe(1);

    w.stop();
    expect(vi.getTimerCount()).toBe(0);

    // And a stopped watcher stays stopped, whatever it is told afterwards.
    w.setActive(true);
    await advance(BUNDLE_CHECK_MS * 2);
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it('does not queue a second check behind one that has not answered', async () => {
    fetchHtml.mockImplementation(() => new Promise<string>(() => {}));
    const w = watcher();
    w.setActive(true);

    await advance(BUNDLE_CHECK_MS * 3);

    expect(fetchHtml).toHaveBeenCalledTimes(1);
    w.stop();
  });
});

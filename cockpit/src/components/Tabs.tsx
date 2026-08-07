/**
 * Top-level navigation: one call, or every call.
 *
 * Real anchors with real hrefs, intercepted for the SPA rather than replaced by
 * it. That is what makes them middle-clickable, copyable and crawlable, and it
 * means the Worker's index.html fallback is a genuine fallback — a visitor who
 * lands on /dashboard from a pasted link gets the dashboard, not a redirect
 * through the cockpit.
 *
 * Modified clicks (new tab, new window, download) are left entirely alone: the
 * browser already does the right thing with them and a preventDefault here
 * would quietly break the one gesture power users reach for.
 */

import type { MouseEvent } from 'react';
import { navigate, type Route } from '../router';

interface Tab {
  path: string;
  label: string;
  kinds: Route['kind'][];
}

/**
 * A debrief is a cockpit — the same instruments over a recording — so it lights
 * the Cockpit tab rather than leaving the bar with nothing current on it. So is
 * `/live`: the same instruments over somebody else's call.
 */
const TABS: Tab[] = [
  { path: '/', label: 'Cockpit', kinds: ['home', 'debrief', 'live'] },
  { path: '/dashboard', label: 'Dashboard', kinds: ['dashboard'] },
];

export function Tabs({ route }: { route: Route['kind'] }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // Anything but a primary click is the browser's business.
    if (event.button !== 0) return;
    event.preventDefault();
    navigate(path);
  };

  return (
    <nav className="tabs" aria-label="Sections">
      {TABS.map((tab) => {
        const current = tab.kinds.includes(route);
        return (
          <a
            key={tab.path}
            className={`tab${current ? ' tab--current' : ''}`}
            href={tab.path}
            aria-current={current ? 'page' : undefined}
            onClick={(event) => onClick(event, tab.path)}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}

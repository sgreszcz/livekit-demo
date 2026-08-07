/**
 * Route parsing.
 *
 * Small, but it decides what a pasted link opens, and the Worker serves
 * index.html for every path — so anything this function does not recognise
 * silently becomes the cockpit rather than a 404. That makes the negative cases
 * the interesting ones: `/dashboards` and `/dashboard/extra` must not quietly
 * render the fleet page, or the SPA fallback turns typos into wrong answers.
 */

import { describe, expect, it } from 'vitest';
import { parseRoute } from './router';

describe('parseRoute', () => {
  it('reads the cockpit at the root', () => {
    expect(parseRoute('/')).toEqual({ kind: 'home' });
  });

  it('reads the dashboard, with or without a trailing slash', () => {
    expect(parseRoute('/dashboard')).toEqual({ kind: 'dashboard' });
    expect(parseRoute('/dashboard/')).toEqual({ kind: 'dashboard' });
  });

  it('reads a stored debrief and keeps its id', () => {
    expect(parseRoute('/call/k7Qx2f')).toEqual({ kind: 'debrief', id: 'k7Qx2f' });
  });

  it('falls back to the cockpit for anything it does not recognise', () => {
    for (const path of [
      '/dashboards',
      '/dashboard/extra',
      '/Dashboard',
      '/dash',
      '/dashboard?x=1', // a query is not part of the pathname; this is a typo
      '/call/',
      '/call/not-base62!',
      '',
    ]) {
      expect(parseRoute(path)).toEqual({ kind: 'home' });
    }
  });

  it('does not mistake a debrief whose id spells dashboard', () => {
    expect(parseRoute('/call/dashboard')).toEqual({ kind: 'debrief', id: 'dashboard' });
  });
});

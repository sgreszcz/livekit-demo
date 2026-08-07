/**
 * Three routes and no dependency. `/` is the cockpit, `/dashboard` is the fleet
 * view, `/call/:id` is a stored debrief; the Worker serves index.html for all of
 * them, so each one is a real link that survives a refresh and a paste.
 */

import { useEffect, useState } from 'react';

export type Route = { kind: 'home' } | { kind: 'dashboard' } | { kind: 'debrief'; id: string };

const DEBRIEF_PATH = /^\/call\/([A-Za-z0-9]{1,32})\/?$/;
const DASHBOARD_PATH = /^\/dashboard\/?$/;

export function parseRoute(pathname: string): Route {
  const match = DEBRIEF_PATH.exec(pathname);
  if (match) return { kind: 'debrief', id: match[1] };
  if (DASHBOARD_PATH.test(pathname)) return { kind: 'dashboard' };
  return { kind: 'home' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return route;
}

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

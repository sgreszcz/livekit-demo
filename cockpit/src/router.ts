/**
 * Two routes and no dependency. `/` is the cockpit, `/call/:id` is a stored
 * debrief; the Worker serves index.html for both.
 */

import { useEffect, useState } from 'react';

export type Route = { kind: 'home' } | { kind: 'debrief'; id: string };

const DEBRIEF_PATH = /^\/call\/([A-Za-z0-9]{1,32})\/?$/;

export function parseRoute(pathname: string): Route {
  const match = DEBRIEF_PATH.exec(pathname);
  return match ? { kind: 'debrief', id: match[1] } : { kind: 'home' };
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

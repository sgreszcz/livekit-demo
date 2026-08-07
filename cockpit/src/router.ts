/**
 * Four routes and no dependency. `/` is the cockpit, `/dashboard` is the fleet
 * view, `/live` watches whatever call is on the agent right now, `/call/:id` is
 * a stored debrief; the Worker serves index.html for all of them, so each one is
 * a real link that survives a refresh and a paste.
 */

import { useEffect, useState } from 'react';
import { isObservableRoom } from './telemetry/activeRooms';

export type Route =
  | { kind: 'home' }
  | { kind: 'dashboard' }
  /** `room` is the call the link asked for, or null for "whichever is newest". */
  | { kind: 'live'; room: string | null }
  | { kind: 'debrief'; id: string };

const DEBRIEF_PATH = /^\/call\/([A-Za-z0-9]{1,32})\/?$/;
const DASHBOARD_PATH = /^\/dashboard\/?$/;
const LIVE_PATH = /^\/live\/?$/;

/**
 * The room a `/live` link names, or null.
 *
 * Validated with the same gate the room list applies before rendering a Watch
 * button, and for the same reason: a name that fails it is one the Worker will
 * answer 403 for, so accepting it here would turn a pasted typo into a failed
 * join. Null is not an error — it is the ordinary case, and it means "the newest
 * call", which is what a bare `/live` asks for anyway.
 */
function liveRoom(search: string): string | null {
  const room = queryValue(search, 'room');
  return room !== null && isObservableRoom(room) ? room : null;
}

/**
 * One query parameter, decoded as a URI component rather than as a form field.
 *
 * `URLSearchParams` would be the obvious tool and is the wrong one here, for a
 * reason that breaks precisely the case this link exists for. SIP dispatch
 * embeds the caller's number in the room name (`sip-cockpit-_+447700900123_…`),
 * and `URLSearchParams` implements form-encoding, in which a literal `+` means
 * a SPACE. A link this app builds survives that — `encodeURIComponent` writes
 * `%2B` — but the same URL retyped, or passed through anything that tidied up
 * its escaping, arrives as a room name with a space in it and is rejected.
 *
 * `decodeURIComponent` is the rule that matches how these URLs are actually
 * written and read: `%2B` becomes `+`, a literal `+` stays a `+`, and `%20`
 * still becomes a space — which is not a legal room character and is therefore
 * still refused. Somebody who genuinely encoded a space does not get one
 * silently turned into something else.
 */
function queryValue(search: string, key: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search;

  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    if ((eq < 0 ? pair : pair.slice(0, eq)) !== key) continue;

    try {
      return eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1));
    } catch {
      // A malformed escape — `%zz` — throws. A name that cannot be read is not
      // a name, and this is a pasted link, so malformed is entirely ordinary.
      return null;
    }
  }

  return null;
}

/**
 * `search` is separate because `window.location` keeps them separate, and the
 * pathname patterns above must never see a query string — `/dashboard?x=1` is a
 * typo, not the dashboard, and that is asserted in the tests.
 */
export function parseRoute(pathname: string, search = ''): Route {
  const match = DEBRIEF_PATH.exec(pathname);
  if (match) return { kind: 'debrief', id: match[1] };
  if (DASHBOARD_PATH.test(pathname)) return { kind: 'dashboard' };
  if (LIVE_PATH.test(pathname)) return { kind: 'live', room: liveRoom(search) };
  return { kind: 'home' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, window.location.search),
  );

  useEffect(() => {
    const onPopState = () =>
      setRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return route;
}

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

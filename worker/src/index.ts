/**
 * Glass Cockpit edge Worker — the API half of the deployment.
 *
 * Static hosting is handled by the asset router, not by this code:
 * `run_worker_first` in wrangler.jsonc sends only `/api/*` here, so the built
 * SPA (and the SPA fallback that makes `/call/:id` render) is served without
 * ever invoking a Worker. Everything below is therefore an API route.
 */

import { handleActiveGet } from './active';
import { handleDebriefGet, handleDebriefPost } from './debrief';
import type { Env } from './env';
import { error } from './http';
import { handleMetricsGet } from './metrics';
import { handleToken } from './token';

const DEBRIEF_ITEM = /^\/api\/debrief\/([^/]+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/token') {
      return handleToken(request, env);
    }

    // Calls in progress right now, for the hero's "listen in" affordance. Polled
    // by every open front page, so it answers 200 even when LiveKit does not.
    if (pathname === '/api/active') {
      return request.method === 'GET' ? handleActiveGet(env) : error(405, 'Use GET');
    }

    // Fleet aggregate over every stored debrief. Public and derived-only — see
    // metrics.ts — so Grafana can scrape it without a credential.
    if (pathname === '/api/metrics') {
      return request.method === 'GET' ? handleMetricsGet(env) : error(405, 'Use GET');
    }

    if (pathname === '/api/debrief') {
      return request.method === 'POST' ? handleDebriefPost(request, env) : error(405, 'Use POST');
    }

    const item = DEBRIEF_ITEM.exec(pathname);
    if (item) {
      return request.method === 'GET'
        ? handleDebriefGet(decodeURIComponent(item[1]), env)
        : error(405, 'Use GET');
    }

    return error(404, 'No such endpoint');
  },
} satisfies ExportedHandler<Env>;

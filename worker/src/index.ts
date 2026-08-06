/**
 * Glass Cockpit edge Worker — the API half of the deployment.
 *
 * Static hosting is handled by the asset router, not by this code:
 * `run_worker_first` in wrangler.jsonc sends only `/api/*` here, so the built
 * SPA (and the SPA fallback that makes `/call/:id` render) is served without
 * ever invoking a Worker. Everything below is therefore an API route.
 */

import { handleDebriefGet, handleDebriefPost } from './debrief';
import type { Env } from './env';
import { error } from './http';
import { handleToken } from './token';

const DEBRIEF_ITEM = /^\/api\/debrief\/([^/]+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/token') {
      return handleToken(request, env);
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

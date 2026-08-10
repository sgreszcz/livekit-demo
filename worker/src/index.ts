/**
 * Glass Cockpit edge Worker — the API half of the deployment.
 *
 * Static hosting is handled by the asset router, not by this code:
 * `run_worker_first` in wrangler.jsonc sends only `/api/*` here, so the built
 * SPA (and the SPA fallback that makes `/call/:id` render) is served without
 * ever invoking a Worker. Everything below is therefore an API route.
 *
 * Two responsibilities live here rather than in the handlers, because they have
 * to apply to routes uniformly and a per-handler version would eventually miss
 * one:
 *
 *  * **Decoding the path safely.** `decodeURIComponent` throws `URIError` on
 *    malformed percent-encoding — `/api/debrief/%`, `%zz`, a truncated `%E0%A4%A`
 *    — and an uncaught throw in a Worker's `fetch` is a 500. A malformed URL is
 *    the client's mistake and must read as one.
 *  * **Rate limiting the two routes that cost money.** See `ratelimit.ts`.
 */

import { handleActiveGet } from './active';
import { handleTwilioAlert } from './alerts';
import { handleDebriefGet, handleDebriefPost, handleDebriefPut } from './debrief';
import type { Env } from './env';
import { error, methodNotAllowed, tooManyRequests } from './http';
import { handleMetricsGet } from './metrics';
import { ALERT_WINDOWS, check, clientKey, DEBRIEF_WINDOWS, TOKEN_WINDOWS } from './ratelimit';
import { handleToken } from './token';
import { runWarmup } from './warmup';

const DEBRIEF_ITEM = /^\/api\/debrief\/([^/]+)$/;

/**
 * `decodeURIComponent` that answers "not decodable" instead of throwing.
 *
 * The id is matched against a strict allowlist downstream either way, so this
 * is about the status code: a `URIError` escaping here turns a bad request into
 * a 500 and an alert.
 */
function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export default {
  /**
   * `ctx` is declared optional so the router's own tests can call `fetch` with
   * the two arguments they have always passed. The runtime always supplies it;
   * the only path that needs it is the debrief POST's deferred spend ledger,
   * which is pinned by a test that does pass one.
   */
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return error(400, 'Malformed request URL');
    }

    if (pathname === '/api/token') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      // Every token that gets used spawns an agent that speaks — real STT, LLM
      // and TTS spend on an endpoint with no credential in front of it.
      const decision = check('token', clientKey(request), TOKEN_WINDOWS);
      if (!decision.ok) return tooManyRequests(decision.retryAfter);
      return handleToken(request, env);
    }

    // Calls in progress right now, for the hero's "listen in" affordance. Polled
    // by every open front page, so it answers 200 even when LiveKit does not.
    if (pathname === '/api/active') {
      return request.method === 'GET' ? handleActiveGet(env) : methodNotAllowed('GET');
    }

    // Fleet aggregate over every stored debrief. Public and derived-only — see
    // metrics.ts — so Grafana can scrape it without a credential.
    if (pathname === '/api/metrics') {
      return request.method === 'GET' ? handleMetricsGet(env) : methodNotAllowed('GET');
    }

    if (pathname === '/api/debrief') {
      // PUT is the agent's in-flight checkpoint and is bearer-only; the handler
      // rejects anything else, so it is not rate limited — a credentialled
      // writer checkpointing its own call is the behaviour we want.
      if (request.method === 'PUT') return handleDebriefPut(request, env);

      if (request.method === 'POST') {
        // Only the anonymous path is limited. An agent presenting a bearer
        // token is the writer this endpoint exists for, and throttling it would
        // drop real recordings; the token is the thing standing in for a limit.
        if (!request.headers.get('authorization')) {
          const decision = check('debrief', clientKey(request), DEBRIEF_WINDOWS);
          if (!decision.ok) return tooManyRequests(decision.retryAfter);
        }
        // The spend ledger and its email hang off `waitUntil`, so they cost the
        // agent's teardown path nothing. See handleDebriefPost.
        return handleDebriefPost(request, env, ctx && ((work) => ctx.waitUntil(work)));
      }

      return methodNotAllowed('POST', 'PUT');
    }

    // Twilio usage triggers, relayed to email. Authenticated by a secret in the
    // query string — Twilio signs nothing this Worker can cheaply verify, so the
    // callback URL IS the credential — and limited tightly, because a leaked
    // callback URL is otherwise an email sender.
    if (pathname === '/api/alerts/twilio') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const decision = check('alerts', clientKey(request), ALERT_WINDOWS);
      if (!decision.ok) return tooManyRequests(decision.retryAfter);
      return handleTwilioAlert(request, env);
    }

    const item = DEBRIEF_ITEM.exec(pathname);
    if (item) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const id = decodePathSegment(item[1]);
      if (id === null) return error(400, 'Malformed call id');
      return handleDebriefGet(id, env);
    }

    return error(404, 'No such endpoint');
  },

  /**
   * The keep-warm cron. See warmup.ts for what it does and why it exists.
   *
   * This Worker is the scheduler because it is the only piece of the deployment that is
   * already running somewhere reliable — the alternative was a cron on a laptop, which is
   * a warm agent exactly as often as the laptop is open.
   *
   * `runWarmup` is awaited rather than handed to `ctx.waitUntil`. The whole ping is two
   * short LiveKit round trips with a hard request timeout, so there is nothing to overlap
   * with; awaiting means the invocation's duration is the ping's duration, which is the
   * number to look at if these ever start timing out.
   *
   * It never rejects — every failure is a return value — so this handler cannot fail the
   * cron invocation. The try/catch is for the case that contradicts that sentence: an
   * error thrown before `runWarmup`'s own guards, by a future edit or by constructing the
   * SDK client. A failed cron run buys nothing over a logged one, and a cron reporting
   * failures is a cron somebody eventually disables.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    // Declared and unused. `ctx.waitUntil` is the thing not being reached for here, per
    // the note above, and naming it is cheaper than leaving a reader to wonder whether
    // the handler simply never had access to it.
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const outcome = await runWarmup(env);
      console.log(`warm-up: ${outcome}`);
    } catch (cause) {
      console.log(`warm-up: threw unexpectedly: ${String(cause)}`);
    }
  },
} satisfies ExportedHandler<Env>;

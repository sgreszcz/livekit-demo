/**
 * A proportionate bound on the two routes that cost real money.
 *
 * `POST /api/token` is unauthenticated by design — the whole demo is "click the
 * button and talk to it" — and the agent is dispatched automatically, because
 * `AgentServer()` is constructed with no `agent_name`. So every token minted and
 * used spawns an agent that immediately speaks a greeting, and that greeting is
 * billable STT, LLM and TTS on somebody's card. A script in a loop is a bill,
 * not a nuisance. `POST /api/debrief` is cheaper but also unauthenticated, and
 * every anonymous body is a KV write.
 *
 * ## What this is, and what it is not
 *
 * The counters live in the isolate's memory. That is a deliberate, and honest,
 * tradeoff for a demo:
 *
 *  * It costs nothing — no KV reads on the hot path, no Durable Object, no new
 *    binding, and therefore no deploy-time configuration that could be wrong.
 *  * Cloudflare runs many isolates, so a determined attacker distributing
 *    requests across colos gets a multiple of the nominal limit. This is a
 *    damper on casual abuse and on the accidental infinite loop, NOT a
 *    guarantee. The same caveat already applies to the memo in `active.ts`, and
 *    it is stated here rather than left for someone to discover from a bill.
 *  * Fixing that properly means a Durable Object or the platform's rate-limit
 *    binding. Both are the right answer if this ever stops being a demo; the
 *    interface below does not change when they arrive.
 *
 * Storing counters in the debriefs KV namespace was considered and rejected:
 * /api/metrics lists that namespace, so rate-limit keys would consume its list
 * budget and an attacker could crowd real calls out of the dashboard by
 * generating counter keys.
 */

/** One window: at most `limit` requests per `windowMs`. */
export interface Window {
  limit: number;
  windowMs: number;
}

/*
 * ## The limits are deliberately generous, and that is the design
 *
 * The audience for this demo is a recruiter, a hiring manager, and a handful of
 * LiveKit engineers — quite possibly several of them behind ONE office NAT,
 * arriving in the same ten minutes because somebody shared the link in a
 * channel. To this limiter that is a single client making a burst of requests,
 * which is precisely the shape of the thing it is meant to stop.
 *
 * So the numbers below are set where a human being can never reach them and a
 * `while true` loop trips them in seconds. A legitimate visitor seeing a 429 on
 * a portfolio piece is a worse outcome than an afternoon of wasted inference:
 * the demo failing in front of the person it was built for costs the thing it
 * was built to buy. A runaway script costs money, which is recoverable.
 *
 * Read these as a circuit breaker, not a quota.
 */

/**
 * Thirty a minute is about one every two seconds sustained — no room full of
 * people clicking "start a call" produces that, and a script does it instantly.
 * The hourly window catches the slow drip that never trips the per-minute one.
 */
export const TOKEN_WINDOWS: Window[] = [
  { limit: 30, windowMs: 60_000 },
  { limit: 200, windowMs: 60 * 60_000 },
];

/**
 * Looser still. Refusing a debrief loses a recording rather than saving money —
 * the failure is asymmetric in the other direction from tokens, so the bar is
 * higher.
 */
export const DEBRIEF_WINDOWS: Window[] = [
  { limit: 60, windowMs: 60_000 },
  { limit: 400, windowMs: 60 * 60_000 },
];

/**
 * Distinct clients tracked before the table is swept. Bounded so that a
 * spray of forged addresses cannot grow the isolate's memory without limit —
 * the sweep drops whoever has been quiet longest.
 */
const MAX_CLIENTS = 10_000;

/**
 * How far a sweep cuts back to. The gap between this and `MAX_CLIENTS` is what
 * makes the sweep amortised: evicting down to exactly the ceiling would mean
 * the very next request is over it again, so every subsequent request pays a
 * full scan and sort. Cutting to a low-water mark instead buys 2500 cheap
 * insertions before the next sweep, turning O(n) per request into O(1).
 */
const SWEEP_TO = 7_500;

/** Per bucket, per client: the timestamps of recent requests, oldest first. */
const buckets = new Map<string, Map<string, number[]>>();

/** Drop all counters. Tests only. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * How many clients a bucket is currently tracking. Tests only — it exists so the
 * memory bound can be asserted rather than assumed.
 */
export function tracked(bucket: string): number {
  return buckets.get(bucket)?.size ?? 0;
}

/**
 * Who is asking.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be forged by the client;
 * `X-Forwarded-For` can be, and is deliberately not consulted. A request with
 * no address at all — only really possible in tests and local dev — shares a
 * single bucket rather than escaping the limit.
 */
export function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

export interface Decision {
  ok: boolean;
  /** Seconds the client should wait, for the `Retry-After` header. */
  retryAfter: number;
}

/**
 * Record a request and say whether it is allowed.
 *
 * A refused request is NOT recorded. Recording it would let a client that is
 * already over the limit keep pushing its own window forward, so a tight retry
 * loop would extend its own ban indefinitely — punishing a buggy client far
 * more than the policy intends.
 */
export function check(
  bucket: string,
  client: string,
  windows: Window[],
  now = Date.now(),
): Decision {
  let clients = buckets.get(bucket);
  if (clients === undefined) {
    clients = new Map();
    buckets.set(bucket, clients);
  }

  const longest = Math.max(...windows.map((window) => window.windowMs));
  const hits = (clients.get(client) ?? []).filter((at) => now - at < longest);

  for (const window of windows) {
    const inWindow = hits.filter((at) => now - at < window.windowMs);
    if (inWindow.length >= window.limit) {
      // The oldest hit in this window is the one that has to age out.
      const oldest = inWindow[0];
      clients.set(client, hits);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((window.windowMs - (now - oldest)) / 1000)) };
    }
  }

  hits.push(now);
  clients.set(client, hits);

  if (clients.size > MAX_CLIENTS) sweep(clients, now, longest);

  return { ok: true, retryAfter: 0 };
}

/**
 * Bring the table back under `MAX_CLIENTS`, in two passes.
 *
 * Expiry alone is not a bound, which is the bug this replaces. Dropping only
 * clients whose history has fully aged out means a flood of *fresh* addresses —
 * a spoofed spray, or simply a very busy hour — deletes nothing at all: the map
 * grows without limit, and because this runs whenever the table is oversized,
 * every subsequent request pays a full O(n) scan. Unbounded memory and a CPU
 * sink from the same line.
 *
 * So expiry first, because it is free and correct, and then, only if that was
 * not enough, evict whoever has been quiet longest until the table fits. An
 * evicted client gets a fresh allowance, which is the right way to fail: under
 * an address flood the limiter degrades toward permissive rather than toward
 * refusing everybody, and a demo that stops working is worse than one that is
 * briefly over-generous.
 */
function sweep(clients: Map<string, number[]>, now: number, longest: number): void {
  for (const [client, hits] of clients) {
    const live = hits.filter((at) => now - at < longest);
    if (live.length === 0) clients.delete(client);
    else clients.set(client, live);
  }

  if (clients.size <= SWEEP_TO) return;

  // Oldest last-seen first. `hits` is append-ordered, so the final element is
  // the most recent thing that client did.
  const byLastSeen = [...clients.entries()].sort(
    (a, b) => (a[1][a[1].length - 1] ?? 0) - (b[1][b[1].length - 1] ?? 0),
  );
  for (const [client] of byLastSeen.slice(0, clients.size - SWEEP_TO)) {
    clients.delete(client);
  }
}

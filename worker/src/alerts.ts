/**
 * Spend alerts: the two bills this demo can run up without anyone noticing.
 *
 * Everything else in this Worker is about what a call *did*. This file is about
 * what a call *cost*, and about the fact that nobody watches a dashboard on a
 * Sunday. Two independent producers, one destination:
 *
 *  * **Twilio**, which meters the demo phone number and fires usage triggers of
 *    its own. Those triggers POST here (`POST /api/alerts/twilio`) and are
 *    relayed to email. Twilio's own alert emails go to the account address; this
 *    route exists so the alert lands in the same place as everything else and so
 *    the trigger can be aimed at a URL rather than at an inbox nobody reads.
 *  * **LiveKit agent minutes**, which nothing external meters at all. The plan
 *    allows `PLAN_CEILING_MINUTES` per period and the only signal that the
 *    budget is going is the LiveKit console. So the Worker keeps its own ledger,
 *    fed by the debriefs the agent already posts, and mails when it crosses a
 *    threshold. It counts what LiveKit charges — each session rounded up to the
 *    whole minute, see `billableMinutes` — and not wall clock, because on this
 *    demo's call lengths those are not the same number.
 *
 * ## Injected ports, and why nothing here throws
 *
 * `Emailer` is a port for the same reason `WarmupApi` is one: the decision logic
 * — did this cross a threshold, has it already been alerted, what does the body
 * say — is worth testing and the `send_email` binding is not worth faking. And
 * `emailerFor` returns null rather than throwing when the binding is absent, so
 * a caller answers with a named outcome instead of a stack trace.
 *
 * Every failure path in this module logs and swallows. An alert is a courtesy:
 * failing a debrief upload (a real recording, unrecoverable) or a Twilio webhook
 * (which would be retried, repeatedly, forever) in order to report that an email
 * did not send would cost strictly more than the missing email.
 */

import { readCappedBody } from './debrief';
import type { Env } from './env';
import { error, json, timingSafeEqual } from './http';
import type { CallSummary } from './metrics';

/** Verified destination on the account. Alerts have exactly one reader. */
const ALERT_TO = 'admin@agentmaker.io';
/** Onboarded sender domain. Anything else is rejected by Email Sending. */
const ALERT_FROM = 'alerts@agentmaker.io';
const ALERT_FROM_NAME = 'Glass Cockpit alerts';

/**
 * Agent session minutes the LiveKit plan allows per period.
 *
 * The same number the keep-warm window in wrangler.jsonc is sized against — the
 * cron deliberately does not run 24/7 because these minutes are metered. Stated
 * in the alert body so the recipient does not have to remember it.
 */
const PLAN_CEILING_MINUTES = 1000;

/** Where a Twilio alert tells the reader to go and look. */
const TWILIO_CONSOLE_URL = 'https://console.twilio.com/us1/monitor/usage';

/** Thresholds used when `USAGE_ALERT_MINUTES` is not set at all. */
const DEFAULT_ALERT_MINUTES = '500,800';

/** A composed alert. Both bodies are always sent; readers differ. */
export interface AlertMessage {
  subject: string;
  text: string;
  html: string;
}

/**
 * The one thing this module does to the outside world. A port, so the tests can
 * assert on what would have been sent rather than on whether a binding was
 * called with the shape Cloudflare happens to want this month.
 */
export interface Emailer {
  send(message: AlertMessage): Promise<void>;
}

export interface AlertDeps {
  /** Injected by tests. Falls back to the `send_email` binding. */
  emailer?: Emailer;
}

/**
 * The real port, or null when the Worker has no `EMAIL` binding.
 *
 * Null rather than a throwing stub: a deployment without the binding is a
 * misconfiguration, and the honest response to it is a named outcome the caller
 * can log and return 200 on — see `handleTwilioAlert`.
 */
export function emailerFor(env: Env): Emailer | null {
  const binding = env.EMAIL;
  if (!binding) return null;

  return {
    send: async (message: AlertMessage) => {
      await binding.send({
        to: ALERT_TO,
        from: { email: ALERT_FROM, name: ALERT_FROM_NAME },
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}

/**
 * Escape for interpolation into the HTML body.
 *
 * Every value that reaches this comes off a form-encoded request body. The key
 * in the query string is what says the request is trustworthy; the body is
 * display data and is treated as hostile regardless.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A subject line cannot carry a newline: a header is one line, and a value that
 * contains CR or LF is an injected header rather than a long subject.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/* ------------------------------------------------------------------ *
 * A. Twilio usage triggers, relayed
 * ------------------------------------------------------------------ */

/**
 * The fields a Twilio usage trigger posts, transcribed from Twilio's
 * usage-trigger documentation rather than written from memory.
 *
 * That distinction earned its place: an earlier draft of this file invented
 * `CurrentUsage`. The parameter is `CurrentValue`, and a field name that does
 * not exist reads, at the far end, exactly like a trigger that fired with
 * nothing in it — the alert still arrives, still looks right, and quietly omits
 * the only number anybody wanted.
 *
 * All optional, all strings. Twilio sends `application/x-www-form-urlencoded`,
 * and the trust anchor for this route is the key in the callback URL — not the
 * body. A trigger that fires with a body this Worker does not recognise is still
 * a trigger that fired, and suppressing the email over a missing display field
 * would turn a schema change into silence about spend.
 */
export interface TwilioAlertFields {
  AccountSid?: string;
  UsageTriggerSid?: string;
  DateFired?: string;
  Recurring?: string;
  UsageCategory?: string;
  TriggerBy?: string;
  TriggerValue?: string;
  CurrentValue?: string;
  UsageRecordUri?: string;
  IdempotencyToken?: string;
}

/** Every parameter Twilio documents for a usage-trigger callback, verbatim. */
const TWILIO_FIELD_NAMES = [
  'AccountSid',
  'UsageTriggerSid',
  'DateFired',
  'Recurring',
  'UsageCategory',
  'TriggerBy',
  'TriggerValue',
  'CurrentValue',
  'UsageRecordUri',
  'IdempotencyToken',
] as const;

/** The subset worth putting in an email, and what to call each one there. */
const TWILIO_DISPLAY = [
  ['Category', 'UsageCategory'],
  ['Current value', 'CurrentValue'],
  ['Trigger value', 'TriggerValue'],
  ['Trigger by', 'TriggerBy'],
  ['Recurring', 'Recurring'],
  ['Fired', 'DateFired'],
] as const;

/**
 * How long a relayed trigger is remembered.
 *
 * Twilio retries a callback three times after a 5xx, and a timeout can duplicate
 * a delivery even though this route always answers 200 — the answer only counts
 * if it arrives. `IdempotencyToken` is documented as unique per firing, so it is
 * the right thing to remember. A day covers every retry window Twilio has.
 */
const TWILIO_MARKER_TTL_SECONDS = 24 * 60 * 60;

/**
 * Idempotency markers live in USAGE beside the ledger, and are prefixed so the
 * two cannot collide. The token is body-supplied, so it is capped: a KV key is
 * bounded at 512 bytes and a real token is nowhere near that.
 */
function markerKey(token: string): string {
  return `twilio_${token.slice(0, 128)}`;
}

async function alreadyRelayed(env: Env, token: string): Promise<boolean> {
  if (!env.USAGE) return false;
  try {
    return (await env.USAGE.get(markerKey(token), 'text')) !== null;
  } catch {
    // A failed read is not evidence of a duplicate. A repeated spend alert is a
    // nuisance; a suppressed one is the thing this file exists to prevent.
    return false;
  }
}

/**
 * Marked BEFORE the send, which makes the relay at-most-once rather than
 * at-least-once. Deliberate: the duplicate this is guarding against is Twilio
 * re-firing an alert that already reached the inbox, and a mail that failed to
 * send has left a `console.error` behind to say so.
 */
async function markRelayed(env: Env, token: string): Promise<void> {
  if (!env.USAGE) return;
  try {
    await env.USAGE.put(markerKey(token), String(Date.now()), {
      expirationTtl: TWILIO_MARKER_TTL_SECONDS,
    });
  } catch (cause) {
    console.error(`twilio alert: marker write failed: ${String(cause)}`);
  }
}

/**
 * Was this request made by whoever holds the webhook key?
 *
 * `timingSafeEqual` hashes both sides, so neither the length nor any prefix of
 * the expected key is observable from response timing. An unset
 * `ALERT_WEBHOOK_KEY` disables the route outright — the same idiom
 * `authenticate` uses for `DEBRIEF_TOKEN`, and the reason an empty `?key=`
 * against an unset secret must not authenticate: without the explicit check, two
 * empty strings compare equal and the route opens to the internet the moment
 * someone forgets to set the secret.
 */
async function authorized(request: Request, env: Env): Promise<boolean> {
  const key = new URL(request.url).searchParams.get('key');
  if (key === null) return false;
  if (!env.ALERT_WEBHOOK_KEY) return false;
  return timingSafeEqual(key, env.ALERT_WEBHOOK_KEY);
}

export function twilioFields(body: string): TwilioAlertFields {
  const params = new URLSearchParams(body);
  const fields: Record<string, string> = {};
  for (const name of TWILIO_FIELD_NAMES) {
    const value = params.get(name);
    if (value !== null) fields[name] = value;
  }
  return fields as TwilioAlertFields;
}

export function twilioAlertMessage(fields: TwilioAlertFields): AlertMessage {
  const category = fields.UsageCategory ?? 'unknown';
  const current = fields.CurrentValue ?? '?';
  const trigger = fields.TriggerValue ?? '?';

  const rows = TWILIO_DISPLAY.map(
    ([label, key]) => [label, fields[key] ?? '(not sent)'] as const,
  );

  const text = [
    'A Twilio usage trigger fired.',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    TWILIO_CONSOLE_URL,
  ].join('\n');

  const html = [
    '<p>A Twilio usage trigger fired.</p>',
    '<ul>',
    ...rows.map(
      ([label, value]) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`,
    ),
    '</ul>',
    `<p><a href="${TWILIO_CONSOLE_URL}">Twilio usage console</a></p>`,
  ].join('');

  return {
    subject: headerSafe(`Twilio spend alert: ${category} ${current} crossed ${trigger}`),
    text,
    html,
  };
}

/**
 * POST /api/alerts/twilio — relay one Twilio usage trigger to email.
 *
 * Answers 200 for everything except a failed key check, and that is deliberate.
 * Twilio retries a non-2xx callback, so a Worker that reported its own
 * misconfiguration with a 5xx would turn one missing binding into a retry storm
 * against a route that cannot succeed. The outcome goes in the body and the log
 * instead.
 */
export async function handleTwilioAlert(
  request: Request,
  env: Env,
  deps: AlertDeps = {},
): Promise<Response> {
  if (!(await authorized(request, env))) {
    // Never says what was expected, and answers identically to an unset secret.
    return error(401, 'Alert webhook key not accepted');
  }

  const read = await readCappedBody(request);
  const fields = twilioFields(read.ok ? read.body : '');

  // A body with no token — junk, or a Twilio that stops sending one — is relayed
  // unconditionally, because the alternative is dropping a real alert over a
  // missing display-layer field.
  const token = fields.IdempotencyToken;
  if (token && (await alreadyRelayed(env, token))) {
    console.log('twilio alert: duplicate');
    return json({ ok: true, outcome: 'duplicate' });
  }

  const emailer = deps.emailer ?? emailerFor(env);
  if (emailer === null) {
    // No marker is written: nothing was sent, so a retry should still get a
    // chance once somebody adds the binding.
    console.error('twilio alert: no-email-binding');
    return json({ ok: false, outcome: 'no-email-binding' });
  }

  if (token) await markRelayed(env, token);

  try {
    await emailer.send(twilioAlertMessage(fields));
  } catch (cause) {
    console.error(`twilio alert: send-failed: ${String(cause)}`);
    return json({ ok: false, outcome: 'send-failed' });
  }

  console.log(`twilio alert: sent (${fields.UsageCategory ?? 'unknown'})`);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ *
 * B. LiveKit agent minutes, ledgered
 * ------------------------------------------------------------------ */

/** One UTC month of metered usage. */
export interface UsageLedger {
  /**
   * The number the plan is spent against: every agent session rounded UP to a
   * whole minute, summed. See `billableMinutes`.
   */
  billable_minutes: number;
  /** Wall-clock conversation seconds. Context for a reader, not the meter. */
  seconds: number;
  calls: number;
  cost_usd: number;
  /** Threshold (minutes, as written) to the unix second it was mailed about. */
  alerted: Record<string, number>;
  /**
   * The most recent call ids counted, newest last. The agent retries a final
   * upload it did not get an answer to, and a POST that committed with its
   * response lost is indistinguishable from a new call at this layer — without
   * this, that retry bills a second time.
   */
  recent_call_ids: string[];
}

export type UsageOutcome =
  | 'no-usage-binding'
  | 'recorded'
  | 'alerted'
  | 'duplicate-call'
  | 'no-email-binding'
  | 'failed';

/**
 * Call ids remembered against a retried upload.
 *
 * Twenty, not two: the agent's retry can arrive after other calls have ended in
 * between, and this only has to cover the retry window rather than the month.
 */
const RECENT_CALL_IDS = 20;

/**
 * What LiveKit actually charges for one call.
 *
 * Agent session minutes are metered per session, rounded UP to the whole minute.
 * Summing raw seconds and dividing at the end is therefore not the same number
 * and is not close: a thousand thirty-second calls is ~508 minutes of wall clock
 * and 1000 minutes of bill. Alerting on the wall-clock figure would have fired
 * the "500 minutes used" warning at the moment the quota ran out.
 *
 * A call with no readable clock counts as one minute rather than zero. It is a
 * guess either way, and for a quota alert the safe direction to be wrong in is
 * upwards — an alert that comes slightly early costs a glance at the console, an
 * alert that comes late costs the demo.
 */
export function billableMinutes(duration_seconds: number | null): number {
  if (duration_seconds === null) return 1;
  return Math.max(1, Math.ceil(duration_seconds / 60));
}

/**
 * The ledger key for a moment in time. UTC, because the LiveKit plan period is
 * not this laptop's timezone and a ledger that rolls over at UK midnight would
 * disagree with the console it is meant to predict.
 */
export function usageKey(now: number): string {
  const at = new Date(now);
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `usage_${at.getUTCFullYear()}-${month}`;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Parse a stored ledger, treating anything unrecognisable as an empty month.
 *
 * Field by field rather than by trusting the shape, which also makes this the
 * migration path: a row written before a field existed reads as zero for it
 * rather than as a corrupt month.
 */
export function parseLedger(raw: string | null): UsageLedger {
  const empty: UsageLedger = {
    billable_minutes: 0,
    seconds: 0,
    calls: 0,
    cost_usd: 0,
    alerted: {},
    recent_call_ids: [],
  };
  if (raw === null) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;

  const held = parsed as Record<string, unknown>;
  const alerted: Record<string, number> = {};
  const storedAlerts = held.alerted;
  if (typeof storedAlerts === 'object' && storedAlerts !== null && !Array.isArray(storedAlerts)) {
    for (const [key, at] of Object.entries(storedAlerts as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) alerted[key] = at;
    }
  }

  const recent = Array.isArray(held.recent_call_ids)
    ? held.recent_call_ids.filter((id): id is string => typeof id === 'string')
    : [];

  return {
    billable_minutes: number(held.billable_minutes),
    seconds: number(held.seconds),
    calls: number(held.calls),
    cost_usd: number(held.cost_usd),
    alerted,
    recent_call_ids: recent.slice(-RECENT_CALL_IDS),
  };
}

/**
 * Thresholds, in minutes, parsed leniently and sorted.
 *
 * Absent means the default; PRESENT-but-empty means none, which is the off
 * switch — a deployment that wants no minute alerts sets the var to an empty
 * string rather than having to guess a number the ledger will never reach.
 * Non-positive and unparseable entries are dropped individually so one typo in a
 * list does not disable the rest of it.
 */
export function alertThresholds(raw: string | undefined): number[] {
  const parsed = (raw ?? DEFAULT_ALERT_MINUTES)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  // Deduplicated: `alerted` is keyed by threshold, so a repeated entry would
  // otherwise send the same email twice for one crossing.
  return [...new Set(parsed)].sort((a, b) => a - b);
}

/**
 * Thresholds this call took the month past, that have not already been mailed.
 *
 * Strictly-greater on the low side and inclusive on the high side, so landing
 * exactly on 500 alerts once and never again.
 */
export function thresholdsCrossed(
  raw: string | undefined,
  before: number,
  after: number,
  alerted: Record<string, number>,
): number[] {
  return alertThresholds(raw).filter(
    (threshold) =>
      before < threshold && threshold <= after && alerted[String(threshold)] === undefined,
  );
}

function minutesAlertMessage(threshold: number, ledger: UsageLedger, key: string): AlertMessage {
  const billed = ledger.billable_minutes;
  const talked = Math.round(ledger.seconds / 60);
  const month = key.replace('usage_', '');
  const cost = ledger.cost_usd.toFixed(2);

  // Billable minutes lead, because that is the number the plan is spent against.
  // Wall clock follows it as context, and the gap between the two IS the
  // per-session rounding — a reader who sees 501 billed against 340 talked can
  // tell at a glance that the month was made of short calls.
  const rows: [string, string | number][] = [
    ['Billable minutes (month to date)', billed],
    ['Conversation minutes', talked],
    ['Calls', ledger.calls],
    ['Estimated inference cost', `$${cost}`],
  ];

  const lines = [
    `Billable agent minutes for ${month} have passed ${threshold}.`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `Plan ceiling: ${PLAN_CEILING_MINUTES} minutes per period.`,
    'LiveKit meters each session rounded up to the whole minute.',
  ];

  // No caller-supplied strings reach this body — every value is a number this
  // module computed — but it is escaped anyway, so a future field added here
  // cannot become the exception nobody noticed.
  const html = [
    `<p>Billable agent minutes for ${escapeHtml(month)} have passed ${threshold}.</p>`,
    '<ul>',
    ...rows.map(
      ([label, value]) =>
        `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(value))}</li>`,
    ),
    '</ul>',
    `<p>Plan ceiling: ${PLAN_CEILING_MINUTES} minutes per period. LiveKit meters each session rounded up to the whole minute.</p>`,
  ].join('');

  return {
    subject: headerSafe(
      `Glass Cockpit: ${billed} of ${PLAN_CEILING_MINUTES} agent minutes used this month`,
    ),
    text: lines.join('\n'),
    html,
  };
}

/**
 * Add one finished call to this month's ledger, and mail if it crossed a line.
 *
 * ## The ledger does NOT live in DEBRIEFS
 *
 * It has its own namespace, and that is not tidiness. /api/metrics lists the
 * debriefs namespace and reads what it finds: a foreign key there is a record
 * that fails to parse as a debrief, so it lands in `calls_unreadable` on the
 * public dashboard AND spends one of the 200 reads the endpoint budgets per
 * request. A monthly counter would corrupt the fleet numbers and crowd out real
 * calls to do it. The same argument is already written out in ratelimit.ts.
 *
 * ## Races are tolerated
 *
 * This is a read-modify-write with no compare-and-swap, so two calls ending in
 * the same second can lose an increment, and two crossing the same threshold at
 * once can both mail. At a handful of calls a day that is a rounding error on a
 * number whose entire job is to be roughly right, and a Durable Object to fix it
 * would cost more than the minutes it protects.
 *
 * The retry guard above is a different thing and is NOT in that category: a
 * retried upload is not a rare interleaving, it is what the agent does every
 * time an upload times out, and it would double a call's minutes rather than
 * lose a fraction of one.
 *
 * No TTL: twelve small keys a year, and the point of keeping last month's row is
 * that "500 minutes" means nothing without the month before it to compare to.
 */
export async function recordCallUsage(
  env: Env,
  summary: CallSummary,
  now = Date.now(),
  deps: AlertDeps = {},
): Promise<UsageOutcome> {
  if (!env.USAGE) return 'no-usage-binding';

  try {
    const key = usageKey(now);
    const before = parseLedger(await env.USAGE.get(key, 'text'));

    /*
     * The same call, twice.
     *
     * The agent retries a final upload it got no answer to, and a POST that
     * committed to KV with its response lost on the way back looks, from here,
     * exactly like a second call. Counting it bills minutes nobody used and can
     * trip a threshold early. Checked before anything is written, so a duplicate
     * costs one KV read and nothing else.
     */
    const callId = summary.call_id;
    if (callId !== null && before.recent_call_ids.includes(callId)) return 'duplicate-call';

    const after: UsageLedger = {
      billable_minutes: before.billable_minutes + billableMinutes(summary.duration_seconds),
      seconds: before.seconds + (summary.duration_seconds ?? 0),
      calls: before.calls + 1,
      cost_usd: before.cost_usd + summary.cost_usd,
      alerted: { ...before.alerted },
      recent_call_ids:
        callId === null
          ? before.recent_call_ids
          : [...before.recent_call_ids, callId].slice(-RECENT_CALL_IDS),
    };

    const crossed = thresholdsCrossed(
      env.USAGE_ALERT_MINUTES,
      before.billable_minutes,
      after.billable_minutes,
      after.alerted,
    );
    // Marked before the send, in the same write that records the minutes. A
    // failed send costs one email; a send recorded only on success would mail
    // again on every subsequent call for the rest of the month.
    for (const threshold of crossed) after.alerted[String(threshold)] = Math.round(now / 1000);

    await env.USAGE.put(key, JSON.stringify(after));
    if (crossed.length === 0) return 'recorded';

    const emailer = deps.emailer ?? emailerFor(env);
    if (emailer === null) {
      console.error(`usage alert: no-email-binding (crossed ${crossed.join(', ')})`);
      return 'no-email-binding';
    }

    for (const threshold of crossed) {
      await emailer.send(minutesAlertMessage(threshold, after, key));
    }
    return 'alerted';
  } catch (cause) {
    console.error(`usage ledger: failed: ${String(cause)}`);
    return 'failed';
  }
}

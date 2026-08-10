/**
 * Two things are being defended here, and they are not the email formatting.
 *
 *  * **The webhook is a sender.** Anyone who can make it answer 200 can make
 *    this account send mail, so the key check is tested for the cases that
 *    actually go wrong: a wrong key, no key at all, and — the one that opens the
 *    route to the world — an empty key against an unset secret, where a naive
 *    string compare says two empty strings are equal.
 *  * **The minutes alert must fire once.** A threshold that mails on every call
 *    for the rest of the month is a threshold somebody filters to trash, so the
 *    dedupe is asserted against KV state rather than against anything this
 *    module remembers.
 */

import { describe, expect, it } from 'vitest';
import {
  alertThresholds,
  billableMinutes,
  emailerFor,
  escapeHtml,
  handleTwilioAlert,
  parseLedger,
  recordCallUsage,
  twilioFields,
  usageKey,
  type AlertMessage,
  type Emailer,
} from './alerts';
import type { Env } from './env';
import type { CallSummary } from './metrics';

/** An `Emailer` that keeps what it was handed. */
function fakeEmailer(): Emailer & { sent: AlertMessage[] } {
  const sent: AlertMessage[] = [];
  return {
    sent,
    async send(message: AlertMessage) {
      sent.push(message);
    },
  };
}

/** A KV double for the USAGE namespace, plus the puts it saw. */
function fakeUsage() {
  const store = new Map<string, string>();
  const puts: { key: string; value: string; options?: unknown }[] = [];
  return {
    store,
    puts,
    namespace: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string, options?: unknown) {
        store.set(key, value);
        puts.push({ key, value, options });
      },
    },
  };
}

function usageEnv(usage: ReturnType<typeof fakeUsage>, extra: Record<string, unknown> = {}): Env {
  return { USAGE: usage.namespace, ...extra } as unknown as Env;
}

/** One finished call, reduced to the fields the ledger reads. */
function call(
  duration_seconds: number | null,
  cost_usd = 0,
  call_id: string | null = 'RM_ledger',
): CallSummary {
  return {
    entry: 'browser',
    source: 'agent',
    call_id,
    in_progress: false,
    stored_at: 0,
    ended_at: 0,
    duration_seconds,
    turns: 1,
    completed: [],
    barge_ins: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    stt_seconds: 0,
    tts_characters: 0,
    cost_usd,
  };
}

const MINUTE = 60;

// Deliberately NOT the real SID shape (AC + 32 hex): GitHub push protection
// pattern-matches that and blocks the push, fabricated or not. The code under
// test treats AccountSid as an opaque optional string, so the fixture loses
// nothing by being unmatchable.
const ACCOUNT_SID = 'AC-test-not-a-real-sid';

/** Firings so far, so each fixture carries its own idempotency token. */
let fired = 0;

/**
 * A complete usage-trigger callback, with every parameter Twilio documents and
 * no parameter it does not.
 *
 * The field list is transcribed from Twilio's usage-trigger documentation, not
 * recalled: the implementation this fixture first accompanied read
 * `CurrentUsage`, which is not a Twilio parameter, and a fixture written from
 * the same memory agreed with it and proved nothing. A fixture that mirrors the
 * code cannot catch the code being wrong about the outside world.
 */
function twilioBody(fields: Record<string, string> = {}): string {
  fired += 1;
  return new URLSearchParams({
    AccountSid: ACCOUNT_SID,
    UsageTriggerSid: 'UT0123456789abcdef0123456789abcdef',
    DateFired: '2026-08-10T09:00:00Z',
    Recurring: 'monthly',
    UsageCategory: 'totalprice',
    TriggerBy: 'price',
    TriggerValue: '10',
    CurrentValue: '11',
    UsageRecordUri: `/2010-04-01/Accounts/${ACCOUNT_SID}/Usage/Records/ThisMonth?Category=totalprice`,
    // Documented as unique to one firing, which is what makes it usable for
    // dedupe — so the fixture makes it unique to one call of this helper.
    IdempotencyToken: `token-${fired}`,
    ...fields,
  }).toString();
}

function twilioRequest(query: string, body = twilioBody()): Request {
  return new Request(`https://cockpit.example/api/alerts/twilio${query}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

const KEYED: Env = { ALERT_WEBHOOK_KEY: 'the-webhook-key' } as unknown as Env;

describe('POST /api/alerts/twilio: the key is the whole trust boundary', () => {
  it('relays one email when the key matches', async () => {
    const emailer = fakeEmailer();
    const response = await handleTwilioAlert(twilioRequest('?key=the-webhook-key'), KEYED, {
      emailer,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(emailer.sent).toHaveLength(1);

    const [message] = emailer.sent;
    // `CurrentValue`, the documented parameter — not the `CurrentUsage` an
    // earlier draft invented, which would render here as "(not sent)".
    expect(message.subject).toBe('Twilio spend alert: totalprice 11 crossed 10');
    for (const value of ['totalprice', '11', '10', 'price', 'monthly', '2026-08-10T09:00:00Z']) {
      expect(message.text).toContain(value);
      expect(message.html).toContain(value);
    }
    expect(message.text).not.toContain('(not sent)');
    expect(message.html).toContain('https://console.twilio.com/us1/monitor/usage');
  });

  it('parses exactly the parameters Twilio documents', () => {
    const fields = twilioFields(twilioBody());
    expect(Object.keys(fields).sort()).toEqual([
      'AccountSid',
      'CurrentValue',
      'DateFired',
      'IdempotencyToken',
      'Recurring',
      'TriggerBy',
      'TriggerValue',
      'UsageCategory',
      'UsageRecordUri',
      'UsageTriggerSid',
    ]);
  });

  it('ignores a parameter nobody documented', () => {
    // An allowlist, so a future Twilio field cannot silently become an input.
    expect(twilioFields('UsageCategory=totalprice&Surprise=1')).toEqual({
      UsageCategory: 'totalprice',
    });
  });

  it('refuses a wrong key without sending', async () => {
    const emailer = fakeEmailer();
    const response = await handleTwilioAlert(twilioRequest('?key=nearly-the-key'), KEYED, {
      emailer,
    });
    expect(response.status).toBe(401);
    expect(emailer.sent).toHaveLength(0);
  });

  it('refuses a request with no key at all', async () => {
    const emailer = fakeEmailer();
    const response = await handleTwilioAlert(twilioRequest(''), KEYED, { emailer });
    expect(response.status).toBe(401);
    expect(emailer.sent).toHaveLength(0);
  });

  it('never reflects the expected key', async () => {
    const response = await handleTwilioAlert(twilioRequest('?key=nope'), KEYED, {
      emailer: fakeEmailer(),
    });
    expect(await response.text()).not.toContain('the-webhook-key');
  });

  it('stays shut when the secret is unset, even for an empty key', async () => {
    // Two empty strings compare equal, so without the explicit unset check this
    // route would open to the internet the moment somebody forgot the secret.
    const emailer = fakeEmailer();
    const env = {} as unknown as Env;
    for (const query of ['?key=', '', '?key=anything']) {
      const response = await handleTwilioAlert(twilioRequest(query), env, { emailer });
      expect(response.status).toBe(401);
    }
    expect(emailer.sent).toHaveLength(0);
  });
});

describe('POST /api/alerts/twilio: a bad relay must not make Twilio retry', () => {
  it('answers 200 with a named outcome when there is no EMAIL binding', async () => {
    // No injected emailer and no binding. Twilio retries a non-2xx, so a 500
    // here would turn one missing binding into a retry storm.
    const response = await handleTwilioAlert(twilioRequest('?key=the-webhook-key'), KEYED);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, outcome: 'no-email-binding' });
  });

  it('answers 200 when the send itself fails', async () => {
    const response = await handleTwilioAlert(twilioRequest('?key=the-webhook-key'), KEYED, {
      emailer: {
        async send() {
          throw new Error('smtp is having a day');
        },
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, outcome: 'send-failed' });
  });
});

describe('POST /api/alerts/twilio: one firing, one email', () => {
  /** The webhook env with somewhere to keep idempotency markers. */
  function keyedWithUsage(usage: ReturnType<typeof fakeUsage>): Env {
    return { ALERT_WEBHOOK_KEY: 'the-webhook-key', USAGE: usage.namespace } as unknown as Env;
  }

  it('sends nothing the second time a firing arrives', async () => {
    // Twilio retries three times after a 5xx, and a timeout duplicates a
    // delivery even though this route always answers 200 — an answer only counts
    // if it arrives. The token is documented as unique to one firing.
    const usage = fakeUsage();
    const env = keyedWithUsage(usage);
    const emailer = fakeEmailer();
    const body = twilioBody();

    const first = await handleTwilioAlert(twilioRequest('?key=the-webhook-key', body), env, {
      emailer,
    });
    expect(await first.json()).toEqual({ ok: true });

    const second = await handleTwilioAlert(twilioRequest('?key=the-webhook-key', body), env, {
      emailer,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, outcome: 'duplicate' });
    expect(emailer.sent).toHaveLength(1);
  });

  it('keeps the marker out of the ledger key space, and expires it', async () => {
    const usage = fakeUsage();
    await handleTwilioAlert(twilioRequest('?key=the-webhook-key'), keyedWithUsage(usage), {
      emailer: fakeEmailer(),
    });
    expect(usage.puts).toHaveLength(1);
    expect(usage.puts[0].key).toMatch(/^twilio_token-\d+$/);
    expect(usage.puts[0].options).toEqual({ expirationTtl: 24 * 60 * 60 });
  });

  it('still relays a different firing', async () => {
    const usage = fakeUsage();
    const env = keyedWithUsage(usage);
    const emailer = fakeEmailer();
    await handleTwilioAlert(twilioRequest('?key=the-webhook-key'), env, { emailer });
    await handleTwilioAlert(twilioRequest('?key=the-webhook-key'), env, { emailer });
    expect(emailer.sent).toHaveLength(2);
  });

  it('relays a body carrying no token at all, every time', async () => {
    // Junk, or a Twilio that stops sending one. Dropping a real spend alert over
    // a missing display-layer field is the worse failure.
    const usage = fakeUsage();
    const env = keyedWithUsage(usage);
    const emailer = fakeEmailer();
    const body = 'UsageCategory=totalprice&CurrentValue=11';
    await handleTwilioAlert(twilioRequest('?key=the-webhook-key', body), env, { emailer });
    await handleTwilioAlert(twilioRequest('?key=the-webhook-key', body), env, { emailer });
    expect(emailer.sent).toHaveLength(2);
    expect(usage.puts).toHaveLength(0);
  });

  it('relays rather than suppresses when the marker store is broken', async () => {
    const env = {
      ALERT_WEBHOOK_KEY: 'the-webhook-key',
      USAGE: {
        async get() {
          throw new Error('KV is down');
        },
        async put() {
          throw new Error('KV is down');
        },
      },
    } as unknown as Env;
    const emailer = fakeEmailer();
    const response = await handleTwilioAlert(twilioRequest('?key=the-webhook-key'), env, {
      emailer,
    });
    expect(response.status).toBe(200);
    expect(emailer.sent).toHaveLength(1);
  });
});

describe('POST /api/alerts/twilio: the body is display data, not evidence', () => {
  it('alerts on an empty body', async () => {
    const emailer = fakeEmailer();
    const response = await handleTwilioAlert(twilioRequest('?key=the-webhook-key', ''), KEYED, {
      emailer,
    });
    expect(response.status).toBe(200);
    expect(emailer.sent).toHaveLength(1);
    expect(emailer.sent[0].subject).toBe('Twilio spend alert: unknown ? crossed ?');
  });

  it('alerts on junk that is not a form at all', async () => {
    const emailer = fakeEmailer();
    await handleTwilioAlert(twilioRequest('?key=the-webhook-key', '<<<not a form>>>'), KEYED, {
      emailer,
    });
    expect(emailer.sent).toHaveLength(1);
  });

  it('escapes a body value on its way into the HTML', async () => {
    const emailer = fakeEmailer();
    await handleTwilioAlert(
      twilioRequest('?key=the-webhook-key', twilioBody({ UsageCategory: '<script>x</script>' })),
      KEYED,
      { emailer },
    );
    const { html } = emailer.sent[0];
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('keeps a newline out of the subject line', async () => {
    // A subject is one header line; a value carrying CRLF is an injected header.
    const emailer = fakeEmailer();
    await handleTwilioAlert(
      twilioRequest('?key=the-webhook-key', twilioBody({ UsageCategory: 'a\r\nBcc: x@y.z' })),
      KEYED,
      { emailer },
    );
    expect(emailer.sent[0].subject).not.toMatch(/[\r\n]/);
  });
});

describe('escapeHtml', () => {
  it('covers the five characters that matter in an attribute or a body', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
    );
  });
});

describe('emailerFor', () => {
  it('is null when the binding is absent, rather than a stub that throws later', () => {
    expect(emailerFor({} as unknown as Env)).toBeNull();
  });

  it('sends from the onboarded domain to the verified destination', async () => {
    const sent: Record<string, unknown>[] = [];
    const env = {
      EMAIL: {
        async send(message: Record<string, unknown>) {
          sent.push(message);
          return { messageId: 'x' };
        },
      },
    } as unknown as Env;

    await emailerFor(env)!.send({ subject: 's', text: 't', html: '<p>h</p>' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('admin@agentmaker.io');
    expect((sent[0].from as { email: string }).email).toBe('alerts@agentmaker.io');
    expect(sent[0].subject).toBe('s');
  });
});

describe('usageKey', () => {
  it('is the UTC month, not the local one', () => {
    // 23:30 on the 31st in UTC+1 is still the old month everywhere that counts.
    expect(usageKey(Date.UTC(2026, 7, 10, 12))).toBe('usage_2026-08');
    expect(usageKey(Date.UTC(2026, 0, 1, 0))).toBe('usage_2026-01');
    expect(usageKey(Date.UTC(2026, 11, 31, 23, 59))).toBe('usage_2026-12');
  });
});

describe('parseLedger', () => {
  const empty = {
    billable_minutes: 0,
    seconds: 0,
    calls: 0,
    cost_usd: 0,
    alerted: {},
    recent_call_ids: [],
  };

  it('treats a missing, unparseable or wrongly-shaped value as an empty month', () => {
    for (const raw of [null, 'not json', '[]', '"nope"', '{"seconds":"lots"}']) {
      expect(parseLedger(raw)).toEqual(empty);
    }
  });

  it('keeps the alert marks it can read and drops the rest', () => {
    expect(
      parseLedger(
        '{"billable_minutes":2,"seconds":60,"calls":1,"cost_usd":0.5,' +
          '"alerted":{"500":17,"800":"soon"},"recent_call_ids":["RM_a",7,"RM_b"]}',
      ),
    ).toEqual({
      billable_minutes: 2,
      seconds: 60,
      calls: 1,
      cost_usd: 0.5,
      alerted: { '500': 17 },
      recent_call_ids: ['RM_a', 'RM_b'],
    });
  });

  it('reads a row written before a field existed as a zero, not as damage', () => {
    // The migration path: this namespace already holds rows with no
    // `billable_minutes` in them.
    expect(parseLedger('{"seconds":600,"calls":2,"cost_usd":1,"alerted":{"500":9}}')).toEqual({
      ...empty,
      seconds: 600,
      calls: 2,
      cost_usd: 1,
      alerted: { '500': 9 },
    });
  });
});

describe('billableMinutes', () => {
  it('rounds each session up to the whole minute, the way LiveKit bills it', () => {
    // Summing seconds and dividing at the end is a different number and not a
    // close one: a thousand thirty-second calls is ~508 wall-clock minutes and
    // 1000 minutes of bill, so a wall-clock alert at 500 arrives at quota
    // exhaustion rather than halfway.
    expect(billableMinutes(30)).toBe(1);
    expect(billableMinutes(60)).toBe(1);
    expect(billableMinutes(61)).toBe(2);
    expect(billableMinutes(600)).toBe(10);
    expect(billableMinutes(0.5)).toBe(1);
  });

  it('counts an unreadable clock as a minute, not as nothing', () => {
    // A guess either way; for a quota alert the safe direction is upwards.
    expect(billableMinutes(null)).toBe(1);
  });
});

describe('alertThresholds', () => {
  it('defaults when the var is absent', () => {
    expect(alertThresholds(undefined)).toEqual([500, 800]);
  });

  it('drops garbage entries individually and sorts what is left', () => {
    expect(alertThresholds('800, nonsense, 500, -3, 0, ')).toEqual([500, 800]);
  });

  it('deduplicates, because `alerted` is keyed by threshold', () => {
    // "500,500" used to mail twice for one crossing.
    expect(alertThresholds('500,500, 500 ')).toEqual([500]);
  });

  it('reads an explicit empty string as "no minute alerts"', () => {
    expect(alertThresholds('')).toEqual([]);
    expect(alertThresholds('nonsense')).toEqual([]);
  });
});

describe('recordCallUsage: the ledger', () => {
  const AUGUST = Date.UTC(2026, 7, 10);

  /** A stored ledger, in the shape previous writes would have left behind. */
  function seed(usage: ReturnType<typeof fakeUsage>, ledger: Record<string, unknown>): void {
    usage.store.set('usage_2026-08', JSON.stringify(ledger));
  }

  it('accumulates billable minutes, calls and cost without alerting below the threshold', async () => {
    const usage = fakeUsage();
    const env = usageEnv(usage, { USAGE_ALERT_MINUTES: '500,800' });
    const emailer = fakeEmailer();

    expect(await recordCallUsage(env, call(4 * MINUTE, 0.1, 'RM_a'), AUGUST, { emailer }))
      .toBe('recorded');
    expect(await recordCallUsage(env, call(6 * MINUTE, 0.2, 'RM_b'), AUGUST, { emailer }))
      .toBe('recorded');

    expect(emailer.sent).toHaveLength(0);
    expect(usage.puts.map((put) => put.key)).toEqual(['usage_2026-08', 'usage_2026-08']);
    expect(JSON.parse(usage.store.get('usage_2026-08')!)).toEqual({
      billable_minutes: 10,
      seconds: 600,
      calls: 2,
      cost_usd: 0.30000000000000004,
      alerted: {},
      recent_call_ids: ['RM_a', 'RM_b'],
    });
  });

  it('bills a thirty-second call as a whole minute', async () => {
    const usage = fakeUsage();
    await recordCallUsage(usageEnv(usage), call(30, 0, 'RM_short'), AUGUST, {
      emailer: fakeEmailer(),
    });
    expect(JSON.parse(usage.store.get('usage_2026-08')!)).toMatchObject({
      billable_minutes: 1,
      seconds: 30,
      calls: 1,
    });
  });

  it('alerts on what LiveKit bills, not on the wall clock', async () => {
    // Sixty thirty-second calls: thirty minutes of conversation and sixty
    // minutes of bill. A ledger that summed seconds would still be reporting 30
    // here, and would not have raised the 45 until the quota was already gone.
    const usage = fakeUsage();
    const env = usageEnv(usage, { USAGE_ALERT_MINUTES: '45' });
    const emailer = fakeEmailer();

    for (let i = 0; i < 60; i += 1) {
      await recordCallUsage(env, call(30, 0, `RM_${i}`), AUGUST, { emailer });
    }

    const stored = JSON.parse(usage.store.get('usage_2026-08')!);
    expect(stored.billable_minutes).toBe(60);
    expect(stored.seconds).toBe(1800);
    expect(emailer.sent).toHaveLength(1);
    expect(emailer.sent[0].subject).toBe('Glass Cockpit: 45 of 1000 agent minutes used this month');
  });

  it('counts a call whose clock could not be read as one minute, not as nothing', async () => {
    const usage = fakeUsage();
    await recordCallUsage(usageEnv(usage), call(null, 0.05, 'RM_noclock'), AUGUST, {
      emailer: fakeEmailer(),
    });
    expect(JSON.parse(usage.store.get('usage_2026-08')!)).toMatchObject({
      billable_minutes: 1,
      seconds: 0,
      calls: 1,
    });
  });

  it('never writes into the debriefs namespace', async () => {
    // A foreign key in DEBRIEFS shows up as an unreadable call on the public
    // dashboard and spends one of /api/metrics' 200 reads to do it.
    const usage = fakeUsage();
    const debriefs: string[] = [];
    await recordCallUsage(
      {
        USAGE: usage.namespace,
        DEBRIEFS: {
          async get(key: string) {
            debriefs.push(`get ${key}`);
            return null;
          },
          async put(key: string) {
            debriefs.push(`put ${key}`);
          },
        },
      } as unknown as Env,
      call(MINUTE),
      AUGUST,
      { emailer: fakeEmailer() },
    );
    expect(debriefs).toEqual([]);
    expect(usage.puts).toEqual([{ key: 'usage_2026-08', value: expect.any(String) }]);
  });

  it('mails once when a call crosses 500, and not again afterwards', async () => {
    const usage = fakeUsage();
    seed(usage, {
      billable_minutes: 499,
      seconds: 499 * MINUTE,
      calls: 40,
      cost_usd: 4,
      alerted: {},
      recent_call_ids: [],
    });
    const env = usageEnv(usage, { USAGE_ALERT_MINUTES: '500,800' });
    const emailer = fakeEmailer();

    expect(await recordCallUsage(env, call(2 * MINUTE, 0, 'RM_c1'), AUGUST, { emailer })).toBe(
      'alerted',
    );
    expect(emailer.sent).toHaveLength(1);
    expect(emailer.sent[0].subject).toBe(
      'Glass Cockpit: 501 of 1000 agent minutes used this month',
    );
    expect(emailer.sent[0].text).toContain('Billable minutes (month to date): 501');
    expect(emailer.sent[0].text).toContain('Calls: 41');
    expect(emailer.sent[0].text).toContain('1000 minutes per period');

    expect(JSON.parse(usage.store.get('usage_2026-08')!).alerted['500']).toBeGreaterThan(0);
    expect(await recordCallUsage(env, call(2 * MINUTE, 0, 'RM_c2'), AUGUST, { emailer })).toBe(
      'recorded',
    );
    expect(emailer.sent).toHaveLength(1);
  });

  it('takes the once-only guarantee from `alerted`, not from the arithmetic', async () => {
    /*
     * The pair is the assertion. Both halves run identical arithmetic — a ledger
     * on 499 billable minutes, a two-minute call, a threshold of 500 — and the
     * only thing that differs is whether the stored ledger already carries a mark
     * for 500. If the once-only behaviour were an accident of the numbers rather
     * than a property of the map, both halves would do the same thing.
     */
    const base = {
      billable_minutes: 499,
      seconds: 499 * MINUTE,
      calls: 40,
      cost_usd: 4,
      recent_call_ids: [],
    };
    const MARKED_AT = 1_700_000_000;

    const marked = fakeUsage();
    seed(marked, { ...base, alerted: { '500': MARKED_AT } });
    const quiet = fakeEmailer();
    expect(
      await recordCallUsage(
        usageEnv(marked, { USAGE_ALERT_MINUTES: '500' }),
        call(2 * MINUTE, 0, 'RM_marked'),
        AUGUST,
        { emailer: quiet },
      ),
    ).toBe('recorded');
    expect(quiet.sent).toHaveLength(0);
    // And the original mark is left alone rather than refreshed.
    expect(JSON.parse(marked.store.get('usage_2026-08')!).alerted['500']).toBe(MARKED_AT);

    const unmarked = fakeUsage();
    seed(unmarked, { ...base, alerted: {} });
    const loud = fakeEmailer();
    expect(
      await recordCallUsage(
        usageEnv(unmarked, { USAGE_ALERT_MINUTES: '500' }),
        call(2 * MINUTE, 0, 'RM_marked'),
        AUGUST,
        { emailer: loud },
      ),
    ).toBe('alerted');
    expect(loud.sent).toHaveLength(1);
  });

  it('mails once for each threshold a single giant call clears', async () => {
    const usage = fakeUsage();
    const env = usageEnv(usage, { USAGE_ALERT_MINUTES: '500,800' });
    const emailer = fakeEmailer();

    expect(await recordCallUsage(env, call(900 * MINUTE, 0, 'RM_giant'), AUGUST, { emailer })).toBe(
      'alerted',
    );
    expect(emailer.sent).toHaveLength(2);
    expect(Object.keys(JSON.parse(usage.store.get('usage_2026-08')!).alerted).sort()).toEqual([
      '500',
      '800',
    ]);
  });

  it('alerts again in a new month, because the key is the month', async () => {
    const usage = fakeUsage();
    const env = usageEnv(usage, { USAGE_ALERT_MINUTES: '500' });
    const emailer = fakeEmailer();

    await recordCallUsage(env, call(600 * MINUTE, 0, 'RM_aug'), Date.UTC(2026, 7, 31), { emailer });
    await recordCallUsage(env, call(600 * MINUTE, 0, 'RM_sep'), Date.UTC(2026, 8, 1), { emailer });
    expect(emailer.sent).toHaveLength(2);
    expect([...usage.store.keys()].sort()).toEqual(['usage_2026-08', 'usage_2026-09']);
  });

  it('records but never mails when the thresholds are garbage', async () => {
    const usage = fakeUsage();
    const env = usageEnv(usage, { USAGE_ALERT_MINUTES: 'five hundred, ,-1' });
    const emailer = fakeEmailer();

    expect(await recordCallUsage(env, call(9000 * MINUTE, 0, 'RM_junk'), AUGUST, { emailer }))
      .toBe('recorded');
    expect(emailer.sent).toHaveLength(0);
  });

  it('reports a missing namespace instead of throwing', async () => {
    expect(await recordCallUsage({} as unknown as Env, call(MINUTE))).toBe('no-usage-binding');
  });

  it('reports a missing EMAIL binding, having already written the ledger', async () => {
    const usage = fakeUsage();
    const env = usageEnv(usage, { USAGE_ALERT_MINUTES: '1' });
    expect(await recordCallUsage(env, call(600 * MINUTE, 0, 'RM_nomail'), AUGUST)).toBe(
      'no-email-binding',
    );
    expect(usage.puts).toHaveLength(1);
  });

  it('swallows a KV failure rather than propagating it into a debrief upload', async () => {
    const env = {
      USAGE: {
        async get() {
          throw new Error('KV is down');
        },
        async put() {},
      },
    } as unknown as Env;
    expect(await recordCallUsage(env, call(MINUTE))).toBe('failed');
  });

  it('swallows a send failure, and does not un-mark the threshold', async () => {
    // The mark is written with the minutes, before the send. A mark written only
    // on success would mail again on every call for the rest of the month.
    const usage = fakeUsage();
    const env = usageEnv(usage, { USAGE_ALERT_MINUTES: '500' });
    const throwing: Emailer = {
      async send() {
        throw new Error('smtp is having a day');
      },
    };

    expect(await recordCallUsage(env, call(600 * MINUTE, 0, 'RM_sendfail'), AUGUST, {
      emailer: throwing,
    })).toBe('failed');
    expect(JSON.parse(usage.store.get('usage_2026-08')!).alerted['500']).toBeGreaterThan(0);
  });
});

describe('recordCallUsage: the same call, twice', () => {
  const AUGUST = Date.UTC(2026, 7, 10);

  it('adds nothing for a retried final upload', async () => {
    // The agent retries a final POST it got no answer to, and a POST that
    // committed with its response lost looks, from here, exactly like a new call.
    const usage = fakeUsage();
    const env = usageEnv(usage);
    const emailer = fakeEmailer();

    expect(await recordCallUsage(env, call(10 * MINUTE, 0.5, 'RM_retry'), AUGUST, { emailer }))
      .toBe('recorded');
    expect(await recordCallUsage(env, call(10 * MINUTE, 0.5, 'RM_retry'), AUGUST, { emailer }))
      .toBe('duplicate-call');

    expect(usage.puts).toHaveLength(1);
    expect(JSON.parse(usage.store.get('usage_2026-08')!)).toMatchObject({
      billable_minutes: 10,
      calls: 1,
      cost_usd: 0.5,
    });
  });

  it('does not let a retry cross a threshold on its own', async () => {
    const usage = fakeUsage();
    usage.store.set(
      'usage_2026-08',
      JSON.stringify({
        billable_minutes: 499,
        seconds: 499 * MINUTE,
        calls: 40,
        cost_usd: 4,
        alerted: {},
        recent_call_ids: ['RM_seen'],
      }),
    );
    const emailer = fakeEmailer();

    expect(
      await recordCallUsage(
        usageEnv(usage, { USAGE_ALERT_MINUTES: '500' }),
        call(2 * MINUTE, 0, 'RM_seen'),
        AUGUST,
        { emailer },
      ),
    ).toBe('duplicate-call');
    expect(emailer.sent).toHaveLength(0);
    expect(usage.puts).toHaveLength(0);
  });

  it('remembers a bounded number of ids, newest last', async () => {
    // The list rides along in the ledger value, so it has to stay small.
    const usage = fakeUsage();
    const env = usageEnv(usage);
    const emailer = fakeEmailer();

    for (let i = 0; i < 25; i += 1) {
      await recordCallUsage(env, call(MINUTE, 0, `RM_${i}`), AUGUST, { emailer });
    }

    const stored = JSON.parse(usage.store.get('usage_2026-08')!);
    expect(stored.calls).toBe(25);
    expect(stored.recent_call_ids).toHaveLength(20);
    expect(stored.recent_call_ids[0]).toBe('RM_5');
    expect(stored.recent_call_ids[19]).toBe('RM_24');
  });

  it('counts a call that named no id, because there is nothing to compare', async () => {
    const usage = fakeUsage();
    const env = usageEnv(usage);
    const emailer = fakeEmailer();
    await recordCallUsage(env, call(MINUTE, 0, null), AUGUST, { emailer });
    await recordCallUsage(env, call(MINUTE, 0, null), AUGUST, { emailer });
    expect(JSON.parse(usage.store.get('usage_2026-08')!)).toMatchObject({
      calls: 2,
      recent_call_ids: [],
    });
  });
});

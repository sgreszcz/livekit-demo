/**
 * The fleet aggregate is arithmetic over other people's data structures, which
 * is exactly where a demo quietly starts lying: a summed running total, a turn
 * counted once per partial envelope, a percentile off by one rank. Every one of
 * those is a test here, driven by synthetic debriefs in the shape the agent
 * really posts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from './env';
import worker from './index';
import {
  MEMO_MS,
  READ_CAP,
  aggregate,
  collectMetrics,
  handleMetricsGet,
  dedupe,
  percentile,
  resetMetricsMemo,
  summariseCall,
} from './metrics';

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
/** A fixed "now" so the day buckets are deterministic: 2026-08-06T00:00:00Z. */
const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);

function envelope(type: string, payload: Record<string, unknown>, ts = 1723000000.5) {
  return { v: 1, type, ts, payload };
}

interface TurnSpec {
  id: string;
  eou?: number;
  ttft?: number;
  ttfb?: number;
  total?: number | null;
  degraded?: boolean;
  barge_in?: boolean;
}

/**
 * A debrief in the emission order the agent produces: partial turn envelopes
 * that merge by id, a running-total usage envelope after every turn.
 */
/**
 * Distinct by default. Records are folded by `call_id` before aggregation, so a
 * fixture helper that stamped every call with the same id would silently make
 * every multi-call test a one-call test — tests that pass for the wrong reason.
 * A test that wants two records of the SAME call passes `call_id` explicitly.
 */
let nextCallId = 0;

function debrief(options: {
  turns?: TurnSpec[];
  entry?: string;
  source?: 'agent' | 'browser';
  started_at?: number;
  ended_at?: number;
  cost_per_turn?: number;
  call_id?: string;
  in_progress?: boolean;
  stored_at?: number;
  room?: string;
}): string {
  const turns = options.turns ?? [];
  const call_id = options.call_id ?? `RM_${(nextCallId += 1)}`;
  const messages: unknown[] = [
    envelope('call_meta', {
      call_id,
      room: options.room ?? 'cockpit-x',
      started_at: options.started_at ?? 1723000000,
      pipeline: { stt: 's', llm: 'l', tts: 't' },
      entry: options.entry ?? 'browser',
    }),
  ];

  let prompt = 0;
  let completion = 0;
  let cost = 0;
  for (const turn of turns) {
    // Three partial envelopes for one turn — the shape that used to be counted
    // as three turns.
    messages.push(envelope('turn', { turn_id: turn.id, eou: { end_of_utterance_delay: turn.eou ?? 0.4, transcription_delay: 0.1 } }));
    messages.push(envelope('turn', { turn_id: turn.id, llm: { ttft: turn.ttft ?? 0.3, duration: 1.0, llm_calls: 1 } }));
    const closing: Record<string, unknown> = {
      turn_id: turn.id,
      tts: { ttfb: turn.ttfb ?? 0.2, duration: 1.0, audio_duration: 2.0 },
    };
    if (turn.total !== null) {
      closing.total_response_latency = turn.total ?? (turn.eou ?? 0.4) + (turn.ttft ?? 0.3) + (turn.ttfb ?? 0.2);
      closing.degraded = turn.degraded ?? false;
    }
    messages.push(envelope('turn', closing));
    if (turn.barge_in) {
      messages.push(envelope('interruption', { kind: 'barge_in', turn_id: turn.id }));
      // The cockpit may see the same interruption re-published; one barge-in.
      messages.push(envelope('interruption', { kind: 'barge_in', turn_id: turn.id }));
    }
    prompt += 100;
    completion += 10;
    cost += options.cost_per_turn ?? 0.001;
    messages.push(
      envelope('usage', {
        llm_prompt_tokens: prompt,
        llm_completion_tokens: completion,
        stt_audio_seconds: 3,
        tts_characters: 140,
        est_cost_usd: cost,
      }),
    );
  }

  return JSON.stringify({
    call_id,
    meta: messages[0] && (messages[0] as { payload: unknown }).payload,
    ended_at: options.ended_at ?? 1723000100,
    messages,
    stored_at: options.stored_at ?? options.ended_at ?? 1723000100,
    source: options.source ?? 'agent',
    in_progress: options.in_progress ?? false,
  });
}

interface FakeKvOptions {
  /** Keys the list call reports beyond what it returns. */
  listComplete?: boolean;
}

function fakeEnv(
  values: { name: string; stored_at?: number; value: string | null }[],
  options: FakeKvOptions = {},
): { env: Env; reads: string[]; lists: number } {
  // A null value is a key that is listed but no longer readable — KV's own
  // behaviour when a debrief expires between the list and the get.
  const store = new Map(values.map((entry) => [entry.name, entry.value]));
  const state = { reads: [] as string[], lists: 0 };

  const kv = {
    async list({ limit }: { limit?: number } = {}) {
      state.lists += 1;
      const keys = values
        .slice(0, limit ?? values.length)
        .map((entry) => ({ name: entry.name, metadata: entry.stored_at === undefined ? undefined : { stored_at: entry.stored_at } }));
      return { keys, list_complete: options.listComplete ?? true, cacheStatus: null };
    },
    async get(name: string) {
      state.reads.push(name);
      return store.get(name) ?? null;
    },
  };

  return {
    env: { DEBRIEFS: kv } as unknown as Env,
    get reads() {
      return state.reads;
    },
    get lists() {
      return state.lists;
    },
  } as { env: Env; reads: string[]; lists: number };
}

function metrics(bodies: string[], now = NOW) {
  const calls = bodies.map(summariseCall);
  const unreadable = calls.filter((call) => call === null).length;
  return aggregate(
    calls.filter((call): call is NonNullable<typeof call> => call !== null),
    { sampled: false, unreadable, now },
  );
}

beforeEach(() => resetMetricsMemo());

describe('percentile', () => {
  it('takes the nearest rank, not an interpolation', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
  });

  it('never indexes past the ends', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([1, 2], 1)).toBe(1);
  });
});

describe('aggregate: latency', () => {
  /** Twenty turns at 100 ms … 2000 ms, one call. */
  const ladder = () =>
    debrief({
      turns: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, total: (i + 1) / 10 })),
      ended_at: NOW / 1000,
    });

  it('reports count, average, p50, p95 and max in milliseconds', () => {
    const result = metrics([ladder()]);
    expect(result.latency_count).toBe(20);
    expect(result.latency_avg_ms).toBe(1050);
    // Rank 10 of 20 for p50, rank 19 for p95 — off-by-one here is a demo that
    // claims a better tail than it has.
    expect(result.latency_p50_ms).toBe(1000);
    expect(result.latency_p95_ms).toBe(1900);
    expect(result.latency_max_ms).toBe(2000);
  });

  it('counts only turns strictly over the one-second budget', () => {
    // 1.0 s exactly is on budget; 1.1 s and up are the ten that are not.
    expect(metrics([ladder()]).over_budget_pct).toBe(50);
  });

  it('pools turns across calls rather than averaging the averages', () => {
    const slow = debrief({ turns: [{ id: 'a', total: 2.0 }], ended_at: NOW / 1000 });
    const fast = debrief({
      turns: Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, total: 0.5 })),
      ended_at: NOW / 1000,
    });
    const result = metrics([slow, fast]);
    expect(result.latency_count).toBe(10);
    // Averaging per call first would give 1.25 s; the honest number is 0.65 s.
    expect(result.latency_avg_ms).toBe(650);
  });

  it('ignores turns that never completed', () => {
    const body = debrief({
      turns: [
        { id: 'greeting', total: null },
        { id: 't1', total: 0.8 },
      ],
      ended_at: NOW / 1000,
    });
    const result = metrics([body]);
    expect(result.turns_total).toBe(2);
    expect(result.turns_completed).toBe(1);
    expect(result.latency_count).toBe(1);
    expect(result.latency_avg_ms).toBe(800);
  });
});

describe('aggregate: turns and stages', () => {
  it('merges the partial envelopes of a turn into one turn', () => {
    const body = debrief({ turns: [{ id: 't1' }, { id: 't2' }], ended_at: NOW / 1000 });
    const result = metrics([body]);
    expect(result.turns_total).toBe(2);
    expect(result.avg_turns_per_call).toBe(2);
  });

  it('averages each pipeline stage separately', () => {
    const body = debrief({
      turns: [
        { id: 't1', eou: 0.4, ttft: 0.3, ttfb: 0.2 },
        { id: 't2', eou: 0.6, ttft: 0.5, ttfb: 0.4 },
      ],
      ended_at: NOW / 1000,
    });
    const result = metrics([body]);
    expect(result.stage_eou_avg_ms).toBe(500);
    expect(result.stage_llm_ttft_avg_ms).toBe(400);
    expect(result.stage_tts_ttfb_avg_ms).toBe(300);
    expect(result.stages).toEqual([
      { stage: 'EOU delay', ms: 500 },
      { stage: 'LLM TTFT', ms: 400 },
      { stage: 'TTS TTFB', ms: 300 },
    ]);
  });

  it('reports the degraded share of completed turns', () => {
    const body = debrief({
      turns: [
        { id: 't1', degraded: true },
        { id: 't2' },
        { id: 't3' },
        { id: 't4' },
      ],
      ended_at: NOW / 1000,
    });
    expect(metrics([body]).degraded_pct).toBe(25);
  });

  it('counts a barge-in once per turn however often it is published', () => {
    const body = debrief({
      turns: [{ id: 't1', barge_in: true }, { id: 't2' }],
      ended_at: NOW / 1000,
    });
    expect(metrics([body]).barge_in_total).toBe(1);
  });
});

describe('aggregate: usage', () => {
  it('takes the last running total per call instead of summing them', () => {
    // Six turns emit six cumulative usage envelopes. Summing gives 2100 prompt
    // tokens for a call that used 600.
    const body = debrief({
      turns: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}` })),
      cost_per_turn: 0.002,
      ended_at: NOW / 1000,
    });
    const result = metrics([body]);
    expect(result.tokens_prompt).toBe(600);
    expect(result.tokens_completion).toBe(60);
    expect(result.est_cost_usd).toBe(0.012);
  });

  it('sums the per-call totals across the fleet', () => {
    const one = debrief({ turns: [{ id: 't1' }], ended_at: NOW / 1000 });
    const two = debrief({ turns: [{ id: 't1' }, { id: 't2' }], ended_at: NOW / 1000 });
    const result = metrics([one, two]);
    expect(result.tokens_prompt).toBe(100 + 200);
    expect(result.stt_seconds).toBe(6);
    expect(result.tts_characters).toBe(280);
  });
});

describe('aggregate: call splits and history', () => {
  it('splits calls by entry point and by who posted them', () => {
    const result = metrics([
      debrief({ entry: 'browser', source: 'agent', ended_at: NOW / 1000 }),
      debrief({ entry: 'sip', source: 'agent', ended_at: NOW / 1000 }),
      debrief({ entry: 'browser', source: 'browser', ended_at: NOW / 1000 }),
      JSON.stringify({ messages: [], source: 'agent' }),
    ]);
    expect(result.calls_total).toBe(4);
    expect(result.calls_entry_browser).toBe(2);
    expect(result.calls_entry_sip).toBe(1);
    expect(result.calls_entry_unknown).toBe(1);
    expect(result.calls_source_agent).toBe(3);
    expect(result.calls_source_browser).toBe(1);
  });

  it('emits fourteen day buckets, zeros included, oldest first', () => {
    const result = metrics([
      debrief({ ended_at: NOW / 1000 }),
      debrief({ ended_at: NOW / 1000 }),
      debrief({ ended_at: (NOW - 3 * DAY) / 1000 }),
      // Older than the window: still a call, but not on the chart.
      debrief({ ended_at: (NOW - 40 * DAY) / 1000 }),
    ]);
    const series = result.calls_per_day as { time: number; date: string; value: number }[];
    expect(series).toHaveLength(14);
    expect(series[0].time).toBeLessThan(series[13].time);
    expect(series[13].date).toBe('2026-08-06');
    expect(series[13].value).toBe(2);
    expect(series[10].value).toBe(1);
    expect(series.reduce((total, point) => total + point.value, 0)).toBe(3);
    expect(result.calls_total).toBe(4);
  });

  it('averages call duration and skips nonsense clocks', () => {
    const talked = [{ id: 't1', total: 0.5 }];
    const result = metrics([
      debrief({ turns: talked, started_at: 1000, ended_at: 1060 }),
      debrief({ turns: talked, started_at: 1000, ended_at: 1120 }),
      // ended_at before started_at: a clock problem, not a -60 s call.
      debrief({ turns: talked, started_at: 2000, ended_at: 1940 }),
    ]);
    expect(result.avg_call_seconds).toBe(90);
    expect(result.calls_averaged).toBe(2);
  });
});

describe('aggregate: degenerate input', () => {
  it('answers an empty fleet with zeros, not NaN or nulls', () => {
    const result = metrics([]);
    expect(result.calls_total).toBe(0);
    expect(result.latency_count).toBe(0);
    expect(result.latency_avg_ms).toBe(0);
    expect(result.latency_p95_ms).toBe(0);
    expect(result.over_budget_pct).toBe(0);
    expect(result.degraded_pct).toBe(0);
    expect(result.avg_call_seconds).toBe(0);
    expect(result.est_cost_usd).toBe(0);
    expect(result.calls_per_day).toHaveLength(14);
    for (const value of Object.values(result)) {
      expect(typeof value === 'number' ? Number.isFinite(value) : true).toBe(true);
    }
  });

  it('skips a malformed debrief and says how many it skipped', () => {
    const result = metrics([
      debrief({ turns: [{ id: 't1', total: 0.9 }], ended_at: NOW / 1000 }),
      'not json at all',
      '[]',
      'null',
      JSON.stringify({ call_id: 'x', messages: 'lots' }),
    ]);
    expect(result.calls_read).toBe(1);
    expect(result.calls_unreadable).toBe(4);
    expect(result.latency_count).toBe(1);
  });

  it('tolerates envelopes with missing or wrong-typed fields', () => {
    const body = JSON.stringify({
      messages: [
        { v: 1, type: 'turn', ts: 1, payload: { turn_id: 't1', total_response_latency: 'soon' } },
        { v: 1, type: 'turn', ts: 1, payload: { turn_id: 't1', llm: 'a string' } },
        { v: 1, type: 'turn', ts: 1, payload: {} },
        { v: 1, type: 'usage', ts: 1, payload: { llm_prompt_tokens: null } },
        { v: 1, type: 'interruption', ts: 1, payload: { kind: 'barge_in' } },
        'not an envelope',
        null,
      ],
    });
    const result = metrics([body]);
    expect(result.calls_read).toBe(1);
    expect(result.turns_total).toBe(1);
    expect(result.latency_count).toBe(0);
    expect(result.tokens_prompt).toBe(0);
    expect(result.barge_in_total).toBe(0);
  });

  it('never emits anything a caller said', () => {
    const body = JSON.stringify({
      call_id: 'RM_secret',
      meta: { room: 'cockpit-secret', entry: 'browser' },
      ended_at: NOW / 1000,
      source: 'agent',
      messages: [
        {
          v: 1,
          type: 'transcript',
          ts: 1,
          payload: { role: 'user', text: 'my card number is 4111', final: true, turn_id: 't1' },
        },
        { v: 1, type: 'turn', ts: 1, payload: { turn_id: 't1', total_response_latency: 0.9 } },
      ],
    });
    const serialised = JSON.stringify(metrics([body]));
    expect(serialised).not.toContain('4111');
    expect(serialised).not.toContain('RM_secret');
    expect(serialised).not.toContain('cockpit-secret');
  });
});

describe('collectMetrics over KV', () => {
  it('reads every stored debrief when there are few', async () => {
    const { env, reads } = fakeEnv([
      { name: 'a', stored_at: 1, value: debrief({ turns: [{ id: 't1', total: 0.5 }] }) },
      { name: 'b', stored_at: 2, value: debrief({ turns: [{ id: 't1', total: 1.5 }] }) },
    ]);
    const result = await collectMetrics(env);
    expect(reads).toHaveLength(2);
    expect(result.calls_total).toBe(2);
    expect(result.sampled).toBe(false);
    expect(result.latency_count).toBe(2);
  });

  it('caps the reads and flags the answer as a sample', async () => {
    const entries = Array.from({ length: READ_CAP + 40 }, (_, i) => ({
      name: `k${i}`,
      stored_at: i,
      value: debrief({ turns: [{ id: 't1', total: 0.5 }] }),
    }));
    const { env, reads } = fakeEnv(entries);
    const result = await collectMetrics(env);
    expect(reads).toHaveLength(READ_CAP);
    expect(result.calls_total).toBe(READ_CAP);
    expect(result.sampled).toBe(true);
  });

  it('samples the newest debriefs, not whichever ids sort first', async () => {
    const entries = [
      { name: 'zzz-oldest', stored_at: 1, value: debrief({ entry: 'sip' }) },
      { name: 'aaa-newest', stored_at: 9, value: debrief({ entry: 'browser' }) },
    ];
    const { env, reads } = fakeEnv(entries);
    await collectMetrics(env);
    expect(reads[0]).toBe('aaa-newest');
  });

  it('sorts debriefs stored before metadata existed to the back', async () => {
    const entries = [
      { name: 'legacy', value: debrief({}) },
      { name: 'recent', stored_at: 5, value: debrief({}) },
    ];
    const { env, reads } = fakeEnv(entries);
    await collectMetrics(env);
    expect(reads).toEqual(['recent', 'legacy']);
  });

  it('flags a sample when KV says the listing was truncated', async () => {
    const { env } = fakeEnv([{ name: 'a', stored_at: 1, value: debrief({}) }], {
      listComplete: false,
    });
    expect((await collectMetrics(env)).sampled).toBe(true);
  });

  it('ignores a key that expired between the list and the read', async () => {
    const { env } = fakeEnv([
      { name: 'gone', stored_at: 2, value: null },
      { name: 'here', stored_at: 1, value: debrief({ turns: [{ id: 't1', total: 0.5 }] }) },
    ]);
    const result = await collectMetrics(env);
    expect(result.calls_read).toBe(1);
    // Expired is not corrupt: it must not show up as damaged data.
    expect(result.calls_unreadable).toBe(0);
  });

  it('answers an empty namespace with a zeroed body', async () => {
    const { env } = fakeEnv([]);
    const result = await collectMetrics(env);
    expect(result.calls_total).toBe(0);
    expect(result.sampled).toBe(false);
  });
});

describe('handleMetricsGet', () => {
  it('declares a one-minute public cache and JSON', async () => {
    const { env } = fakeEnv([{ name: 'a', stored_at: 1, value: debrief({}) }]);
    const response = await handleMetricsGet(env);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect((await response.json<{ calls_total: number }>()).calls_total).toBe(1);
  });

  it('is routed at GET /api/metrics and nothing else', async () => {
    const { env } = fakeEnv([{ name: 'a', stored_at: 1, value: debrief({}) }]);
    const request = (method: string, path = '/api/metrics') =>
      new Request(`https://cockpit.example/${path.slice(1)}`, { method });

    const ok = await worker.fetch(request('GET'), env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('public, max-age=60');

    // Writing to a read-only aggregate is a mistake worth naming.
    expect((await worker.fetch(request('POST'), env)).status).toBe(405);
    expect((await worker.fetch(request('GET', '/api/metrics/extra'), env)).status).toBe(404);
  });

  it('memoizes in the isolate so a scrape does not fan out over KV every time', async () => {
    const fake = fakeEnv([{ name: 'a', stored_at: 1, value: debrief({}) }]);
    await handleMetricsGet(fake.env);
    await handleMetricsGet(fake.env);
    expect(fake.lists).toBe(1);
    expect(fake.reads).toHaveLength(1);

    // …and does refresh once the memo is older than its own max-age.
    resetMetricsMemo();
    await handleMetricsGet(fake.env);
    expect(fake.lists).toBe(2);
    expect(MEMO_MS).toBe(60 * SECOND);
  });
});

describe('dedupe: one call, several stored records', () => {
  it('folds a checkpoint into the final debrief of the same call', () => {
    // The agent checkpoints while the call runs and POSTs a final debrief when
    // it ends. The final POST deletes the checkpoint, but KV list is eventually
    // consistent and keeps returning the deleted key for a while, so both
    // records are routinely read in the same scrape.
    const calls = [
      debrief({ call_id: 'RM_same', in_progress: true, stored_at: 10, turns: [{ id: 't1', total: 0.5 }] }),
      debrief({ call_id: 'RM_same', in_progress: false, stored_at: 20, turns: [{ id: 't1', total: 0.5 }, { id: 't2', total: 0.7 }] }),
    ].map((body) => summariseCall(body)!);

    const folded = dedupe(calls);
    expect(folded).toHaveLength(1);
    // The finished record wins, so the call reports both of its turns.
    expect(folded[0].in_progress).toBe(false);
    expect(folded[0].turns).toBe(2);
  });

  it('prefers the finished record even when the checkpoint was written later', () => {
    // Clock skew between the checkpoint and the final POST must not resurrect
    // a call that has already ended.
    const calls = [
      debrief({ call_id: 'RM_same', in_progress: false, stored_at: 10 }),
      debrief({ call_id: 'RM_same', in_progress: true, stored_at: 99 }),
    ].map((body) => summariseCall(body)!);
    expect(dedupe(calls)).toHaveLength(1);
    expect(dedupe(calls)[0].in_progress).toBe(false);
  });

  it('keeps the newest of two checkpoints for a call still running', () => {
    const calls = [
      debrief({ call_id: 'RM_live', in_progress: true, stored_at: 10, turns: [{ id: 't1', total: 0.5 }] }),
      debrief({ call_id: 'RM_live', in_progress: true, stored_at: 40, turns: [{ id: 't1', total: 0.5 }, { id: 't2', total: 0.6 }] }),
    ].map((body) => summariseCall(body)!);
    const folded = dedupe(calls);
    expect(folded).toHaveLength(1);
    expect(folded[0].turns).toBe(2);
  });

  it('folds records with no call_id with nothing', () => {
    // Two anonymous records are two calls as far as anyone can prove.
    const body = JSON.stringify({ messages: [envelope('state', { state: 'listening' })], source: 'agent' });
    const calls = [summariseCall(body)!, summariseCall(body)!];
    expect(dedupe(calls)).toHaveLength(2);
  });

  it('folds checkpoints out of the fleet count end to end', async () => {
    const { env } = fakeEnv([
      { name: 'chk_abc', stored_at: 10, value: debrief({ call_id: 'RM_1', in_progress: true }) },
      { name: 'sharedid', stored_at: 20, value: debrief({ call_id: 'RM_1', in_progress: false }) },
      { name: 'chk_def', stored_at: 30, value: debrief({ call_id: 'RM_2', in_progress: true }) },
    ]);
    const result = await collectMetrics(env);
    expect(result.calls_total).toBe(2);
    expect(result.calls_in_progress).toBe(1);
    expect(result.calls_completed).toBe(1);
  });
});

describe('aggregate: calls in progress', () => {
  it('counts a live call but keeps it out of the quality numbers', () => {
    const result = metrics([
      debrief({ in_progress: false, started_at: 1000, ended_at: 1060, turns: [{ id: 'a', total: 0.5 }] }),
      // Live: two fast turns so far. If it were averaged in it would drag p95
      // down and invent a 60-second "duration" for a call still running.
      debrief({ in_progress: true, started_at: 1000, ended_at: 1060, turns: [{ id: 'b', total: 0.1 }, { id: 'c', total: 0.1 }] }),
    ]);

    expect(result.calls_total).toBe(2);
    expect(result.calls_in_progress).toBe(1);
    expect(result.calls_completed).toBe(1);
    // Volume counts everything…
    expect(result.turns_total).toBe(3);
    // …quality describes the finished call only.
    expect(result.latency_count).toBe(1);
    expect(result.latency_p50_ms).toBe(500);
    expect(result.calls_averaged).toBe(1);
    expect(result.avg_call_seconds).toBe(60);
  });
});

describe('collectMetrics: only the agent moves the numbers', () => {
  it('stores but never aggregates an anonymous debrief', async () => {
    // Absent CORS headers do not stop a cross-site no-CORS POST, so anyone can
    // put a record in KV. `source` is set by the Worker from a verified bearer
    // token, never by the body, so this is a real trust boundary.
    const { env } = fakeEnv([
      { name: 'real', stored_at: 2, value: debrief({ source: 'agent', turns: [{ id: 't', total: 0.5 }] }) },
      { name: 'forged', stored_at: 1, value: debrief({ source: 'browser', turns: [{ id: 't', total: 99 }], cost_per_turn: 1000 }) },
    ]);
    const result = await collectMetrics(env);
    expect(result.calls_total).toBe(1);
    expect(result.calls_untrusted).toBe(1);
    expect(result.latency_count).toBe(1);
    expect(result.latency_max_ms).toBe(500);
    expect(result.est_cost_usd).toBe(0.001);
  });
});

describe('aggregate: numbers that are finite but not real', () => {
  it('drops magnitudes that would sum to Infinity', () => {
    // 1e308 is finite, so `Number.isFinite` accepts it; two of them sum to
    // Infinity, which JSON.stringify emits as null and which breaks every panel
    // bound to the field.
    const poisoned = JSON.stringify({
      call_id: 'RM_poison',
      meta: { started_at: 1000, entry: 'browser' },
      ended_at: 1060,
      stored_at: 1060,
      source: 'agent',
      messages: [
        envelope('turn', { turn_id: 't', total_response_latency: 1e308, degraded: false }),
        envelope('usage', {
          llm_prompt_tokens: 1e308,
          llm_completion_tokens: 1e308,
          stt_audio_seconds: 1e308,
          tts_characters: 1e308,
          est_cost_usd: 1e308,
        }),
      ],
    });

    const result = metrics([poisoned, poisoned]);
    expect(result.est_cost_usd).toBe(0);
    expect(result.tokens_prompt).toBe(0);
    expect(result.tokens_completion).toBe(0);
    expect(result.stt_seconds).toBe(0);
    expect(result.tts_characters).toBe(0);
    // The turn had no usable latency, so it is not a completed turn.
    expect(result.latency_count).toBe(0);
    expect(JSON.stringify(result)).not.toContain('null');
  });

  it('drops a duration longer than any credible call', () => {
    // A day-long "call" is a clock problem. Note the envelope timestamps are far
    // in the past here, so the idle-tail trim cannot rescue it either.
    const result = metrics([
      debrief({ turns: [{ id: 't', total: 0.5 }], started_at: 1000, ended_at: 1000 + 86400 }),
    ]);
    expect(result.calls_averaged).toBe(0);
    expect(result.avg_call_seconds).toBe(0);
  });
});

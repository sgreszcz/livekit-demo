/**
 * The fleet arithmetic, checked against real recordings.
 *
 * `metrics.test.ts` drives synthetic debriefs: precise, but written by the same
 * person who wrote the code, so a shared misunderstanding survives both. These
 * five are the genuine article — pulled from the production KV namespace, with
 * the caller's phone number replaced by Ofcom's reserved drama range and
 * nothing else altered. They are the recordings in which `avg_call_seconds`
 * read 536.8, and every expectation below was computed by hand from the raw
 * envelopes before the code was asked what it thought.
 *
 * See `test-fixtures/README.md` for what each one is and why it is here.
 */

import { describe, expect, it } from 'vitest';
import browserFourTurns from '../test-fixtures/browser-four-turns.json';
import browserLongTail from '../test-fixtures/browser-four-turns-long-tail.json';
import browserIdle from '../test-fixtures/browser-greeting-only-idle.json';
import sipEight from '../test-fixtures/sip-eight-turns.json';
import sipThree from '../test-fixtures/sip-three-turns.json';
import { validate } from './debrief';
import { IDLE_TAIL_SECONDS, aggregate, dedupe, summariseCall } from './metrics';

const FIXTURES = [browserIdle, sipEight, sipThree, browserFourTurns, browserLongTail];

/** The drama-range number the SIP fixtures' room names carry. */
const FIXTURE_NUMBER = '447700900123';

function summarise(fixture: unknown) {
  const summary = summariseCall(JSON.stringify(fixture));
  if (summary === null) throw new Error('fixture did not parse as a debrief');
  return summary;
}

function fleet() {
  return aggregate(dedupe(FIXTURES.map(summarise)), { sampled: false, unreadable: 0 });
}

describe('real debriefs: the calls that produced avg_call_seconds = 536.8', () => {
  it('trims the idle tail off an abandoned browser call', () => {
    /*
     * The call that broke the metric. A visitor opened the cockpit, the agent
     * spoke its greeting, and nobody ever replied — 10.5 seconds of telemetry.
     * The tab then stayed open for over an hour, holding the room open, and
     * `ended_at` was stamped when the job finally exited: 4376 seconds after
     * the call started. Averaged in, this one record contributed 437 of the
     * 536.8 second "average call length".
     */
    const raw = browserIdle as { meta: { started_at: number }; ended_at: number };
    const wallClock = raw.ended_at - raw.meta.started_at;
    expect(Math.round(wallClock)).toBe(4376);

    const summary = summarise(browserIdle);
    expect(summary.turns).toBe(1); // the greeting
    expect(summary.completed).toHaveLength(0); // nobody ever answered it
    expect(summary.duration_seconds).not.toBeNull();
    // Last envelope + the teardown grace, not the lifetime of an empty room.
    expect(summary.duration_seconds!).toBeCloseTo(10.5 + IDLE_TAIL_SECONDS, 1);
  });

  it('leaves a normally-ended call untouched', () => {
    // Every call here that ended normally has a 22-27 s gap between its last
    // envelope and `ended_at` — that is LiveKit's teardown, and the grace is
    // chosen to sit just above it, so these durations are the raw wall clock.
    const raw = sipEight as { meta: { started_at: number }; ended_at: number };
    const wallClock = raw.ended_at - raw.meta.started_at;
    expect(summarise(sipEight).duration_seconds!).toBeCloseTo(wallClock, 3);
    expect(Math.round(wallClock)).toBe(185);
  });

  it('trims a call abandoned after a real conversation', () => {
    // Four turns, then the visitor walked away: 183 s of silence before the
    // room closed. The conversation was 59.6 s long, not 242.
    const raw = browserLongTail as { meta: { started_at: number }; ended_at: number };
    expect(Math.round(raw.ended_at - raw.meta.started_at)).toBe(242);
    expect(summarise(browserLongTail).duration_seconds!).toBeCloseTo(59.6 + IDLE_TAIL_SECONDS, 1);
  });

  it('reports a believable fleet average instead of nine minutes', () => {
    const result = fleet();

    // The old definition, over these same five recordings, averaged the wall
    // clock of every call including the abandoned ones.
    const naive =
      FIXTURES.map((f) => {
        const raw = f as { meta: { started_at: number }; ended_at: number };
        return raw.ended_at - raw.meta.started_at;
      }).reduce((a, b) => a + b, 0) / FIXTURES.length;
    expect(Math.round(naive)).toBe(1005);

    // The new one: four calls that actually held a conversation, each measured
    // to its last word rather than to the moment the room happened to close.
    expect(result.calls_averaged).toBe(4);
    expect(result.calls_no_turns).toBe(1);
    expect(result.avg_call_seconds).toBe(124);
  });
});

describe('real debriefs: turn and latency arithmetic', () => {
  it('merges partial turn envelopes instead of counting each one', () => {
    // 70 envelopes, of which many are `turn` fragments for the same eight
    // exchanges. Counting envelopes would report dozens of turns.
    expect((sipEight as { messages: unknown[] }).messages).toHaveLength(70);
    const summary = summarise(sipEight);
    expect(summary.turns).toBe(8);
    // Two of the eight never completed: the greeting has no
    // `total_response_latency` by schema, and one turn was cut short.
    expect(summary.completed).toHaveLength(6);
  });

  it('keeps the last usage envelope, not the sum of every running total', () => {
    // `usage` is re-emitted after every turn carrying cumulative figures. This
    // call emitted eight of them; the last one is the bill.
    const summary = summarise(sipEight);
    expect(summary.prompt_tokens).toBe(10461);
    expect(summary.completion_tokens).toBe(553);
    expect(summary.cost_usd).toBeCloseTo(0.049, 6);

    const everyUsage = (sipEight.messages as { type: string; payload: Record<string, unknown> }[])
      .filter((m) => m.type === 'usage');
    expect(everyUsage.length).toBeGreaterThan(1);
    const summed = everyUsage.reduce((total, m) => total + Number(m.payload.est_cost_usd), 0);
    // What adding them up would have claimed, for the record.
    expect(summed).toBeGreaterThan(summary.cost_usd * 3);
  });

  it('takes nearest-rank percentiles over every completed turn in the fleet', () => {
    const result = fleet();
    // Hand-computed from the raw envelopes, sorted ascending:
    // 0.738 0.762 0.806 0.822 0.824 0.869 1.261 1.547 1.561 1.682 2.925 5.339
    expect(result.latency_count).toBe(12);
    // p50: ceil(0.50 * 12) = 6  -> the 6th value, 0.869
    expect(result.latency_p50_ms).toBe(869);
    // p95: ceil(0.95 * 12) = 12 -> the 12th value, 5.339
    expect(result.latency_p95_ms).toBe(5339);
    expect(result.latency_max_ms).toBe(5339);
    expect(result.latency_avg_ms).toBe(1595);
  });

  it('counts turns over budget and degraded turns', () => {
    const result = fleet();
    // Six of the twelve are over the one-second budget.
    expect(result.over_budget_pct).toBe(50);
    // Nobody touched chaos mode on any of these calls.
    expect(result.degraded_pct).toBe(0);
    expect(result.turns_total).toBe(20);
    expect(result.turns_completed).toBe(12);
  });

  it('splits the fleet by entry point and sums the bill', () => {
    const result = fleet();
    expect(result.calls_total).toBe(5);
    expect(result.calls_entry_sip).toBe(2);
    expect(result.calls_entry_browser).toBe(3);
    expect(result.calls_in_progress).toBe(0);
    expect(result.est_cost_usd).toBeCloseTo(0.1227, 4);
  });
});

describe('real debriefs: the SIP room name never leaks', () => {
  it('carries a phone number in the raw recording', () => {
    // If this ever stops being true the redaction tests below are vacuous.
    expect(JSON.stringify(sipEight)).toContain(FIXTURE_NUMBER);
    expect(JSON.stringify(sipThree)).toContain(FIXTURE_NUMBER);
  });

  it('strips it on the way into KV', () => {
    const stored = validate(JSON.stringify(sipEight));
    expect(stored).not.toBeNull();
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain(FIXTURE_NUMBER);
    expect(serialised).toContain('+REDACTED');
    // The parts that are not a phone number survive, so the record is still
    // recognisable as the call it describes.
    expect(serialised).toContain('sip-cockpit-');
    expect(serialised).toContain('5xzppVvwo6Px');
  });

  it('never emits any room name from the fleet aggregate', () => {
    const serialised = JSON.stringify(fleet());
    expect(serialised).not.toContain(FIXTURE_NUMBER);
    expect(serialised).not.toContain('sip-cockpit-');
    expect(serialised).not.toContain('cockpit-');
  });
});

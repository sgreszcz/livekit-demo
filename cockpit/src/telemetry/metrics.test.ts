/**
 * The fleet payload, parsed rather than cast.
 *
 * `/api/metrics` is a network response, and the dashboard renders large
 * numerals straight out of it. The distinction under test throughout is **zero
 * versus absent**: the endpoint answers zeros for an empty fleet, and a fleet
 * with no calls in it genuinely has zero calls — printing a dash there would be
 * a lie about the data, and printing `0` for a field the Worker never sent
 * would be a lie about the Worker.
 */

import { describe, expect, it } from 'vitest';
import { parseMetrics } from './metrics';

/** A complete body, in the Worker's own spelling (see worker/src/metrics.ts). */
const BODY = {
  generated_at: 1723000000,
  sampled: false,
  calls_read: 12,
  calls_total: 12,
  calls_per_day: [
    { time: 1722988800000, date: '2026-08-05', value: 3 },
    { time: 1723075200000, date: '2026-08-06', value: 9 },
  ],
  turns_total: 84,
  avg_turns_per_call: 7,
  avg_call_seconds: 63.4,
  latency_count: 80,
  latency_avg_ms: 910,
  latency_p50_ms: 880,
  latency_p95_ms: 1810,
  latency_max_ms: 1930,
  stage_eou_avg_ms: 420,
  stage_llm_ttft_avg_ms: 340,
  stage_tts_ttfb_avg_ms: 190,
  stages: [
    { stage: 'EOU delay', ms: 420 },
    { stage: 'LLM TTFT', ms: 340 },
    { stage: 'TTS TTFB', ms: 190 },
  ],
  over_budget_pct: 12.5,
  degraded_pct: 4,
  barge_in_total: 6,
  est_cost_usd: 0.1234,
};

describe('parseMetrics', () => {
  it('reads a complete body', () => {
    const metrics = parseMetrics(BODY)!;
    expect(metrics.calls).toBe(12);
    expect(metrics.turns).toBe(84);
    expect(metrics.avgCallSeconds).toBe(63.4);
    expect(metrics.avgTurnsPerCall).toBe(7);
    expect(metrics.bargeIns).toBe(6);
    expect(metrics.costUsd).toBe(0.1234);
    expect(metrics.latencyP50Ms).toBe(880);
    expect(metrics.latencyP95Ms).toBe(1810);
    expect(metrics.latencyMaxMs).toBe(1930);
    expect(metrics.overBudgetPct).toBe(12.5);
    expect(metrics.degradedPct).toBe(4);
    expect(metrics.perDay).toEqual([
      { date: '2026-08-05', value: 3 },
      { date: '2026-08-06', value: 9 },
    ]);
    expect(metrics.stages).toEqual([
      { label: 'EOU delay', ms: 420 },
      { label: 'LLM TTFT', ms: 340 },
      { label: 'TTS TTFB', ms: 190 },
    ]);
  });

  it('keeps a measured zero as a zero', () => {
    // The documented empty-fleet response. Every one of these is a reading.
    const metrics = parseMetrics({ ...BODY, calls_total: 0, est_cost_usd: 0, degraded_pct: 0 })!;
    expect(metrics.calls).toBe(0);
    expect(metrics.costUsd).toBe(0);
    expect(metrics.degradedPct).toBe(0);
  });

  it('reports a missing field as null, which is what prints a dash', () => {
    const { calls_total, est_cost_usd, ...rest } = BODY;
    void calls_total;
    void est_cost_usd;
    const metrics = parseMetrics(rest)!;
    expect(metrics.calls).toBeNull();
    expect(metrics.costUsd).toBeNull();
    // Untouched fields are unaffected — one absent number must not blank a page.
    expect(metrics.turns).toBe(84);
  });

  it('rejects figures that would reach SVG geometry as NaN', () => {
    const metrics = parseMetrics({
      ...BODY,
      calls_total: 'twelve',
      latency_p95_ms: null,
      degraded_pct: Number.NaN,
      over_budget_pct: Number.POSITIVE_INFINITY,
    })!;
    expect(metrics.calls).toBeNull();
    expect(metrics.latencyP95Ms).toBeNull();
    expect(metrics.degradedPct).toBeNull();
    expect(metrics.overBudgetPct).toBeNull();
  });

  it('drops a malformed day bucket rather than the whole series', () => {
    const metrics = parseMetrics({
      ...BODY,
      calls_per_day: [
        { date: '2026-08-05', value: 3 },
        { date: 42, value: 1 },
        { date: '2026-08-06', value: 'nine' },
        { date: '2026-08-07', value: -4 },
        null,
        { date: '2026-08-08', value: 0 },
      ],
    })!;
    // A zero-call day survives: it is a quiet day, not a missing one, and a
    // series with holes in it reads as an outage.
    expect(metrics.perDay).toEqual([
      { date: '2026-08-05', value: 3 },
      { date: '2026-08-08', value: 0 },
    ]);
  });

  it('reads an absent day series as no history rather than as an error', () => {
    expect(parseMetrics({ ...BODY, calls_per_day: 'soon' })!.perDay).toEqual([]);
    // A body that is recognisably a metrics response but carries no series.
    expect(parseMetrics({ calls_total: 0 })!.perDay).toEqual([]);
  });

  it('falls back to the flat stage fields when the array is missing', () => {
    // A Worker that predates the Grafana bar-gauge rows still has the three
    // averages, and the breakdown is the whole point of that panel.
    const { stages, ...rest } = BODY;
    void stages;
    expect(parseMetrics(rest)!.stages).toEqual([
      { label: 'EOU delay', ms: 420 },
      { label: 'LLM TTFT', ms: 340 },
      { label: 'TTS TTFB', ms: 190 },
    ]);
  });

  it('falls back when the array is present but carries nothing usable', () => {
    const metrics = parseMetrics({ ...BODY, stages: [{ stage: 7, ms: 'fast' }, 'nope'] })!;
    expect(metrics.stages.map((stage) => stage.label)).toEqual([
      'EOU delay',
      'LLM TTFT',
      'TTS TTFB',
    ]);
  });

  it('has no stages at all when neither form is present', () => {
    const { stages, stage_eou_avg_ms, stage_llm_ttft_avg_ms, stage_tts_ttfb_avg_ms, ...rest } = BODY;
    void stages;
    void stage_eou_avg_ms;
    void stage_llm_ttft_avg_ms;
    void stage_tts_ttfb_avg_ms;
    expect(parseMetrics(rest)!.stages).toEqual([]);
  });

  it('treats the sampled flag as a flag, not as truthiness', () => {
    expect(parseMetrics({ ...BODY, sampled: true })!.sampled).toBe(true);
    expect(parseMetrics({ ...BODY, sampled: 'yes' })!.sampled).toBe(false);
    // Absent means not sampled, which is the safe direction: it under-claims
    // completeness rather than over-claiming it.
    expect(parseMetrics({ calls_total: 0 })!.sampled).toBe(false);
  });

  it('refuses anything that is not a body at all', () => {
    for (const value of [null, undefined, 42, 'metrics', [], [BODY]]) {
      expect(parseMetrics(value)).toBeNull();
    }
  });

  it('parses a recognisable but threadbare body into nulls rather than throwing', () => {
    // A Worker from the future that kept one field this build knows. The page
    // renders dashes for the rest; it does not fall over, and it does not
    // discard a response that is genuinely a reading.
    const metrics = parseMetrics({ generated_at: 1723000000 })!;
    expect(metrics.calls).toBeNull();
    expect(metrics.latencyMaxMs).toBeNull();
    expect(metrics.stages).toEqual([]);
  });
});

/**
 * The inverse of the zero-versus-absent hazard, and the more dangerous half.
 *
 * A body of all-nulls renders as a page of dashes — which looks like a failure
 * but is in fact the READY state, so the lamp goes green and the footer asserts
 * "Complete: every stored recording is counted above". A dashboard is allowed
 * to say it does not know. It is not allowed to claim a completeness it cannot
 * support, over a response that counted nothing.
 */
describe('parseMetrics — refusing to look ready', () => {
  it('refuses a JSON object that is not a metrics body', () => {
    for (const value of [
      { error: 'upstream unavailable' },
      { message: 'not found' },
      { hello: 'world' },
      {},
    ]) {
      expect(parseMetrics(value)).toBeNull();
    }
  });

  it('accepts a body carrying any one recognisable metric', () => {
    // A Worker that predates a field, or a partial response, is still a
    // reading — it must not be thrown away with the error pages.
    expect(parseMetrics({ calls_total: 0 })).not.toBeNull();
    expect(parseMetrics({ generated_at: 1723000000 })).not.toBeNull();
    expect(parseMetrics({ calls_per_day: [] })).not.toBeNull();
    expect(parseMetrics({ est_cost_usd: 0 })).not.toBeNull();
  });

  it('still accepts the documented empty-fleet response', () => {
    // Every figure zero is what the endpoint answers before any call is
    // recorded, and it is a reading rather than a failure.
    const empty = parseMetrics({ ...BODY, calls_total: 0, turns_total: 0, est_cost_usd: 0 })!;
    expect(empty).not.toBeNull();
    expect(empty.calls).toBe(0);
  });
});

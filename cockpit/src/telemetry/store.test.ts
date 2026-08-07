import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/sample-call.jsonl?raw';
import { isEnvelope } from './schema';
import type { Envelope, TransportPayload } from './schema';
import {
  LATENCY_BUDGET_SECONDS,
  MAX_LOG_ENVELOPES,
  MAX_TRANSPORT_SAMPLES,
  MIN_RATE_SECONDS,
  P95_MIN_TURNS,
  appendToLog,
  callDurationSeconds,
  costPerMinute,
  createCockpitState,
  currentAgentState,
  emptyLog,
  interruptionTotals,
  latencyAggregates,
  latestTransport,
  parseEnvelopeLines,
  reduceAll,
  reduceEnvelope,
  turnWaterfall,
} from './store';

const envelopes = parseEnvelopeLines(fixture);
const state = reduceAll(envelopes);

/** The greeting apart, every turn in the fixture is a completed caller turn. */
const completed = state.turns.filter((turn) => turn.totalResponseLatency !== undefined);

describe('fixture parsing', () => {
  it('reads every line of the recording', () => {
    expect(envelopes).toHaveLength(72);
  });

  it('rejects malformed and unknown lines without losing the rest', () => {
    const parsed = parseEnvelopeLines(
      [
        '{"v":1,"type":"state","ts":1,"payload":{"state":"listening"}}',
        '',
        'not json',
        '{"v":1,"type":"gremlin","ts":2,"payload":{}}',
        '{"v":1,"type":"state","ts":3,"payload":{"state":"reticulating"}}',
      ].join('\n'),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('state');
  });
});

describe('turn assembly', () => {
  it('merges partial turn envelopes into the greeting plus six caller turns', () => {
    expect(state.turns.map((turn) => turn.turnId)).toEqual([
      't0',
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
    ]);
    expect(state.turns.map((turn) => turn.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('carries the agent-computed total response latency for every caller turn', () => {
    expect(state.turns.map((turn) => turn.totalResponseLatency)).toEqual([
      undefined,
      0.94,
      1.16,
      1.77,
      1.81,
      0.9,
      0.97,
    ]);
  });

  it('keeps stage metrics that arrived in earlier partial envelopes', () => {
    const t1 = state.turns[1];
    expect(t1.eou).toEqual({ end_of_utterance_delay: 0.41, transcription_delay: 0.12 });
    expect(t1.llm?.ttft).toBe(0.34);
    expect(t1.tts?.ttfb).toBe(0.19);
    expect(t1.stt?.audio_duration).toBe(3.1);
  });

  it('leaves the agent-initiated greeting without an EOU, STT or total', () => {
    const t0 = state.turns[0];
    expect(t0.eou).toBeUndefined();
    expect(t0.stt).toBeUndefined();
    expect(t0.totalResponseLatency).toBeUndefined();
    expect(t0.llm?.ttft).toBe(0.62);
    expect(t0.tts?.ttfb).toBe(0.19);
  });
});

describe('waterfall geometry', () => {
  it('draws a solid bar exactly as wide as the printed total response latency', () => {
    expect(completed).toHaveLength(6);
    for (const turn of completed) {
      expect(turnWaterfall(turn).criticalSeconds).toBeCloseTo(turn.totalResponseLatency ?? 0, 6);
    }
  });

  it('puts only end of utterance, first token and first audio on the solid bar', () => {
    const t1 = turnWaterfall(state.turns[1]);
    expect(t1.critical.map((span) => span.key)).toEqual(['eou', 'ttft', 'ttfb']);

    // Butt-jointed: each stage starts where the previous one ended.
    const expected = [
      { start: 0, seconds: 0.41 },
      { start: 0.41, seconds: 0.34 },
      { start: 0.75, seconds: 0.19 },
    ];
    t1.critical.forEach((span, index) => {
      expect(span.start).toBeCloseTo(expected[index].start, 6);
      expect(span.seconds).toBeCloseTo(expected[index].seconds, 6);
    });
  });

  it('never charges overlapped streaming to the caller', () => {
    // The bug this replaces: T1's bar ran to 1.82s and busted the budget line
    // while the row printed 940ms next to it.
    const t1 = turnWaterfall(state.turns[1]);
    expect(t1.criticalSeconds).toBeCloseTo(0.94, 6);
    expect(t1.criticalSeconds).toBeLessThan(LATENCY_BUDGET_SECONDS);
    expect(t1.spanSeconds).toBeCloseTo(2.75, 6);
  });

  it('runs the generation tail and TTS streaming past first audio', () => {
    const t1 = turnWaterfall(state.turns[1]);
    expect(t1.overlays.map((overlay) => overlay.key)).toEqual(['generation', 'tts']);

    // llm.duration 1.1 - ttft 0.34, from the moment the first token landed
    // (eou 0.41 + ttft 0.34), so the lane ends where the LLM did: eou + 1.1.
    expect(t1.overlays[0].start).toBeCloseTo(0.75, 6);
    expect(t1.overlays[0].seconds).toBeCloseTo(0.76, 6);
    expect(t1.overlays[0].start + t1.overlays[0].seconds).toBeCloseTo(0.41 + 1.1, 6);
    // tts.duration 2.0 - ttfb 0.19, from the moment the caller heard audio.
    expect(t1.overlays[1].start).toBeCloseTo(0.94, 6);
    expect(t1.overlays[1].seconds).toBeCloseTo(1.81, 6);

    for (const overlay of t1.overlays) {
      expect(overlay.start + overlay.seconds).toBeGreaterThan(t1.criticalSeconds);
    }
  });

  it('ends each overlay lane exactly where its metric says the work ended', () => {
    // The lanes are positioned, not just sized: `llm.duration` runs from the
    // request, `tts.duration` from the moment the LLM handed it the first token.
    for (const turn of state.turns) {
      const waterfall = turnWaterfall(turn);
      const eou = turn.eou?.end_of_utterance_delay ?? 0;

      const generation = waterfall.overlays.find((overlay) => overlay.key === 'generation');
      expect(generation).toBeDefined();
      expect(generation!.start + generation!.seconds).toBeCloseTo(eou + turn.llm!.duration, 6);

      const tts = waterfall.overlays.find((overlay) => overlay.key === 'tts');
      expect(tts).toBeDefined();
      expect(tts!.start + tts!.seconds).toBeCloseTo(eou + turn.llm!.ttft + turn.tts!.duration, 6);
    }
  });

  it('marks transcription inside the end-of-utterance window rather than after it', () => {
    for (const turn of completed) {
      const waterfall = turnWaterfall(turn);
      const eou = waterfall.critical.find((span) => span.key === 'eou');
      expect(waterfall.transcriptionTick).not.toBeNull();
      expect(waterfall.transcriptionTick!).toBeLessThan(eou!.seconds);
    }
  });

  it('renders the greeting as a partial row: first token plus first audio, no total', () => {
    const t0 = turnWaterfall(state.turns[0]);
    expect(t0.agentInitiated).toBe(true);
    expect(t0.critical.map((span) => span.key)).toEqual(['ttft', 'ttfb']);
    expect(t0.criticalSeconds).toBeCloseTo(0.81, 6);
    expect(t0.transcriptionTick).toBeNull();
    expect(state.turns[0].totalResponseLatency).toBeUndefined();
  });

  it('degrades gracefully when a turn has no stage metrics at all', () => {
    const bare = turnWaterfall({
      turnId: 'x',
      index: 0,
      degraded: false,
      interruptions: [],
      firstTs: 0,
      lastTs: 0,
    });
    expect(bare.critical).toEqual([]);
    expect(bare.overlays).toEqual([]);
    expect(bare.criticalSeconds).toBe(0);
    expect(bare.spanSeconds).toBe(0);
  });
});

describe('chaos and degradation', () => {
  it('flags exactly the turns that ran under injected latency', () => {
    const degraded = state.turns.filter((turn) => turn.degraded).map((turn) => turn.turnId);
    expect(degraded).toEqual(['t3', 't4']);
  });

  it('shows the degraded turns as the ones whose solid bar runs long', () => {
    for (const turn of completed) {
      expect(turnWaterfall(turn).criticalSeconds > 1.5).toBe(turn.degraded);
    }
  });

  it('ends with chaos switched back off', () => {
    expect(state.chaos).toEqual({ llmDelayMs: 0, active: false });
  });
});

describe('interruptions', () => {
  it('records a single barge-in, on t4', () => {
    const flagged = state.turns.filter((turn) => turn.interruptions.length > 0);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].turnId).toBe('t4');
    expect(flagged[0].interruptions).toEqual(['barge_in']);
  });
});

describe('transcript', () => {
  it('collapses interim user text in place rather than appending', () => {
    expect(state.transcript).toHaveLength(13);

    const userT1 = state.transcript.filter(
      (line) => line.turnId === 't1' && line.role === 'user',
    );
    expect(userT1).toHaveLength(1);
    expect(userT1[0].text).toBe('Hey, what is this demo exactly?');
    expect(userT1[0].final).toBe(true);
  });

  it('opens with the agent greeting, then alternates caller and agent', () => {
    expect(state.transcript.map((line) => `${line.turnId}:${line.role}`)).toEqual([
      't0:agent',
      't1:user', 't1:agent',
      't2:user', 't2:agent',
      't3:user', 't3:agent',
      't4:user', 't4:agent',
      't5:user', 't5:agent',
      't6:user', 't6:agent',
    ]);
  });

  it('refuses to let a late interim overwrite a finalized line', () => {
    const line = (text: string, final: boolean, ts: number): Envelope => ({
      v: 1,
      type: 'transcript',
      ts,
      payload: { role: 'user', text, final, turn_id: 't1' },
    });

    const settled = reduceAll([line('what is thi', false, 1), line('what is this demo?', true, 2)]);
    expect(settled.transcript[0].text).toBe('what is this demo?');

    // The stale partial lands after the final — it must be ignored entirely.
    const late = reduceEnvelope(settled, line('what is thi', false, 3));
    expect(late.transcript).toHaveLength(1);
    expect(late.transcript[0].text).toBe('what is this demo?');
    expect(late.transcript[0].final).toBe(true);
    expect(late.transcript[0].ts).toBe(2);

    // A later *final* correction is still allowed to win.
    const corrected = reduceEnvelope(late, line('what is this demo exactly?', true, 4));
    expect(corrected.transcript[0].text).toBe('what is this demo exactly?');
  });
});

describe('usage ledger', () => {
  it('holds the last running total emitted by the agent', () => {
    expect(state.usage).toEqual({
      llm_prompt_tokens: 19847,
      llm_completion_tokens: 427,
      stt_audio_seconds: 15.9,
      tts_characters: 1134,
      est_cost_usd: 0.022,
    });
  });
});

describe('call metadata and timeline', () => {
  it('captures the pipeline and entry point', () => {
    expect(state.meta?.room).toBe('cockpit-demo01');
    expect(state.meta?.entry).toBe('browser');
    expect(state.meta?.pipeline).toEqual({
      stt: 'deepgram/nova-3',
      llm: 'openai/gpt-4.1-mini',
      tts: 'cartesia/sonic-3',
    });
  });

  it('builds the agent state timeline and ends listening', () => {
    expect(state.states).toHaveLength(22);
    expect(state.states[0].state).toBe('listening');
    expect(currentAgentState(state)).toBe('listening');
  });

  it('measures call duration from the envelope timestamps', () => {
    expect(callDurationSeconds(state)).toBeCloseTo(49.5, 6);
  });

  it('retains every envelope for the debrief payload', () => {
    expect(state.log.entries).toHaveLength(72);
    expect(state.log.version).toBe(72);
  });
});

describe('envelope log', () => {
  const sample = (ts: number): Envelope => ({
    v: 1,
    type: 'state',
    ts,
    payload: { state: 'listening' },
  });

  it('mints a new wrapper per append so consumers still see a change', () => {
    const first = emptyLog();
    const second = appendToLog(first, sample(1));
    expect(second).not.toBe(first);
    expect(second.version).toBe(1);
  });

  it('bounds itself, keeping the opening call_meta and the most recent traffic', () => {
    const meta = envelopes[0];
    expect(meta.type).toBe('call_meta');

    let log = appendToLog(emptyLog(), meta);
    for (let i = 0; i < MAX_LOG_ENVELOPES + 500; i += 1) log = appendToLog(log, sample(i));

    expect(log.entries).toHaveLength(MAX_LOG_ENVELOPES);
    expect(log.version).toBe(MAX_LOG_ENVELOPES + 501);
    expect(log.entries[0]).toBe(meta);
    expect(log.entries[log.entries.length - 1].ts).toBe(MAX_LOG_ENVELOPES + 499);
  });

  it('ignores a repeated append of the same envelope object', () => {
    // React invokes reducers twice per action under StrictMode; this append
    // mutates, so the second invocation must not log the envelope again.
    const envelope = sample(1);
    const first = appendToLog(emptyLog(), envelope);
    const second = appendToLog(first, envelope);

    expect(second.entries).toHaveLength(1);
    expect(appendToLog(second, sample(2)).entries).toHaveLength(2);
  });

  it('survives a StrictMode double-invocation of the reducer', () => {
    const envelope = sample(1);
    const base = createCockpitState();
    const once = reduceEnvelope(base, envelope);
    // React re-runs the reducer from the same base state with the same action.
    const twice = reduceEnvelope(base, envelope);

    expect(once.log.entries).toHaveLength(1);
    expect(twice.log.entries).toHaveLength(1);
    expect(twice.log.version).toBe(1);
  });

  it('gives every fresh state its own log rather than sharing one', () => {
    const a = reduceEnvelope(createCockpitState(), sample(1));
    const b = createCockpitState();
    expect(a.log.entries).toHaveLength(1);
    expect(b.log.entries).toHaveLength(0);
  });
});

describe('transport series', () => {
  const sample = (ts: number, payload: TransportPayload): Envelope => ({
    v: 1,
    type: 'transport',
    ts,
    payload,
  });

  it('is empty for the shipped fixture, which recorded none', () => {
    // The fixture predates transport sampling and every SIP call always will —
    // the panel has to treat an absent series as a fact, not as a failure.
    expect(state.transport).toEqual([]);
  });

  it('folds a reading into the series', () => {
    const folded = reduceAll([
      sample(10, { rtt_ms: 48, jitter_ms: 4.1, packet_loss_pct: 0.4, quality: 'good' }),
    ]);
    expect(folded.transport).toEqual([
      { ts: 10, rttMs: 48, jitterMs: 4.1, lossPct: 0.4, quality: 'good' },
    ]);
  });

  it('leaves a figure the sample never read absent rather than zero', () => {
    // A muted microphone did not measure 0 ms of round trip, and a sparkline
    // that cannot tell those apart plots a cliff that never happened.
    const folded = reduceAll([sample(10, { quality: 'lost' })]);
    expect(folded.transport[0]).toEqual({ ts: 10, quality: 'lost' });
    expect('rttMs' in folded.transport[0]).toBe(false);
    expect('lossPct' in folded.transport[0]).toBe(false);
  });

  it('bounds the series, keeping the most recent readings', () => {
    const envelopes: Envelope[] = [];
    for (let i = 0; i < MAX_TRANSPORT_SAMPLES + 120; i += 1) {
      envelopes.push(sample(i, { rtt_ms: i, quality: 'good' }));
    }
    const folded = reduceAll(envelopes);

    expect(folded.transport).toHaveLength(MAX_TRANSPORT_SAMPLES);
    // Oldest evicted, newest kept: a transport panel is about now.
    expect(folded.transport[0].rttMs).toBe(120);
    expect(folded.transport[folded.transport.length - 1].rttMs).toBe(
      MAX_TRANSPORT_SAMPLES + 119,
    );
  });

  it('drops malformed readings at ingest rather than plotting them', () => {
    const parsed = parseEnvelopeLines(
      [
        '{"v":1,"type":"transport","ts":1,"payload":{"rtt_ms":48,"quality":"good"}}',
        // No quality: not a reading.
        '{"v":1,"type":"transport","ts":2,"payload":{"rtt_ms":50}}',
        // Figures that would poison a y-scale.
        '{"v":1,"type":"transport","ts":3,"payload":{"quality":"good","rtt_ms":-4}}',
        '{"v":1,"type":"transport","ts":4,"payload":{"quality":"good","packet_loss_pct":900}}',
        '{"v":1,"type":"transport","ts":5,"payload":{"quality":"marginal"}}',
        '{"v":1,"type":"transport","ts":6,"payload":{"quality":"lost"}}',
      ].join('\n'),
    );

    const folded = reduceAll(parsed);
    expect(folded.transport.map((entry) => entry.ts)).toEqual([1, 6]);
  });

  it('reports the newest reading, or null when there is none', () => {
    expect(latestTransport(createCockpitState())).toBeNull();
    const folded = reduceAll([sample(1, { quality: 'good' }), sample(2, { quality: 'poor' })]);
    expect(latestTransport(folded)?.quality).toBe('poor');
  });

  it('survives a StrictMode double-invocation without duplicating a reading', () => {
    const envelope = sample(1, { quality: 'good' });
    const base = createCockpitState();
    expect(reduceEnvelope(base, envelope).transport).toHaveLength(1);
    expect(reduceEnvelope(base, envelope).transport).toHaveLength(1);
  });
});

describe('session aggregates', () => {
  const aggregates = latencyAggregates(state.turns);

  it('measures only the turns the agent computed a latency for', () => {
    // The greeting has no caller wait, so it is not in the denominator.
    expect(aggregates.measured).toBe(6);
    expect(state.turns).toHaveLength(7);
  });

  it('takes the median of the six completed turns', () => {
    // sorted: 0.90 0.94 0.97 | 1.16 1.77 1.81 -> (0.97 + 1.16) / 2
    expect(aggregates.median).toBeCloseTo(1.065, 6);
  });

  it('reports p95 by nearest rank, which at six samples is the worst turn', () => {
    // ceil(0.95 * 6) = 6, so the 95th percentile IS the slowest turn here.
    // That is the honest answer at this sample size, not a rounding artefact.
    expect(aggregates.p95).toBeCloseTo(1.81, 6);
    expect(aggregates.p95).toBe(aggregates.worst);
  });

  it('withholds p95 until there are enough turns to mean anything', () => {
    const turnsWith = (count: number) =>
      state.turns.filter((turn) => turn.totalResponseLatency !== undefined).slice(0, count);

    expect(latencyAggregates(turnsWith(P95_MIN_TURNS - 1)).p95).toBeNull();
    expect(latencyAggregates(turnsWith(P95_MIN_TURNS)).p95).not.toBeNull();
    expect(latencyAggregates([]).p95).toBeNull();
  });

  it('counts the turns that ran past the budget', () => {
    // 1.16, 1.77 and 1.81 are over 1.0s; 0.90, 0.94 and 0.97 are not.
    expect(aggregates.overBudget).toBe(3);
    expect(aggregates.worst).toBeCloseTo(1.81, 6);
  });

  it('reports zeroes rather than NaN for a call with no turns', () => {
    const empty = latencyAggregates([]);
    expect(empty).toEqual({ measured: 0, median: 0, p95: null, worst: 0, overBudget: 0 });
  });

  it('counts the fixture barge-in and no false interruptions', () => {
    expect(interruptionTotals(state.turns)).toEqual({
      bargeIns: 1,
      falseInterruptions: 0,
      total: 1,
    });
  });

  it('derives a spend rate from the running total and the elapsed call', () => {
    // $0.022 over 49.5s -> $0.022 / 0.825 min.
    const rate = costPerMinute(state.usage, callDurationSeconds(state));
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.022 / (49.5 / 60), 9);
    expect(rate!).toBeCloseTo(0.02667, 5);
  });

  it('refuses to extrapolate a rate from a call too short to have one', () => {
    // A tenth of a second of call would report six hundred times its own cost.
    expect(costPerMinute(state.usage, MIN_RATE_SECONDS - 0.001)).toBeNull();
    expect(costPerMinute(state.usage, 0)).toBeNull();
    expect(costPerMinute(state.usage, NaN)).toBeNull();
    expect(costPerMinute(null, 600)).toBeNull();
  });
});

describe('replay determinism', () => {
  it('produces identical state whether fed live or replayed from the log', () => {
    const replayed = reduceAll(state.log.entries);
    expect(replayed.turns).toEqual(state.turns);
    expect(replayed.transcript).toEqual(state.transcript);
    expect(replayed.usage).toEqual(state.usage);
  });

  it('accepts every envelope in the shipped fixture as contract-valid', () => {
    for (const envelope of envelopes) expect(isEnvelope(envelope)).toBe(true);
  });
});

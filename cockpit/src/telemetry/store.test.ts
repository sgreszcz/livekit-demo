import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/sample-call.jsonl?raw';
import { isEnvelope } from './schema';
import type { Envelope } from './schema';
import {
  LATENCY_BUDGET_SECONDS,
  MAX_LOG_ENVELOPES,
  appendToLog,
  callDurationSeconds,
  createCockpitState,
  currentAgentState,
  emptyLog,
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

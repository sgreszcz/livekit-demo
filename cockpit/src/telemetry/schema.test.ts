/**
 * Ingest validation, from the attacker's side of the wire.
 *
 * Anyone can POST a debrief to the Worker and hand the resulting link to a
 * colleague, so every envelope the viewer replays is untrusted input. The bar
 * these tests hold: nothing that fails the v1 contract may reach the store.
 */

import { describe, expect, it } from 'vitest';
import { MAX_LLM_CHAIN_LINKS, isEnvelope } from './schema';
import { parseEnvelopeLines } from './store';

const validTurn = {
  v: 1,
  type: 'turn',
  ts: 1723000014.7,
  speech_id: 't1',
  payload: {
    turn_id: 't1',
    eou: { end_of_utterance_delay: 0.41, transcription_delay: 0.12 },
    llm: {
      ttft: 0.34,
      duration: 1.1,
      prompt_tokens: 820,
      completion_tokens: 58,
      tokens_per_second: 52.7,
      model: 'openai/gpt-4.1-mini',
    },
    total_response_latency: 0.94,
    degraded: false,
  },
};

describe('isEnvelope — accepts the contract', () => {
  it('accepts a complete turn envelope', () => {
    expect(isEnvelope(validTurn)).toBe(true);
  });

  it('accepts the incremental partials the agent actually emits', () => {
    expect(isEnvelope({ v: 1, type: 'turn', ts: 1, payload: { turn_id: 't1' } })).toBe(true);
  });

  it('accepts a tool-calling turn that reports its chain length', () => {
    const chained = {
      ...validTurn,
      payload: { ...validTurn.payload, llm: { ...validTurn.payload.llm, llm_calls: 3 } },
    };
    expect(isEnvelope(chained)).toBe(true);
  });
});

describe('isEnvelope — rejects crafted payloads', () => {
  const rejected: [string, unknown][] = [
    ['null', null],
    ['a bare string', 'turn'],
    ['an array', []],
    ['a missing schema version', { type: 'state', ts: 1, payload: { state: 'listening' } }],
    ['a future schema version', { v: 2, type: 'state', ts: 1, payload: { state: 'listening' } }],
    ['a non-numeric ts', { v: 1, type: 'state', ts: '1', payload: { state: 'listening' } }],
    ['a NaN ts', { v: 1, type: 'state', ts: NaN, payload: { state: 'listening' } }],
    ['an unknown type', { v: 1, type: 'gremlin', ts: 1, payload: {} }],
    // The crash that started this: it round-tripped, then threw at render.
    ['an empty call_meta payload', { v: 1, type: 'call_meta', ts: 1, payload: {} }],
    [
      'a call_meta with no pipeline',
      {
        v: 1,
        type: 'call_meta',
        ts: 1,
        payload: { call_id: 'x', room: 'y', started_at: 1, entry: 'browser' },
      },
    ],
    [
      'a call_meta whose pipeline is null',
      {
        v: 1,
        type: 'call_meta',
        ts: 1,
        payload: {
          call_id: 'x',
          room: 'y',
          started_at: 1,
          pipeline: null,
          entry: 'browser',
        },
      },
    ],
    [
      'a call_meta with an unknown entry point',
      {
        v: 1,
        type: 'call_meta',
        ts: 1,
        payload: {
          call_id: 'x',
          room: 'y',
          started_at: 1,
          pipeline: { stt: 'a', llm: 'b', tts: 'c' },
          entry: 'telepathy',
        },
      },
    ],
    // Two of these sum to Infinity in the waterfall, and Infinity/scale is NaN
    // in an SVG coordinate.
    [
      'a turn whose eou is astronomically large',
      {
        v: 1,
        type: 'turn',
        ts: 1,
        payload: {
          turn_id: 't1',
          eou: { end_of_utterance_delay: 1e308, transcription_delay: 0.1 },
        },
      },
    ],
    [
      'a turn with a negative duration',
      {
        v: 1,
        type: 'turn',
        ts: 1,
        payload: {
          turn_id: 't1',
          eou: { end_of_utterance_delay: -5, transcription_delay: 0.1 },
        },
      },
    ],
    [
      'a turn whose ttfb is negative',
      {
        v: 1,
        type: 'turn',
        ts: 1,
        payload: {
          turn_id: 't1',
          tts: { ttfb: -0.2, duration: 1, audio_duration: 1, model: 'x' },
        },
      },
    ],
    [
      'a usage payload with negative tokens',
      {
        v: 1,
        type: 'usage',
        ts: 1,
        payload: {
          llm_prompt_tokens: -1,
          llm_completion_tokens: 0,
          stt_audio_seconds: 0,
          tts_characters: 0,
          est_cost_usd: 0,
        },
      },
    ],
    ['a turn with no id', { v: 1, type: 'turn', ts: 1, payload: {} }],
    ['a turn whose id is a number', { v: 1, type: 'turn', ts: 1, payload: { turn_id: 7 } }],
    [
      'a turn whose llm block is half-built',
      { v: 1, type: 'turn', ts: 1, payload: { turn_id: 't1', llm: { ttft: 0.3 } } },
    ],
    [
      'a turn whose ttft is a string',
      {
        v: 1,
        type: 'turn',
        ts: 1,
        payload: { turn_id: 't1', llm: { ...validTurn.payload.llm, ttft: '0.34' } },
      },
    ],
    [
      'a turn whose latency is Infinity',
      { v: 1, type: 'turn', ts: 1, payload: { turn_id: 't1', total_response_latency: Infinity } },
    ],
    ['a transcript with no text', { v: 1, type: 'transcript', ts: 1, payload: { role: 'user' } }],
    [
      'a transcript from an unknown speaker',
      {
        v: 1,
        type: 'transcript',
        ts: 1,
        payload: { role: 'operator', text: 'hi', final: true, turn_id: 't1' },
      },
    ],
    ['a state that is not a state', { v: 1, type: 'state', ts: 1, payload: { state: 'melting' } }],
    ['a usage payload of strings', { v: 1, type: 'usage', ts: 1, payload: { est_cost_usd: '9' } }],
    ['a chaos payload with no flag', { v: 1, type: 'chaos', ts: 1, payload: { llm_delay_ms: 5 } }],
    ['a payload that is an array', { v: 1, type: 'state', ts: 1, payload: [] }],
    ['a payload that is null', { v: 1, type: 'state', ts: 1, payload: null }],
    ['a non-string speech_id', { v: 1, type: 'state', ts: 1, speech_id: 7, payload: {} }],
    // A guard table on a plain object would resolve this to Object.prototype.
    ['a prototype method as a type', { v: 1, type: 'toString', ts: 1, payload: {} }],
    ['a constructor as a type', { v: 1, type: 'constructor', ts: 1, payload: {} }],
  ];

  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => {
      expect(isEnvelope(value)).toBe(false);
    });
  }
});

/**
 * `transport` envelopes are minted by the cockpit itself, but they are held to
 * the same contract as anything off the wire: they also arrive inside stored
 * debriefs, which any visitor can POST.
 */
describe('isEnvelope — transport', () => {
  const transport = (payload: unknown) => ({ v: 1, type: 'transport', ts: 1, payload });

  it('accepts a full reading', () => {
    expect(
      isEnvelope(transport({ rtt_ms: 48, jitter_ms: 4.1, packet_loss_pct: 0.4, quality: 'good' })),
    ).toBe(true);
  });

  it('accepts a quality-only reading, which is the documented fallback', () => {
    // A muted microphone or a mid-reconnect transport reports no figures at
    // all; that sample is still worth keeping and must not be dropped.
    expect(isEnvelope(transport({ quality: 'excellent' }))).toBe(true);
  });

  it('accepts every quality the SDK can report', () => {
    for (const quality of ['excellent', 'good', 'poor', 'lost', 'unknown']) {
      expect(isEnvelope(transport({ quality }))).toBe(true);
    }
  });

  const rejected: [string, unknown][] = [
    ['no quality at all', { rtt_ms: 48 }],
    ['a quality the SDK never reports', { quality: 'vibes' }],
    ['a stringly-typed round trip', { quality: 'good', rtt_ms: '48' }],
    ['a negative round trip', { quality: 'good', rtt_ms: -1 }],
    ['a NaN jitter', { quality: 'good', jitter_ms: NaN }],
    ['an infinite jitter', { quality: 'good', jitter_ms: Infinity }],
    // Seconds mistaken for milliseconds is the plausible version of this bug;
    // an hour of round-trip time is the implausible one. Both flatten a
    // sparkline's y-scale into a floor.
    ['a round trip of an hour', { quality: 'good', rtt_ms: 3_600_000 }],
    ['a loss above 100%', { quality: 'poor', packet_loss_pct: 140 }],
    ['a negative loss', { quality: 'poor', packet_loss_pct: -0.5 }],
    ['a null payload', null],
    ['an array payload', []],
  ];

  for (const [name, payload] of rejected) {
    it(`rejects ${name}`, () => {
      expect(isEnvelope(transport(payload))).toBe(false);
    });
  }
});

describe('isEnvelope — llm.chain', () => {
  const withChain = (chain: unknown) => ({
    ...validTurn,
    payload: {
      ...validTurn.payload,
      llm: { ...validTurn.payload.llm, llm_calls: 2, chain },
    },
  });

  it('accepts a per-invocation breakdown', () => {
    expect(isEnvelope(withChain([{ ttft: 0.4, duration: 1.1 }, { ttft: 0.2, duration: 0.6 }]))).toBe(
      true,
    );
  });

  it('accepts a turn that reports a chain length but no chain', () => {
    // `chain` is optional by contract even when `llm_calls > 1`.
    expect(isEnvelope(validTurn)).toBe(true);
  });

  it('rejects a chain that is not an array', () => {
    expect(isEnvelope(withChain({ ttft: 0.4, duration: 1.1 }))).toBe(false);
  });

  it('rejects a link missing its duration', () => {
    expect(isEnvelope(withChain([{ ttft: 0.4 }]))).toBe(false);
  });

  it('rejects a link with a negative duration', () => {
    expect(isEnvelope(withChain([{ ttft: 0.4, duration: -1 }]))).toBe(false);
  });

  it('rejects a chain long enough to be a denial of service', () => {
    // Each link draws a mini-bar, and a stored debrief is attacker-controlled.
    const link = { ttft: 0.1, duration: 0.2 };
    expect(isEnvelope(withChain(new Array(MAX_LLM_CHAIN_LINKS).fill(link)))).toBe(true);
    expect(isEnvelope(withChain(new Array(MAX_LLM_CHAIN_LINKS + 1).fill(link)))).toBe(false);
  });
});

describe('parseEnvelopeLines', () => {
  it('keeps the good lines of a recording that also contains crafted ones', () => {
    const parsed = parseEnvelopeLines(
      [
        JSON.stringify(validTurn),
        JSON.stringify({ v: 1, type: 'call_meta', ts: 1, payload: {} }),
        '{"v":1,"type":"state","ts":2,"payload":{"state":"listening"}}',
      ].join('\n'),
    );
    expect(parsed.map((envelope) => envelope.type)).toEqual(['turn', 'state']);
  });
});

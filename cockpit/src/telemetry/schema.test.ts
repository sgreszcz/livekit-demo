/**
 * Ingest validation, from the attacker's side of the wire.
 *
 * Anyone can POST a debrief to the Worker and hand the resulting link to a
 * colleague, so every envelope the viewer replays is untrusted input. The bar
 * these tests hold: nothing that fails the v1 contract may reach the store.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_IDENTIFIER_CHARS,
  MAX_LLM_CHAIN_LINKS,
  MAX_RENDERED_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  clampTranscriptText,
  isEnvelope,
} from './schema';
import { parseEnvelopeLines, reduceAll } from './store';

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

/**
 * The v1.3 transport enrichment. Every field is optional, and the rule the
 * suite exists to hold is that optional does not mean unvalidated — a level of
 * 40 or a bitrate in bits per second reaches a meter's geometry otherwise.
 */
describe('isEnvelope — transport v1.3', () => {
  const transport = (payload: unknown) => ({ v: 1, type: 'transport', ts: 1, payload });
  const base = { quality: 'good' as const };

  it('accepts a fully enriched reading', () => {
    expect(
      isEnvelope(
        transport({
          ...base,
          rtt_ms: 48,
          jitter_ms: 4.1,
          packet_loss_pct: 0.4,
          audio_level_in: 0.31,
          audio_level_out: 0.02,
          bitrate_in_kbps: 24.1,
          bitrate_out_kbps: 31.7,
          jitter_buffer_ms: 61,
          concealed_pct: 0.4,
        }),
      ),
    ).toBe(true);
  });

  it('accepts each new field on its own', () => {
    // Browsers publish different subsets, so any one of these may arrive alone.
    const alone: Record<string, number> = {
      audio_level_in: 0.5,
      audio_level_out: 0,
      bitrate_in_kbps: 0,
      bitrate_out_kbps: 12.5,
      jitter_buffer_ms: 0,
      concealed_pct: 100,
    };
    for (const [key, value] of Object.entries(alone)) {
      expect(isEnvelope(transport({ ...base, [key]: value }))).toBe(true);
    }
  });

  it('still accepts a v1.1 reading that carries none of them', () => {
    expect(isEnvelope(transport({ ...base, rtt_ms: 48 }))).toBe(true);
  });

  const rejected: [string, unknown][] = [
    ['a level above unity', { ...base, audio_level_in: 1.4 }],
    ['a negative level', { ...base, audio_level_out: -0.1 }],
    // The plausible version of this bug: a level read in decibels, or a
    // percentage where an amplitude was expected. It pins a meter to full for
    // the rest of the call.
    ['a level in some other unit', { ...base, audio_level_in: 31 }],
    ['a stringly-typed level', { ...base, audio_level_in: '0.3' }],
    ['a NaN level', { ...base, audio_level_out: NaN }],
    ['a negative bitrate', { ...base, bitrate_in_kbps: -1 }],
    ['a bitrate that is really bits per second', { ...base, bitrate_out_kbps: 24_100_000 }],
    ['an infinite bitrate', { ...base, bitrate_in_kbps: Infinity }],
    ['a jitter buffer of an hour', { ...base, jitter_buffer_ms: 3_600_000 }],
    ['a negative jitter buffer', { ...base, jitter_buffer_ms: -1 }],
    ['concealment above 100%', { ...base, concealed_pct: 101 }],
    ['negative concealment', { ...base, concealed_pct: -0.1 }],
  ];

  for (const [name, payload] of rejected) {
    it(`rejects ${name}`, () => {
      expect(isEnvelope(transport(payload))).toBe(false);
    });
  }
});

/**
 * The chaos ack. The contract requires only the two v1.1 fields, because
 * recordings made by a v1.1 agent are still in KV and must still render.
 */
describe('isEnvelope — chaos v1.3', () => {
  const chaos = (payload: unknown) => ({ v: 1, type: 'chaos', ts: 1, payload });

  it('accepts a v1.1 ack with nothing but the delay and the flag', () => {
    expect(isEnvelope(chaos({ llm_delay_ms: 800, active: true }))).toBe(true);
  });

  it('accepts a full v1.3 ack', () => {
    expect(
      isEnvelope(
        chaos({
          llm_delay_ms: 800,
          tts_delay_ms: 300,
          slow_model: true,
          max_completion_tokens: 30,
          active: true,
        }),
      ),
    ).toBe(true);
  });

  it('accepts an explicit null token ceiling, which is how it is switched off', () => {
    // `null` is a value on this wire, not an omission — a guard that rejected
    // it would make token starvation impossible to turn back off.
    expect(
      isEnvelope(chaos({ llm_delay_ms: 0, max_completion_tokens: null, active: false })),
    ).toBe(true);
  });

  const rejected: [string, unknown][] = [
    ['an ack with no delay', { active: true }],
    ['an ack with no flag', { llm_delay_ms: 800 }],
    ['a negative voice delay', { llm_delay_ms: 0, tts_delay_ms: -1, active: false }],
    ['a stringly-typed voice delay', { llm_delay_ms: 0, tts_delay_ms: '300', active: false }],
    ['a slow-model flag that is not a boolean', { llm_delay_ms: 0, slow_model: 'yes', active: false }],
    ['a negative token ceiling', { llm_delay_ms: 0, max_completion_tokens: -5, active: false }],
    ['a stringly-typed token ceiling', { llm_delay_ms: 0, max_completion_tokens: '30', active: false }],
  ];

  for (const [name, payload] of rejected) {
    it(`rejects ${name}`, () => {
      expect(isEnvelope(chaos(payload))).toBe(false);
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

/**
 * The magnitudes a finiteness check lets through.
 *
 * `Number.isFinite` rejects NaN and Infinity, which is where this file started,
 * but `1.7e308` is a perfectly finite double — and the store subtracts one
 * timestamp from another. Two finite values at opposite ends of the range
 * subtract to Infinity, which reaches the page as "Infinitym" and "NaNs" on an
 * instrument panel whose stated rule is that neither may ever be printed. A
 * debrief is fetched by an id anyone can paste into a link, so this is not a
 * theoretical reachability argument.
 */
describe('isEnvelope — bounds, not just finiteness', () => {
  const stateEnvelope = (ts: unknown) => ({
    v: 1,
    type: 'state',
    ts,
    payload: { state: 'listening' },
  });

  it('accepts the timestamps a real call produces', () => {
    expect(isEnvelope(stateEnvelope(1723000014.7))).toBe(true);
    // Fixtures and tests legitimately count from zero.
    expect(isEnvelope(stateEnvelope(0))).toBe(true);
  });

  it('rejects a timestamp large enough to overflow the call duration', () => {
    for (const ts of [1.7e308, 1e300, 8e9 * 1e3]) {
      expect(isEnvelope(stateEnvelope(ts))).toBe(false);
    }
  });

  it('rejects a timestamp before the epoch, which would reverse the axis', () => {
    expect(isEnvelope(stateEnvelope(-1))).toBe(false);
    expect(isEnvelope(stateEnvelope(-1e308))).toBe(false);
  });

  it('rejects a call_meta whose start time is out of range', () => {
    const meta = (started_at: number) => ({
      v: 1,
      type: 'call_meta',
      ts: 1,
      payload: {
        call_id: 'c1',
        room: 'cockpit-demo01',
        started_at,
        pipeline: { stt: 'a', llm: 'b', tts: 'c' },
        entry: 'sip',
      },
    });
    expect(isEnvelope(meta(1723000000))).toBe(true);
    expect(isEnvelope(meta(1.7e308))).toBe(false);
    expect(isEnvelope(meta(-1))).toBe(false);
  });

  it('rejects a running cost no voice demo could incur', () => {
    const usage = (est_cost_usd: number) => ({
      v: 1,
      type: 'usage',
      ts: 1,
      payload: {
        llm_prompt_tokens: 10,
        llm_completion_tokens: 10,
        stt_audio_seconds: 1,
        tts_characters: 10,
        est_cost_usd,
      },
    });
    expect(isEnvelope(usage(0.0042))).toBe(true);
    // Not NaN and not Infinity — just a number wide enough to shoulder the
    // cost ledger apart, which is the same bug wearing a different hat.
    expect(isEnvelope(usage(9e15))).toBe(false);
  });

  it('rejects token counts past anything a call could accumulate', () => {
    const usage = (llm_prompt_tokens: number) => ({
      v: 1,
      type: 'usage',
      ts: 1,
      payload: {
        llm_prompt_tokens,
        llm_completion_tokens: 10,
        stt_audio_seconds: 1,
        tts_characters: 10,
        est_cost_usd: 0.01,
      },
    });
    expect(isEnvelope(usage(820))).toBe(true);
    expect(isEnvelope(usage(Number.MAX_SAFE_INTEGER))).toBe(false);
  });

  it('rejects an injected delay that is not a delay', () => {
    const chaos = (llm_delay_ms: number) => ({
      v: 1,
      type: 'chaos',
      ts: 1,
      payload: { llm_delay_ms, active: true },
    });
    expect(isEnvelope(chaos(800))).toBe(true);
    expect(isEnvelope(chaos(1e15))).toBe(false);
  });
});

/**
 * String length, which `typeof value === 'string'` says nothing about.
 *
 * Identifiers reach the page as chips, placards and React keys; a quarter of a
 * megabyte in a field rendered inside a fixed gutter is a layout weapon, not a
 * model name. Transcript text is the one field where length is legitimately
 * content, so it is bounded far more generously and truncated for display
 * rather than rejected — losing a long line loses information, and rendering
 * all of it costs a layout pass proportional to whatever was sent.
 */
describe('isEnvelope — string bounds', () => {
  const transcript = (text: string, turn_id = 't1') => ({
    v: 1,
    type: 'transcript',
    ts: 1,
    payload: { role: 'user', text, final: true, turn_id },
  });

  it('accepts an ordinary utterance', () => {
    expect(isEnvelope(transcript('I would like to book a table for four.'))).toBe(true);
  });

  it('accepts a long but plausible transcript line', () => {
    expect(isEnvelope(transcript('x'.repeat(MAX_RENDERED_TRANSCRIPT_CHARS + 1)))).toBe(true);
  });

  it('rejects a transcript line that is an attack rather than an utterance', () => {
    expect(isEnvelope(transcript('x'.repeat(MAX_TRANSCRIPT_CHARS))).valueOf()).toBe(true);
    expect(isEnvelope(transcript('x'.repeat(MAX_TRANSCRIPT_CHARS + 1)))).toBe(false);
  });

  it('rejects an identifier long enough to break the layout it renders in', () => {
    expect(isEnvelope(transcript('hello', 'x'.repeat(MAX_IDENTIFIER_CHARS)))).toBe(true);
    expect(isEnvelope(transcript('hello', 'x'.repeat(MAX_IDENTIFIER_CHARS + 1)))).toBe(false);
  });

  it('rejects an oversized model name, which renders in a chip', () => {
    expect(
      isEnvelope({
        v: 1,
        type: 'turn',
        ts: 1,
        payload: {
          turn_id: 't1',
          stt: { duration: 0.1, audio_duration: 1, model: 'x'.repeat(500) },
        },
      }),
    ).toBe(false);
  });
});

describe('clampTranscriptText', () => {
  it('leaves an ordinary line exactly as it was', () => {
    expect(clampTranscriptText('a table for four, please')).toBe('a table for four, please');
  });

  it('cuts a long line and says that it did', () => {
    const clamped = clampTranscriptText('x'.repeat(MAX_TRANSCRIPT_CHARS));
    // The ellipsis is the honest part: the line was cut, not ended.
    expect(clamped).toHaveLength(MAX_RENDERED_TRANSCRIPT_CHARS + 1);
    expect(clamped.endsWith('…')).toBe(true);
  });

  it('is what the store applies, so no renderer has to remember to', () => {
    const [envelope] = parseEnvelopeLines(
      JSON.stringify({
        v: 1,
        type: 'transcript',
        ts: 1,
        payload: { role: 'user', text: 'y'.repeat(MAX_TRANSCRIPT_CHARS), final: true, turn_id: 't1' },
      }),
    );
    const state = reduceAll([envelope]);
    expect(state.transcript[0].text).toHaveLength(MAX_RENDERED_TRANSCRIPT_CHARS + 1);
  });
});

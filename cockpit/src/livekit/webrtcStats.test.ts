/**
 * The v1.3 transport arithmetic.
 *
 * Every figure here is a delta between two cumulative counters, which is the
 * category of bug that does not show up in a demo: a ratio of raw totals looks
 * perfectly plausible on screen and simply never moves, and a counter reset on
 * a reconnect produces a negative that renders as a cliff nobody caused. So the
 * cases below are mostly about what must *not* be reported.
 *
 * A `Map` stands in for `RTCStatsReport` because that is exactly what it is —
 * the report is a `Map`-like of stats objects, and the readers here probe it
 * structurally rather than requiring the real thing.
 */

import { describe, expect, it } from 'vitest';
import { isEnvelope } from '../telemetry/schema';
import {
  deriveAudioFields,
  readInboundAudio,
  readOutboundAudio,
  type AudioStatsSnapshot,
} from './webrtcStats';

const report = (...entries: Record<string, unknown>[]): Map<string, unknown> =>
  new Map(entries.map((entry, index) => [`s${index}`, entry]));

const inbound = (extra: Record<string, unknown> = {}) => ({
  type: 'inbound-rtp',
  kind: 'audio',
  timestamp: 1000,
  audioLevel: 0.31,
  bytesReceived: 10_000,
  jitterBufferDelay: 2,
  jitterBufferEmittedCount: 40_000,
  concealedSamples: 100,
  totalSamplesReceived: 40_000,
  ...extra,
});

describe('readInboundAudio', () => {
  it('lifts every counter the ratios need', () => {
    expect(readInboundAudio(report(inbound()))).toEqual({
      timestampMs: 1000,
      audioLevel: 0.31,
      bytes: 10_000,
      jitterBufferDelay: 2,
      jitterBufferEmittedCount: 40_000,
      concealedSamples: 100,
      totalSamplesReceived: 40_000,
    });
  });

  it('ignores the video stream sharing the report', () => {
    const found = readInboundAudio(
      report({ type: 'inbound-rtp', kind: 'video', bytesReceived: 999_999 }, inbound()),
    );
    expect(found?.bytes).toBe(10_000);
  });

  it('accepts the legacy `mediaType` spelling', () => {
    const found = readInboundAudio(
      report({ type: 'inbound-rtp', mediaType: 'audio', bytesReceived: 42, timestamp: 1 }),
    );
    expect(found?.bytes).toBe(42);
  });

  it('keeps the fields a browser did publish and drops the ones it did not', () => {
    const found = readInboundAudio(
      report({ type: 'inbound-rtp', kind: 'audio', timestamp: 1, bytesReceived: 5 }),
    );
    expect(found?.bytes).toBe(5);
    expect(found?.audioLevel).toBeUndefined();
    expect(found?.concealedSamples).toBeUndefined();
  });

  it('rejects a stringly-typed counter rather than carrying it into arithmetic', () => {
    const found = readInboundAudio(
      report({ type: 'inbound-rtp', kind: 'audio', timestamp: 1, bytesReceived: '5000' }),
    );
    expect(found?.bytes).toBeUndefined();
  });

  it('returns nothing for a report with no audio, an empty one, or a non-report', () => {
    expect(readInboundAudio(report({ type: 'outbound-rtp', kind: 'audio' }))).toBeUndefined();
    expect(readInboundAudio(report())).toBeUndefined();
    expect(readInboundAudio(undefined)).toBeUndefined();
    expect(readInboundAudio({ nope: true })).toBeUndefined();
    expect(readInboundAudio(null)).toBeUndefined();
  });
});

describe('readOutboundAudio', () => {
  it('assembles bytes from the stream and the level from the capture source', () => {
    const found = readOutboundAudio(
      report(
        { type: 'outbound-rtp', kind: 'audio', timestamp: 2000, bytesSent: 8000 },
        { type: 'media-source', kind: 'audio', audioLevel: 0.02 },
      ),
    );
    expect(found).toEqual({ timestampMs: 2000, audioLevel: 0.02, bytes: 8000 });
  });

  it('still reports a level when the stream entry is absent', () => {
    // A muted microphone is exactly this shape, and the level is the reading
    // that says so.
    const found = readOutboundAudio(
      report({ type: 'media-source', kind: 'audio', timestamp: 5, audioLevel: 0 }),
    );
    expect(found?.audioLevel).toBe(0);
    expect(found?.bytes).toBeUndefined();
  });

  it('returns nothing when neither half is present', () => {
    expect(readOutboundAudio(report({ type: 'inbound-rtp', kind: 'audio' }))).toBeUndefined();
  });
});

describe('deriveAudioFields', () => {
  const pair = (over: Partial<AudioStatsSnapshot> = {}, timestampMs = 3000) => ({
    inbound: { ...inboundSnapshot, timestampMs, ...over },
  });

  const inboundSnapshot: AudioStatsSnapshot = {
    timestampMs: 1000,
    audioLevel: 0.31,
    bytes: 10_000,
    jitterBufferDelay: 2,
    jitterBufferEmittedCount: 40_000,
    concealedSamples: 100,
    totalSamplesReceived: 40_000,
  };

  it('reports levels on the very first sample, before any delta exists', () => {
    // Levels are instantaneous. Withholding them for one interval alongside the
    // rates would leave the meters dead for the first two seconds of a call.
    const fields = deriveAudioFields(null, {
      inbound: inboundSnapshot,
      outbound: { timestampMs: 1000, audioLevel: 0.02, bytes: 500 },
    });
    expect(fields).toEqual({ audio_level_in: 0.31, audio_level_out: 0.02 });
  });

  it('derives every rate and ratio from a clean second reading', () => {
    const fields = deriveAudioFields(
      { inbound: inboundSnapshot, outbound: { timestampMs: 1000, bytes: 4000 } },
      {
        inbound: {
          timestampMs: 3000, // 2 s later
          audioLevel: 0.44,
          bytes: 16_000, // +6000 bytes = 48 kbit over 2 s = 24 kb/s
          jitterBufferDelay: 2.6, // +0.6 s over
          jitterBufferEmittedCount: 50_000, // +10 000 samples = 0.06 ms each
          concealedSamples: 200, // +100 concealed of
          totalSamplesReceived: 50_000, // +10 000 received = 1%
        },
        outbound: { timestampMs: 3000, bytes: 12_000 }, // +8000 = 32 kb/s
      },
    );

    expect(fields).toEqual({
      audio_level_in: 0.44,
      bitrate_in_kbps: 24,
      bitrate_out_kbps: 32,
      jitter_buffer_ms: 0.1, // 0.06 ms, rounded to one decimal
      concealed_pct: 1,
    });
  });

  it('reports nothing rate-like when the counters went backwards', () => {
    // A renegotiated transport restarts every counter at zero. Differencing
    // across that produces negatives, and a negative bitrate is not a slow
    // link — it is a measurement that did not happen.
    const fields = deriveAudioFields(
      { inbound: inboundSnapshot },
      pair({ bytes: 10, jitterBufferDelay: 0, jitterBufferEmittedCount: 0, concealedSamples: 0, totalSamplesReceived: 0 }),
    );
    expect(fields.bitrate_in_kbps).toBeUndefined();
    expect(fields.jitter_buffer_ms).toBeUndefined();
    expect(fields.concealed_pct).toBeUndefined();
  });

  it('measures nothing rather than zero when no samples were emitted', () => {
    // The distinction the whole panel rests on: a track that emitted nothing
    // did not conceal 0% of it, and a dash is the honest answer.
    const fields = deriveAudioFields({ inbound: inboundSnapshot }, pair());
    expect(fields.jitter_buffer_ms).toBeUndefined();
    expect(fields.concealed_pct).toBeUndefined();
  });

  it('refuses to divide by a zero or negative interval', () => {
    const same = deriveAudioFields(
      { inbound: inboundSnapshot },
      pair({ bytes: 20_000 }, 1000),
    );
    expect(same.bitrate_in_kbps).toBeUndefined();

    const backwards = deriveAudioFields(
      { inbound: inboundSnapshot },
      pair({ bytes: 20_000 }, 500),
    );
    expect(backwards.bitrate_in_kbps).toBeUndefined();
  });

  it('omits a bitrate when the report carried no timestamp to measure against', () => {
    const fields = deriveAudioFields(
      { inbound: { bytes: 1000 } },
      { inbound: { bytes: 5000 } },
    );
    expect(fields.bitrate_in_kbps).toBeUndefined();
  });

  it('derives each direction independently', () => {
    // One-way stats are the ordinary case for the first second of a call, and
    // an inbound figure must never be withheld because the microphone has not
    // reported yet.
    const fields = deriveAudioFields(
      { inbound: inboundSnapshot },
      {
        inbound: { timestampMs: 3000, bytes: 16_000 },
      },
    );
    expect(fields.bitrate_in_kbps).toBe(24);
    expect(fields.bitrate_out_kbps).toBeUndefined();
  });

  it('clamps a level a browser reports outside 0..1', () => {
    // The schema rejects anything outside the range, and a rejected envelope
    // costs the whole sample — RTT and jitter included.
    const fields = deriveAudioFields(null, {
      inbound: { audioLevel: 1.4 },
      outbound: { audioLevel: -0.2 },
    });
    expect(fields.audio_level_in).toBe(1);
    expect(fields.audio_level_out).toBe(0);
  });

  it('bounds concealment at 100% however the counters disagree', () => {
    const fields = deriveAudioFields(
      { inbound: { concealedSamples: 0, totalSamplesReceived: 0 } },
      { inbound: { concealedSamples: 5000, totalSamplesReceived: 100 } },
    );
    expect(fields.concealed_pct).toBe(100);
  });

  it('returns an empty object when there is nothing to say', () => {
    expect(deriveAudioFields(null, {})).toEqual({});
  });
});

/**
 * Bounds, which are not cosmetic.
 *
 * `isEnvelope` validates the whole payload and drops the envelope entire if any
 * one field is out of range. So an absurd derived bitrate does not cost the
 * bitrate tile — it costs the round-trip time, the jitter, the loss, the
 * quality verdict and both level meters travelling in the same sample. These
 * assert the enrichment can never poison the reading it enriches.
 */
describe('deriveAudioFields — schema bounds', () => {
  it('omits a bitrate too large for the schema rather than reporting it', () => {
    // Timestamps 1 ms apart with a large byte delta: a report read across a
    // renegotiation, not a 1.6 Gb/s audio stream.
    const fields = deriveAudioFields(
      { inbound: { timestampMs: 1000, bytes: 0 } },
      { inbound: { timestampMs: 1001, bytes: 200_000 } },
    );
    expect(fields.bitrate_in_kbps).toBeUndefined();
  });

  it('omits a jitter buffer delay beyond anything the schema will take', () => {
    const fields = deriveAudioFields(
      { inbound: { jitterBufferDelay: 0, jitterBufferEmittedCount: 0 } },
      { inbound: { jitterBufferDelay: 7200, jitterBufferEmittedCount: 1 } },
    );
    expect(fields.jitter_buffer_ms).toBeUndefined();
  });

  it('keeps every derived field inside what isEnvelope accepts', () => {
    // The end-to-end version of the claim: whatever the counters do, the
    // payload still validates and the v1.1 figures still reach the store.
    const absurd = deriveAudioFields(
      { inbound: { timestampMs: 1000, bytes: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0, concealedSamples: 0, totalSamplesReceived: 0 } },
      {
        inbound: {
          timestampMs: 1001,
          audioLevel: 4,
          bytes: 900_000_000,
          jitterBufferDelay: 9000,
          jitterBufferEmittedCount: 1,
          concealedSamples: 900,
          totalSamplesReceived: 10,
        },
        outbound: { timestampMs: 1001, bytes: 900_000_000, audioLevel: -3 },
      },
    );

    const envelope = {
      v: 1,
      type: 'transport',
      ts: 1,
      payload: { quality: 'good', rtt_ms: 48, jitter_ms: 4.1, packet_loss_pct: 0.4, ...absurd },
    };
    expect(isEnvelope(envelope)).toBe(true);
    // And the v1.1 figures survived intact, which is the whole point.
    expect((envelope.payload as { rtt_ms: number }).rtt_ms).toBe(48);
  });
});

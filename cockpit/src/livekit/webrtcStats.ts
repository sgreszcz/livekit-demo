/**
 * The arithmetic behind the v1.3 transport fields, with no SDK and no browser
 * in it.
 *
 * Everything here reads the *raw* `RTCStatsReport` rather than livekit-client's
 * mapped `AudioSenderStats`/`AudioReceiverStats`, and that is not a preference.
 * Two of the four figures the schema asks for are ratios whose denominators —
 * `jitterBufferEmittedCount` and `totalSamplesReceived` — the SDK's mapped
 * types do not carry at all, and `audioLevel` is absent from both of them. A
 * jitter-buffer delay without its emitted count is a cumulative total that
 * grows for the life of the call; printed as milliseconds it would climb
 * forever and mean nothing.
 *
 * Every counter in a stats report is cumulative, so every figure derived from
 * one is a delta against the previous reading. Three things follow, and all
 * three are handled below rather than in the caller:
 *
 *   - A counter that went *backwards* is a renegotiated transport, not a
 *     measurement. It re-baselines and reports nothing for that interval.
 *   - A denominator delta of zero measured nothing. It is not a zero: a track
 *     that emitted no samples did not conceal 0% of them.
 *   - A browser that does not publish a field is not a broken browser. Each
 *     figure is derived independently, so Firefox missing `audioLevel` costs
 *     the level meter and nothing else.
 *
 * Split out from `session.ts` so all of that is unit-testable against plain
 * `Map`s, which is the only way any of these edge cases gets exercised — a real
 * `RTCStatsReport` needs a real peer connection with real audio flowing.
 */

/**
 * The counters we lift out of one report, in the report's own units: seconds
 * for durations, bytes for volume, `timestamp` in DOMHighResTimeStamp
 * milliseconds. Nothing is converted here — conversion belongs with the delta.
 */
export interface AudioStatsSnapshot {
  timestampMs?: number;
  /** 0..1, instantaneous rather than cumulative. */
  audioLevel?: number;
  /** `bytesReceived` inbound, `bytesSent` outbound. */
  bytes?: number;
  /** Cumulative seconds of buffering across every emitted sample. */
  jitterBufferDelay?: number;
  /** Cumulative count those seconds are spread over. */
  jitterBufferEmittedCount?: number;
  concealedSamples?: number;
  totalSamplesReceived?: number;
}

/** One reading of both directions, as taken from two separate reports. */
export interface AudioStatsPair {
  inbound?: AudioStatsSnapshot;
  outbound?: AudioStatsSnapshot;
}

/**
 * The v1.3 subset of a `transport` payload. Written in the wire's spelling so
 * the caller can spread it straight into the envelope: a translation layer
 * between this and the schema would be one more place for a field to be
 * dropped silently.
 */
export interface DerivedAudioFields {
  audio_level_in?: number;
  audio_level_out?: number;
  bitrate_in_kbps?: number;
  bitrate_out_kbps?: number;
  jitter_buffer_ms?: number;
  concealed_pct?: number;
}

/*
 * The schema's own ceilings, restated.
 *
 * Not belt and braces. `isEnvelope` validates the whole payload and drops the
 * envelope entire if any one field fails — so a single absurd bitrate does not
 * cost the bitrate tile, it costs the RTT, the jitter, the loss, the quality
 * verdict and both level meters riding in the same sample. The enrichment must
 * therefore never be able to poison the reading it enriches.
 *
 * Out-of-range figures are OMITTED rather than clamped. A level is an amplitude
 * and a concealment ratio is a share, so both are bounded by definition and
 * clamping one is correcting a rounding disagreement. A bitrate has no such
 * bound: 200,000 kb/s of audio is not a fast link, it is a measurement taken
 * across a timestamp that moved, and pinning it to the ceiling would print a
 * fabricated number where a dash is the honest answer.
 */
const MAX_BITRATE_KBPS = 100_000;
const MAX_BUFFER_MS = 60_000;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** The value, or undefined if it is outside what the schema will accept. */
function within(value: number, max: number): number | undefined {
  return Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}

/** Reads a numeric field off an unknown stats entry, or undefined. */
function num(entry: Record<string, unknown>, key: string): number | undefined {
  const value = entry[key];
  return isFiniteNumber(value) ? value : undefined;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Flattens a stats report into plain entries.
 *
 * `RTCStatsReport` is a `Map`-like with a `forEach`, and so is the `Map` the
 * tests pass in — which is the point. It is probed structurally rather than
 * assumed, because this runs on an interval for the whole call and a browser
 * that hands back something unexpected must cost one sample, not the call.
 */
function statsEntries(report: unknown): Record<string, unknown>[] {
  const source = report as { forEach?: (callback: (value: unknown) => void) => void } | null;
  if (typeof source?.forEach !== 'function') return [];

  const entries: Record<string, unknown>[] = [];
  try {
    source.forEach((value) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        entries.push(value as Record<string, unknown>);
      }
    });
  } catch {
    return [];
  }
  return entries;
}

/**
 * True for an audio stats entry of the given type.
 *
 * Both spellings are accepted: `kind` is the current standard and `mediaType`
 * is what older reports use, and a browser that only publishes the legacy one
 * would otherwise contribute no audio stats whatsoever. An entry that declares
 * neither is taken at its type — a report with no video in it has nothing to
 * confuse it with.
 */
function isAudio(entry: Record<string, unknown>, type: string): boolean {
  if (entry.type !== type) return false;
  const kind = entry.kind ?? entry.mediaType;
  return kind === undefined || kind === 'audio';
}

/** The agent's inbound audio, as far as this browser's decoder is concerned. */
export function readInboundAudio(report: unknown): AudioStatsSnapshot | undefined {
  for (const entry of statsEntries(report)) {
    if (!isAudio(entry, 'inbound-rtp')) continue;
    return {
      timestampMs: num(entry, 'timestamp'),
      audioLevel: num(entry, 'audioLevel'),
      bytes: num(entry, 'bytesReceived'),
      jitterBufferDelay: num(entry, 'jitterBufferDelay'),
      jitterBufferEmittedCount: num(entry, 'jitterBufferEmittedCount'),
      concealedSamples: num(entry, 'concealedSamples'),
      totalSamplesReceived: num(entry, 'totalSamplesReceived'),
    };
  }
  return undefined;
}

/**
 * The microphone, assembled from two entries.
 *
 * The bytes are on `outbound-rtp`; the level is on `media-source`, because an
 * outbound level is a property of the capture device rather than of the stream
 * leaving it — a muted microphone still has an RTP stream and it is the source
 * that reads silent. Either half may be missing on its own.
 */
export function readOutboundAudio(report: unknown): AudioStatsSnapshot | undefined {
  const entries = statsEntries(report);
  const outbound = entries.find((entry) => isAudio(entry, 'outbound-rtp'));
  const source = entries.find((entry) => isAudio(entry, 'media-source'));
  if (!outbound && !source) return undefined;

  return {
    timestampMs: outbound ? num(outbound, 'timestamp') : num(source!, 'timestamp'),
    audioLevel: source ? num(source, 'audioLevel') : undefined,
    bytes: outbound ? num(outbound, 'bytesSent') : undefined,
  };
}

/** Seconds between two snapshots, or undefined if that cannot be established. */
function intervalSeconds(
  previous: AudioStatsSnapshot,
  current: AudioStatsSnapshot,
): number | undefined {
  const { timestampMs: before } = previous;
  const { timestampMs: after } = current;
  if (before === undefined || after === undefined) return undefined;
  const seconds = (after - before) / 1000;
  // Zero means two readings of one report; negative means the clock or the
  // transport moved under us. Neither is an interval to divide by.
  return seconds > 0 ? seconds : undefined;
}

/** Kilobits per second over the interval, or undefined. */
function bitrateKbps(
  previous: AudioStatsSnapshot | undefined,
  current: AudioStatsSnapshot | undefined,
): number | undefined {
  if (!previous || !current) return undefined;
  const { bytes: before } = previous;
  const { bytes: after } = current;
  if (before === undefined || after === undefined) return undefined;

  const seconds = intervalSeconds(previous, current);
  if (seconds === undefined) return undefined;

  const delta = after - before;
  // A byte counter cannot go backwards without the transport having been
  // replaced underneath it.
  if (delta < 0) return undefined;

  return within(round((delta * 8) / 1000 / seconds, 1), MAX_BITRATE_KBPS);
}

/**
 * Mean jitter-buffer delay per sample emitted during the interval, in ms.
 *
 * Both counters are cumulative, so this is `Δdelay / Δcount` — the average wait
 * of the audio actually played in the last two seconds, not the average since
 * the call began. The distinction is the whole value of the figure: a buffer
 * that spiked thirty seconds ago should not still be showing.
 */
function jitterBufferMs(
  previous: AudioStatsSnapshot | undefined,
  current: AudioStatsSnapshot | undefined,
): number | undefined {
  if (!previous || !current) return undefined;
  const delaySeconds = delta(previous.jitterBufferDelay, current.jitterBufferDelay);
  const emitted = delta(previous.jitterBufferEmittedCount, current.jitterBufferEmittedCount);
  if (delaySeconds === undefined || emitted === undefined) return undefined;
  // No samples emitted is not a delay of zero — it is nothing to average over.
  if (emitted <= 0) return undefined;
  return within(round((delaySeconds / emitted) * 1000, 1), MAX_BUFFER_MS);
}

/**
 * The share of played-out samples the decoder had to invent, as a percentage.
 *
 * This is the number the panel leads on. Packet loss on the uplink is a network
 * statistic; concealment is the same event after the jitter buffer has failed
 * to hide it, which makes it the only figure on the panel that corresponds to
 * something the caller can hear.
 */
function concealedPct(
  previous: AudioStatsSnapshot | undefined,
  current: AudioStatsSnapshot | undefined,
): number | undefined {
  if (!previous || !current) return undefined;
  const concealed = delta(previous.concealedSamples, current.concealedSamples);
  const received = delta(previous.totalSamplesReceived, current.totalSamplesReceived);
  if (concealed === undefined || received === undefined) return undefined;
  if (received <= 0) return undefined;
  // Concealed samples are counted within the received total, so the ratio is
  // bounded by construction — but a browser that disagrees must not produce a
  // percentage the schema will reject and drop the whole sample over.
  return round(Math.min(100, (concealed / received) * 100), 2);
}

/** Non-negative difference between two cumulative counters, or undefined. */
function delta(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined || after === undefined) return undefined;
  const difference = after - before;
  return difference >= 0 ? difference : undefined;
}

/**
 * Everything derivable from one pair of readings.
 *
 * `previous` is null on the first sample of a call, and that is the ordinary
 * case rather than an error: levels are instantaneous and appear immediately,
 * the four rate-and-ratio figures appear one interval later.
 */
export function deriveAudioFields(
  previous: AudioStatsPair | null,
  current: AudioStatsPair,
): DerivedAudioFields {
  const fields: DerivedAudioFields = {};

  const levelIn = current.inbound?.audioLevel;
  if (levelIn !== undefined) fields.audio_level_in = round(Math.min(1, Math.max(0, levelIn)), 3);

  const levelOut = current.outbound?.audioLevel;
  if (levelOut !== undefined) fields.audio_level_out = round(Math.min(1, Math.max(0, levelOut)), 3);

  const bitrateIn = bitrateKbps(previous?.inbound, current.inbound);
  if (bitrateIn !== undefined) fields.bitrate_in_kbps = bitrateIn;

  const bitrateOut = bitrateKbps(previous?.outbound, current.outbound);
  if (bitrateOut !== undefined) fields.bitrate_out_kbps = bitrateOut;

  const buffer = jitterBufferMs(previous?.inbound, current.inbound);
  if (buffer !== undefined) fields.jitter_buffer_ms = buffer;

  const concealed = concealedPct(previous?.inbound, current.inbound);
  if (concealed !== undefined) fields.concealed_pct = concealed;

  return fields;
}

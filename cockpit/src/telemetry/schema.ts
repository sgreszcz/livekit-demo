/**
 * Wire types for the Glass Cockpit telemetry contract.
 * Mirrors docs/TELEMETRY-SCHEMA.md (envelope v1, contract v1.3) — do not change
 * unilaterally.
 * All durations on the wire are SECONDS (SDK-native); the UI renders milliseconds.
 */

export const SCHEMA_VERSION = 1;

export type EnvelopeType =
  | 'turn'
  | 'transcript'
  | 'state'
  | 'interruption'
  | 'usage'
  | 'chaos'
  | 'call_meta'
  | 'transport';

export interface EnvelopeBase<T extends EnvelopeType, P> {
  v: number;
  type: T;
  /** Unix seconds on the agent clock, float. */
  ts: number;
  speech_id?: string;
  payload: P;
}

export interface EouMetrics {
  end_of_utterance_delay: number;
  transcription_delay: number;
}

export interface SttMetrics {
  duration: number;
  audio_duration: number;
  model: string;
}

/** One invocation of a tool-calling chain, in call order. */
export interface LlmChainLink {
  ttft: number;
  duration: number;
}

export interface LlmMetrics {
  /** Effective perceived first token across the whole chain — see the schema. */
  ttft: number;
  /** Summed duration of every invocation in the chain. */
  duration: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens_per_second: number;
  /** Invocations in this turn; > 1 means the model called tools. Absent = 1. */
  llm_calls?: number;
  /**
   * Per-invocation breakdown, emitted only when `llm_calls > 1`. Optional by
   * contract: an agent that does not report it is not malformed, and the turn
   * still renders from the summed `ttft`/`duration` above.
   */
  chain?: LlmChainLink[];
  model: string;
}

export interface TtsMetrics {
  ttfb: number;
  duration: number;
  audio_duration: number;
  model: string;
}

/** Emitted incrementally per stage; merged by `turn_id`, last-write-wins per field. */
export interface TurnPayload {
  turn_id: string;
  eou?: EouMetrics;
  stt?: SttMetrics;
  llm?: LlmMetrics;
  tts?: TtsMetrics;
  /** eou.end_of_utterance_delay + llm.ttft + tts.ttfb, computed agent-side. */
  total_response_latency?: number;
  degraded?: boolean;
}

export type TranscriptRole = 'user' | 'agent';

export interface TranscriptPayload {
  role: TranscriptRole;
  text: string;
  final: boolean;
  turn_id: string;
}

export type AgentState = 'initializing' | 'listening' | 'thinking' | 'speaking';

export interface StatePayload {
  state: AgentState;
  prev?: AgentState;
}

export type InterruptionKind = 'barge_in' | 'false_interruption';

export interface InterruptionPayload {
  kind: InterruptionKind;
  turn_id: string;
}

export interface UsagePayload {
  llm_prompt_tokens: number;
  llm_completion_tokens: number;
  stt_audio_seconds: number;
  tts_characters: number;
  est_cost_usd: number;
}

/**
 * The agent's acknowledgement, carrying the FULL current injection state (v1.3).
 *
 * Only `llm_delay_ms` and `active` are required, because that is all a v1.1
 * agent ever sent and its recordings are still in KV. Every v1.3 injection is
 * optional on the wire and reads as *off* when absent — an ack that does not
 * mention token starvation is an agent that does not starve tokens, not an
 * agent whose setting is unknown.
 */
export interface ChaosPayload {
  llm_delay_ms: number;
  /** Delay in front of speech synthesis. Absent = 0. */
  tts_delay_ms?: number;
  /** The LLM swapped for a deliberately heavier one. Absent = false. */
  slow_model?: boolean;
  /** Completion-token ceiling; `null` and absent both mean no ceiling. */
  max_completion_tokens?: number | null;
  /** True when any injection is armed — the agent's own verdict, not ours. */
  active: boolean;
}

/** Matches the `ConnectionQuality` enum livekit-client exports, value for value. */
export type TransportQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

/**
 * A WebRTC transport reading, sampled BY THE COCKPIT rather than the agent —
 * the agent never sees the caller's network path. Never published on the data
 * channel; it reaches the store locally and rides along in browser-posted
 * debriefs.
 *
 * Only `quality` is required. The SDK reports it for every session, but the
 * numeric stats come from an `RTCStatsReport` that a muted microphone, a
 * mid-reconnect transport or an SDK that has moved on can all decline to
 * provide — and a panel that needs three numbers to render is a panel that
 * goes blank exactly when the connection gets interesting.
 */
export interface TransportPayload {
  rtt_ms?: number;
  jitter_ms?: number;
  packet_loss_pct?: number;
  quality: TransportQuality;

  /* ── v1.3, all optional ────────────────────────────────────────────────
   *
   * These come from the raw `RTCStatsReport`, not from the SDK's own mapped
   * stats objects, because the two counters that make `concealed_pct` and
   * `jitter_buffer_ms` meaningful — `totalSamplesReceived` and
   * `jitterBufferEmittedCount` — are not in the SDK's `AudioReceiverStats`.
   * Browsers differ on which of these they publish, so every one of them is
   * independently optional and the panel prints "—" for whatever is missing.
   */

  /** Agent's inbound speech level, 0..1. */
  audio_level_in?: number;
  /** This browser's microphone level, 0..1. */
  audio_level_out?: number;
  bitrate_in_kbps?: number;
  bitrate_out_kbps?: number;
  /** Mean inbound jitter-buffer delay over the interval, ms. */
  jitter_buffer_ms?: number;
  /**
   * Share of received audio samples the decoder had to invent over the
   * interval. This is the loss the caller can actually hear, which is not the
   * same thing as `packet_loss_pct` — that one is the uplink, reported back by
   * the far end, and a packet lost on the way out is not a gap in the audio
   * this browser plays.
   */
  concealed_pct?: number;
}

export interface CallMetaPayload {
  call_id: string;
  room: string;
  started_at: number;
  pipeline: { stt: string; llm: string; tts: string };
  entry: 'browser' | 'sip';
}

export type Envelope =
  | EnvelopeBase<'turn', TurnPayload>
  | EnvelopeBase<'transcript', TranscriptPayload>
  | EnvelopeBase<'state', StatePayload>
  | EnvelopeBase<'interruption', InterruptionPayload>
  | EnvelopeBase<'usage', UsagePayload>
  | EnvelopeBase<'chaos', ChaosPayload>
  | EnvelopeBase<'call_meta', CallMetaPayload>
  | EnvelopeBase<'transport', TransportPayload>;

/**
 * The four injections the control channel can arm, in the wire's own spelling.
 *
 * Every field is optional on the wire and the agent applies only the ones
 * present — so a control message is a *patch*, never a full state. That is why
 * `max_completion_tokens` is `number | null` rather than `number | undefined`:
 * absent means "leave it alone", and `null` means "take the ceiling off". A
 * type that could not tell those apart could not turn starvation back off.
 */
export interface ChaosInjections {
  llm_delay_ms: number;
  tts_delay_ms: number;
  slow_model: boolean;
  max_completion_tokens: number | null;
}

/**
 * Drops keys whose value is `undefined`, keeping keys whose value is `null`.
 *
 * That is precisely the line the control channel draws, and TypeScript will not
 * draw it here: `exactOptionalPropertyTypes` is off, so `Partial<…>` admits an
 * explicit `undefined` and `{ max_completion_tokens: undefined }` type-checks.
 * It also has a non-zero `Object.keys().length` and then vanishes in
 * `JSON.stringify`, which would publish `payload: {}` — a message asking the
 * agent to change nothing — while the cockpit optimistically redrew the switch
 * as off. The ceiling would stay on, and every instrument would agree it was
 * off. Passing everything through here makes the emptiness check and the wire
 * agree on what a patch contains.
 */
export function definedInjections(patch: Partial<ChaosInjections>): Partial<ChaosInjections> {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined as Partial<ChaosInjections>;
}

/** Browser -> agent, published on topic `cockpit-control`. */
export interface ChaosControlMessage {
  v: number;
  type: 'chaos';
  payload: Partial<ChaosInjections>;
}

/** Body of POST /api/debrief, and of GET /api/debrief/:id. */
export interface DebriefRecord {
  call_id: string;
  meta: CallMetaPayload | null;
  ended_at: number;
  messages: Envelope[];
}

export const TELEMETRY_TOPIC = 'cockpit';
export const CONTROL_TOPIC = 'cockpit-control';

/* ── Runtime validation ────────────────────────────────────────────────────
 *
 * Envelopes reach the store from three untrusted places: a data channel, a
 * JSONL fixture, and a KV record any visitor can POST. A guard that checks only
 * `type` and `payload !== null` lets `{"type":"call_meta","payload":{}}` through
 * and the renderer dereferences fields that were never there. So each payload is
 * validated field by field here, at the single ingest point, and anything that
 * does not match the contract is dropped rather than rendered.
 */

type Guard<T> = (value: unknown) => value is T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** NaN and Infinity are rejected: they propagate silently into SVG geometry. */
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * No call stage lasts an hour, and none lasts a negative amount of time. The
 * ceiling is not pedantry: the waterfall sums these, and two values near
 * `Number.MAX_VALUE` sum to Infinity, which becomes `NaN` SVG coordinates once
 * divided by the axis scale. A negative one walks the layout cursor backwards.
 */
const MAX_STAGE_SECONDS = 3600;
const isDuration = (value: unknown): value is number =>
  isNumber(value) && value >= 0 && value <= MAX_STAGE_SECONDS;

/** Token and character counts: non-negative, and not large enough to overflow. */
const isCount = (value: unknown): value is number =>
  isNumber(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/**
 * Transport figures arrive in milliseconds, not seconds. A minute of round-trip
 * time is not a slow network, it is a broken reading — and an unbounded one
 * flattens every sparkline drawn beside it into a floor.
 */
const MAX_TRANSPORT_MS = 60_000;
const isMillis = (value: unknown): value is number =>
  isNumber(value) && value >= 0 && value <= MAX_TRANSPORT_MS;

const isPercent = (value: unknown): value is number =>
  isNumber(value) && value >= 0 && value <= 100;

/**
 * An audio level is a normalised amplitude, 0..1. A "level" of 40 is a reading
 * in some other unit, and a meter drawn from it pins to full for the rest of
 * the call.
 */
const isLevel = (value: unknown): value is number =>
  isNumber(value) && value >= 0 && value <= 1;

/**
 * A ceiling well above any audio bitrate WebRTC negotiates, but low enough that
 * a bits-per-second figure mislabelled as kbps is caught rather than plotted.
 */
const MAX_BITRATE_KBPS = 100_000;
const isBitrate = (value: unknown): value is number =>
  isNumber(value) && value >= 0 && value <= MAX_BITRATE_KBPS;

const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const optional =
  <T>(guard: Guard<T>) =>
  (value: unknown): boolean =>
    value === undefined || guard(value);

const isMember =
  <T extends string>(...allowed: T[]): Guard<T> =>
  (value: unknown): value is T =>
    typeof value === 'string' && (allowed as string[]).includes(value);

const isEouMetrics: Guard<EouMetrics> = (value): value is EouMetrics =>
  isRecord(value) &&
  isDuration(value.end_of_utterance_delay) &&
  isDuration(value.transcription_delay);

const isSttMetrics: Guard<SttMetrics> = (value): value is SttMetrics =>
  isRecord(value) &&
  isDuration(value.duration) &&
  isDuration(value.audio_duration) &&
  isString(value.model);

/**
 * Bounds the tool chain. Each link becomes a drawn mini-bar, so an unbounded
 * array is an unbounded amount of DOM that any visitor can put in a debrief.
 * No real turn calls a model sixty-four times.
 */
export const MAX_LLM_CHAIN_LINKS = 64;

const isLlmChain: Guard<LlmChainLink[]> = (value): value is LlmChainLink[] =>
  Array.isArray(value) &&
  value.length <= MAX_LLM_CHAIN_LINKS &&
  value.every((link) => isRecord(link) && isDuration(link.ttft) && isDuration(link.duration));

const isLlmMetrics: Guard<LlmMetrics> = (value): value is LlmMetrics =>
  isRecord(value) &&
  isDuration(value.ttft) &&
  isDuration(value.duration) &&
  isCount(value.prompt_tokens) &&
  isCount(value.completion_tokens) &&
  isCount(value.tokens_per_second) &&
  optional(isCount)(value.llm_calls) &&
  optional(isLlmChain)(value.chain) &&
  isString(value.model);

const isTtsMetrics: Guard<TtsMetrics> = (value): value is TtsMetrics =>
  isRecord(value) &&
  isDuration(value.ttfb) &&
  isDuration(value.duration) &&
  isDuration(value.audio_duration) &&
  isString(value.model);

const isTurnPayload = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.turn_id) &&
  optional(isEouMetrics)(value.eou) &&
  optional(isSttMetrics)(value.stt) &&
  optional(isLlmMetrics)(value.llm) &&
  optional(isTtsMetrics)(value.tts) &&
  optional(isDuration)(value.total_response_latency) &&
  optional(isBoolean)(value.degraded);

const isTranscriptRole = isMember<TranscriptRole>('user', 'agent');
const isAgentState = isMember<AgentState>('initializing', 'listening', 'thinking', 'speaking');

const isTranscriptPayload = (value: unknown): boolean =>
  isRecord(value) &&
  isTranscriptRole(value.role) &&
  isString(value.text) &&
  isBoolean(value.final) &&
  isString(value.turn_id);

const isStatePayload = (value: unknown): boolean =>
  isRecord(value) && isAgentState(value.state) && optional(isAgentState)(value.prev);

const isInterruptionPayload = (value: unknown): boolean =>
  isRecord(value) &&
  isMember<InterruptionKind>('barge_in', 'false_interruption')(value.kind) &&
  isString(value.turn_id);

const isUsagePayload = (value: unknown): boolean =>
  isRecord(value) &&
  isCount(value.llm_prompt_tokens) &&
  isCount(value.llm_completion_tokens) &&
  isCount(value.stt_audio_seconds) &&
  isCount(value.tts_characters) &&
  isCount(value.est_cost_usd);

/**
 * A completion-token ceiling. `null` is a legitimate value on the wire — it is
 * how the agent says the ceiling is off — and is therefore accepted here rather
 * than treated as a malformed number.
 */
const isTokenCeiling = (value: unknown): boolean =>
  value === undefined || value === null || isCount(value);

const isChaosPayload = (value: unknown): boolean =>
  isRecord(value) &&
  isCount(value.llm_delay_ms) &&
  isBoolean(value.active) &&
  optional(isCount)(value.tts_delay_ms) &&
  optional(isBoolean)(value.slow_model) &&
  // Not `optional(...)`: this one has three states, and `undefined` is one of
  // them. Absent = unchanged from off, null = explicitly off, a count = armed.
  isTokenCeiling(value.max_completion_tokens);

const isCallMetaPayload = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.call_id) &&
  isString(value.room) &&
  isNumber(value.started_at) &&
  isRecord(value.pipeline) &&
  isString(value.pipeline.stt) &&
  isString(value.pipeline.llm) &&
  isString(value.pipeline.tts) &&
  isMember<CallMetaPayload['entry']>('browser', 'sip')(value.entry);

const isTransportQuality = isMember<TransportQuality>(
  'excellent',
  'good',
  'poor',
  'lost',
  'unknown',
);

/**
 * The quality is mandatory and the three figures are not — but a figure that is
 * *present* still has to be a real number. `{"rtt_ms": "48ms"}` and
 * `{"packet_loss_pct": 4000}` both reach a sparkline's y-scale otherwise.
 */
const isTransportPayload = (value: unknown): boolean =>
  isRecord(value) &&
  isTransportQuality(value.quality) &&
  optional(isMillis)(value.rtt_ms) &&
  optional(isMillis)(value.jitter_ms) &&
  optional(isPercent)(value.packet_loss_pct) &&
  // v1.3. Same rule and the same reason: present means real, absent means the
  // panel prints a dash.
  optional(isLevel)(value.audio_level_in) &&
  optional(isLevel)(value.audio_level_out) &&
  optional(isBitrate)(value.bitrate_in_kbps) &&
  optional(isBitrate)(value.bitrate_out_kbps) &&
  optional(isMillis)(value.jitter_buffer_ms) &&
  optional(isPercent)(value.concealed_pct);

/** A Map, not an object literal: `payload_guards["toString"]` is a live method. */
const PAYLOAD_GUARDS = new Map<string, (payload: unknown) => boolean>([
  ['turn', isTurnPayload],
  ['transcript', isTranscriptPayload],
  ['state', isStatePayload],
  ['interruption', isInterruptionPayload],
  ['usage', isUsagePayload],
  ['chaos', isChaosPayload],
  ['call_meta', isCallMetaPayload],
  ['transport', isTransportPayload],
]);

/**
 * The only door into the store. Rejects unknown types — a future agent may emit
 * types this build has never heard of — and any payload that does not match the
 * v1 contract field for field.
 */
export function isEnvelope(value: unknown): value is Envelope {
  if (!isRecord(value)) return false;
  if (value.v !== SCHEMA_VERSION) return false;
  if (!isNumber(value.ts)) return false;
  if (!optional(isString)(value.speech_id)) return false;
  if (typeof value.type !== 'string') return false;

  const guard = PAYLOAD_GUARDS.get(value.type);
  return guard !== undefined && guard(value.payload);
}

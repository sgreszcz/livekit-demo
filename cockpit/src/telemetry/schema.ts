/**
 * Wire types for the Glass Cockpit telemetry contract.
 * Mirrors docs/TELEMETRY-SCHEMA.md v1 — do not change unilaterally.
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

export interface ChaosPayload {
  llm_delay_ms: number;
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

/** Browser -> agent, published on topic `cockpit-control`. */
export interface ChaosControlMessage {
  v: number;
  type: 'chaos';
  payload: { llm_delay_ms: number };
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

const isChaosPayload = (value: unknown): boolean =>
  isRecord(value) && isCount(value.llm_delay_ms) && isBoolean(value.active);

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
  optional(isPercent)(value.packet_loss_pct);

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

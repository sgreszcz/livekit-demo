/**
 * The single source of truth for cockpit state.
 *
 * Live calls, fixture replays and stored debriefs all produce the same thing:
 * an ordered stream of telemetry envelopes. This module folds that stream into
 * renderable state, so every mode of the app exercises identical logic and the
 * unit tests cover all three at once.
 *
 * Reducers here are pure and return new top-level objects; only the slices a
 * given envelope touches are copied, so React's identity checks stay cheap.
 */

import type {
  AgentState,
  CallMetaPayload,
  Envelope,
  EouMetrics,
  InterruptionKind,
  LlmMetrics,
  SttMetrics,
  TranscriptRole,
  TtsMetrics,
  TurnPayload,
  UsagePayload,
} from './schema';
import { isEnvelope } from './schema';

export interface Turn {
  turnId: string;
  /** Arrival order, 0-based; the wire carries no turn ordinal. */
  index: number;
  eou?: EouMetrics;
  stt?: SttMetrics;
  llm?: LlmMetrics;
  tts?: TtsMetrics;
  totalResponseLatency?: number;
  degraded: boolean;
  interruptions: InterruptionKind[];
  /** Agent-clock seconds of the first and most recent envelope for this turn. */
  firstTs: number;
  lastTs: number;
}

export interface TranscriptLine {
  turnId: string;
  role: TranscriptRole;
  text: string;
  final: boolean;
  ts: number;
}

export interface StateSample {
  state: AgentState;
  ts: number;
}

export interface ChaosState {
  llmDelayMs: number;
  active: boolean;
}

/**
 * The envelope log, bounded and appended in place.
 *
 * A call runs for minutes at tens of envelopes a second, so `[...log, envelope]`
 * on every message copies the whole array every time — quadratic, and unbounded.
 * `entries` is therefore mutated and a fresh wrapper minted per append:
 * consumers compare the wrapper (or `version`), never the array identity.
 */
export interface EnvelopeLog {
  readonly entries: readonly Envelope[];
  /**
   * Bumped every time an envelope is offered. It exists to give memoised
   * consumers a stable scalar to depend on, since `entries` keeps its identity
   * across appends; it is deliberately not an eviction count.
   */
  readonly version: number;
}

/**
 * Bounds the tab's memory over a long call — and matches the Worker's own
 * `MAX_MESSAGES`, so a log the cockpit was willing to keep is never a log the
 * share endpoint refuses on count.
 */
export const MAX_LOG_ENVELOPES = 4000;

export function emptyLog(): EnvelopeLog {
  return { entries: [], version: 0 };
}

/**
 * Appends within the bound, evicting the oldest envelopes but keeping the
 * opening `call_meta` — without it a truncated debrief has no pipeline, no room
 * and no start time, and renders as an anonymous stub.
 *
 * Appending the same envelope object twice is a no-op. This runs inside a React
 * reducer, and React deliberately invokes reducers twice per action under
 * StrictMode to smoke out impure ones; since this append mutates by design, it
 * has to be idempotent instead, or every envelope would be logged twice in
 * development.
 */
export function appendToLog(log: EnvelopeLog, envelope: Envelope): EnvelopeLog {
  const entries = log.entries as Envelope[];

  if (entries[entries.length - 1] !== envelope) {
    entries.push(envelope);
    if (entries.length > MAX_LOG_ENVELOPES) {
      const head = entries[0].type === 'call_meta' ? 1 : 0;
      entries.splice(head, entries.length - MAX_LOG_ENVELOPES);
    }
  }

  return { entries, version: log.version + 1 };
}

export interface CockpitState {
  meta: CallMetaPayload | null;
  turns: Turn[];
  transcript: TranscriptLine[];
  states: StateSample[];
  usage: UsagePayload | null;
  chaos: ChaosState;
  /** Every envelope in arrival order — this is what gets POSTed as a debrief. */
  log: EnvelopeLog;
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * A factory, not a shared constant: the log appends in place, so every reset and
 * every replay needs its own.
 */
export function createCockpitState(): CockpitState {
  return {
    meta: null,
    turns: [],
    transcript: [],
    states: [],
    usage: null,
    chaos: { llmDelayMs: 0, active: false },
    log: emptyLog(),
    firstTs: null,
    lastTs: null,
  };
}

/** Conversational-latency target used as the waterfall's reference line. */
export const LATENCY_BUDGET_SECONDS = 1.0;

/** Stages the caller actually waits through, in pipeline order. */
export type CriticalStage = 'eou' | 'ttft' | 'ttfb';
/** Streaming that overlaps the agent's own audio — never part of the wait. */
export type OverlayStage = 'generation' | 'tts';

export interface WaterfallSpan<K extends string> {
  key: K;
  label: string;
  /** Seconds from the end of the caller's utterance. */
  start: number;
  seconds: number;
}

export interface TurnWaterfall {
  /** The solid bar: end of utterance → first token → first audio. */
  critical: WaterfallSpan<CriticalStage>[];
  /** Width of the solid bar. Equals `total_response_latency` by construction. */
  criticalSeconds: number;
  /** De-emphasised lanes running past first audio. */
  overlays: WaterfallSpan<OverlayStage>[];
  /** Offset of the final transcript inside the EOU window, or null. */
  transcriptionTick: number | null;
  /** Rightmost edge of anything drawn, for the shared axis. */
  spanSeconds: number;
  /** No EOU: the agent started this turn itself, so there is no wait to measure. */
  agentInitiated: boolean;
}

/**
 * The names a LiveKit engineer already uses for these stages. The legend is the
 * only glossary the chart gets, so it spends it on domain terms rather than on
 * prose restating them.
 */
export const STAGE_LABELS: Record<CriticalStage | OverlayStage | 'transcription', string> = {
  eou: 'EOU detection delay',
  ttft: 'LLM TTFT',
  ttfb: 'TTS TTFB',
  generation: 'LLM generation (overlapped)',
  tts: 'Audio playout (overlapped)',
  transcription: 'Final transcript ready',
};

/**
 * Lays a turn out on a real time axis, anchored at the end of the caller's
 * utterance.
 *
 * The pipeline overlaps, so a bar that concatenates every metric is a lie: it
 * makes a 940 ms turn look like 1.82 s and bust a budget it never bust. Only
 * `eou → ttft → ttfb` is time the caller waits, and that sum IS
 * `total_response_latency`. Generation tail and TTS streaming run *underneath*
 * audio the caller is already hearing, and `transcription_delay` runs inside the
 * EOU window — all three are overlays, never additive.
 */
export function turnWaterfall(turn: Turn): TurnWaterfall {
  const eouSeconds = turn.eou?.end_of_utterance_delay ?? 0;
  const ttft = turn.llm?.ttft ?? 0;
  const ttfb = turn.tts?.ttfb ?? 0;

  const critical: WaterfallSpan<CriticalStage>[] = [];
  let cursor = 0;
  const push = (key: CriticalStage, seconds: number) => {
    if (seconds > 0) critical.push({ key, label: STAGE_LABELS[key], start: cursor, seconds });
    cursor += seconds;
  };

  push('eou', eouSeconds);
  push('ttft', ttft);
  // `llm.duration` is measured from the request, so the tail that outlives the
  // first token starts here — at the token, not where the LLM was called.
  const firstTokenAt = cursor;
  push('ttfb', ttfb);
  const criticalSeconds = cursor;

  const overlays: WaterfallSpan<OverlayStage>[] = [];
  const generationTail = turn.llm ? Math.max(0, turn.llm.duration - turn.llm.ttft) : 0;
  if (generationTail > 0) {
    overlays.push({
      key: 'generation',
      label: STAGE_LABELS.generation,
      start: firstTokenAt,
      seconds: generationTail,
    });
  }
  const ttsTail = turn.tts ? Math.max(0, turn.tts.duration - turn.tts.ttfb) : 0;
  if (ttsTail > 0) {
    overlays.push({
      key: 'tts',
      label: STAGE_LABELS.tts,
      start: criticalSeconds,
      seconds: ttsTail,
    });
  }

  const spanSeconds = overlays.reduce(
    (max, overlay) => Math.max(max, overlay.start + overlay.seconds),
    criticalSeconds,
  );

  const transcriptionDelay = turn.eou?.transcription_delay ?? 0;

  return {
    critical,
    criticalSeconds,
    overlays,
    transcriptionTick: transcriptionDelay > 0 ? transcriptionDelay : null,
    spanSeconds,
    agentInitiated: turn.eou === undefined,
  };
}

function replaceTurn(turns: Turn[], index: number, next: Turn): Turn[] {
  const copy = turns.slice();
  copy[index] = next;
  return copy;
}

function mergeTurn(state: CockpitState, ts: number, payload: TurnPayload): CockpitState {
  const index = state.turns.findIndex((turn) => turn.turnId === payload.turn_id);
  const existing =
    index >= 0
      ? state.turns[index]
      : {
          turnId: payload.turn_id,
          index: state.turns.length,
          degraded: false,
          interruptions: [],
          firstTs: ts,
          lastTs: ts,
        };

  // Last-write-wins per field; absent fields on a partial envelope must not
  // clobber stage metrics that already arrived.
  const merged: Turn = {
    ...existing,
    ...(payload.eou ? { eou: payload.eou } : null),
    ...(payload.stt ? { stt: payload.stt } : null),
    ...(payload.llm ? { llm: payload.llm } : null),
    ...(payload.tts ? { tts: payload.tts } : null),
    ...(payload.total_response_latency !== undefined
      ? { totalResponseLatency: payload.total_response_latency }
      : null),
    ...(payload.degraded !== undefined ? { degraded: payload.degraded } : null),
    lastTs: Math.max(existing.lastTs, ts),
  };

  return {
    ...state,
    turns: index >= 0 ? replaceTurn(state.turns, index, merged) : [...state.turns, merged],
  };
}

/**
 * An interruption may arrive before any `turn` envelope for its id (the agent
 * detects a barge-in the moment it happens), so this creates the turn if needed.
 */
function addInterruption(
  state: CockpitState,
  ts: number,
  turnId: string,
  kind: InterruptionKind,
): CockpitState {
  const withTurn = state.turns.some((turn) => turn.turnId === turnId)
    ? state
    : mergeTurn(state, ts, { turn_id: turnId });
  const index = withTurn.turns.findIndex((turn) => turn.turnId === turnId);
  const turn = withTurn.turns[index];

  return {
    ...withTurn,
    turns: replaceTurn(withTurn.turns, index, {
      ...turn,
      interruptions: [...turn.interruptions, kind],
      lastTs: Math.max(turn.lastTs, ts),
    }),
  };
}

/**
 * Interim transcripts repeat and must update in place; a line is identified by
 * turn id + role.
 *
 * Once a line is final it is frozen against interim updates: STT can deliver an
 * in-flight partial *after* the final for the same utterance, and letting it
 * land would replace settled text with a truncated guess mid-render.
 */
function upsertTranscript(
  state: CockpitState,
  ts: number,
  line: Omit<TranscriptLine, 'ts'>,
): CockpitState {
  const index = state.transcript.findIndex(
    (existing) => existing.turnId === line.turnId && existing.role === line.role,
  );

  if (index < 0) return { ...state, transcript: [...state.transcript, { ...line, ts }] };
  if (state.transcript[index].final && !line.final) return state;

  const transcript = state.transcript.slice();
  transcript[index] = { ...line, ts };
  return { ...state, transcript };
}

/** Folds one envelope into cockpit state. Pure; safe to replay from scratch. */
export function reduceEnvelope(state: CockpitState, envelope: Envelope): CockpitState {
  const { ts } = envelope;
  const base: CockpitState = {
    ...state,
    log: appendToLog(state.log, envelope),
    firstTs: state.firstTs === null ? ts : Math.min(state.firstTs, ts),
    lastTs: state.lastTs === null ? ts : Math.max(state.lastTs, ts),
  };

  switch (envelope.type) {
    case 'call_meta':
      return { ...base, meta: envelope.payload };

    case 'turn':
      return mergeTurn(base, ts, envelope.payload);

    case 'transcript': {
      const { role, text, final, turn_id } = envelope.payload;
      return upsertTranscript(base, ts, { turnId: turn_id, role, text, final });
    }

    case 'state':
      return { ...base, states: [...base.states, { state: envelope.payload.state, ts }] };

    case 'interruption':
      return addInterruption(base, ts, envelope.payload.turn_id, envelope.payload.kind);

    case 'usage':
      return { ...base, usage: envelope.payload };

    case 'chaos':
      return {
        ...base,
        chaos: { llmDelayMs: envelope.payload.llm_delay_ms, active: envelope.payload.active },
      };
  }
}

/** Convenience for replaying a whole recorded call (fixture or debrief). */
export function reduceAll(envelopes: readonly Envelope[], from = createCockpitState()): CockpitState {
  return envelopes.reduce(reduceEnvelope, from);
}

/** Parses a JSONL telemetry recording, skipping blank and malformed lines. */
export function parseEnvelopeLines(source: string): Envelope[] {
  const envelopes: Envelope[] = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isEnvelope(parsed)) envelopes.push(parsed);
    } catch {
      // A truncated recording should still render everything before the tear.
    }
  }
  return envelopes;
}

/** Wall-clock length of the call, in seconds, from first to last envelope. */
export function callDurationSeconds(state: CockpitState): number {
  if (state.firstTs === null || state.lastTs === null) return 0;
  return state.lastTs - state.firstTs;
}

/** The most recent agent state, for the live status indicator. */
export function currentAgentState(state: CockpitState): AgentState | null {
  return state.states.length > 0 ? state.states[state.states.length - 1].state : null;
}

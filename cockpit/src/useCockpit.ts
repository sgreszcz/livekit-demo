/**
 * Binds a telemetry source (live room or fixture replay) to the cockpit store
 * and exposes the controls the UI needs. The store is mode-agnostic: switching
 * between a real call and a replay changes only where envelopes come from.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CockpitSession } from './livekit/session';
import { replayFixture, type ReplayHandle } from './telemetry/fixtureSource';
import { definedInjections } from './telemetry/schema';
import type { ChaosInjections, DebriefRecord, Envelope } from './telemetry/schema';
import {
  appendToLog,
  createCockpitState,
  emptyLog,
  reduceEnvelope,
  type CockpitState,
  type EnvelopeLog,
} from './telemetry/store';

/**
 * The base every request is merged onto — and, notably, NOT the initial value.
 *
 * `chaosRequest` is null until this browser touches a switch, because "I have
 * asked for nothing" and "I have asked for everything off" are different claims
 * and the panel renders them differently: a session that has asked for nothing
 * shows the agent's state instead of its own. That distinction used to be
 * carried by `disabled`, which was a fair proxy while the only session that had
 * asked for nothing was a read-only one. An observer that can arm chaos is a
 * live panel that has still asked for nothing, so the proxy had to go.
 */
export const CHAOS_REQUEST_OFF: ChaosInjections = {
  llm_delay_ms: 0,
  tts_delay_ms: 0,
  slow_model: false,
  max_completion_tokens: null,
};

export type CockpitMode =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'replay'
  /** Watching someone else's call: no microphone, but the chaos switches work. */
  | 'observing'
  | 'ended'
  | 'error';

export interface ShareResult {
  id: string;
  url: string;
}

export interface Cockpit {
  state: CockpitState;
  mode: CockpitMode;
  error: string | null;
  /**
   * What this browser has requested, or null if it has not asked for anything
   * yet; the agent's ack lives on `state.chaos`.
   */
  chaosRequest: ChaosInjections | null;
  micEnabled: boolean;
  /**
   * Observer sessions only: whether the watched call is audible here.
   *
   * False on every fresh source, because the common case turned out to be a
   * visitor watching their OWN call on the laptop beside the phone — laptop
   * speakers into the phone's microphone is an echo the agent hears too. A
   * caller is audible by construction and this flag says nothing about them.
   */
  listening: boolean;
  share: ShareResult | null;
  sharing: boolean;
  startCall: () => Promise<void>;
  startReplay: () => void;
  startObserving: (room: string) => Promise<void>;
  stopObserving: () => void;
  endCall: () => Promise<void>;
  reset: () => void;
  setChaos: (patch: Partial<ChaosInjections>) => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleListening: () => Promise<void>;
  shareCall: () => Promise<void>;
}

type StoreAction = { kind: 'envelope'; envelope: Envelope } | { kind: 'reset' };

function storeReducer(state: CockpitState, action: StoreAction): CockpitState {
  return action.kind === 'reset' ? createCockpitState() : reduceEnvelope(state, action.envelope);
}

export function useCockpit(): Cockpit {
  const [state, dispatch] = useReducer(storeReducer, undefined, createCockpitState);
  const [mode, setMode] = useState<CockpitMode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [chaosRequest, setChaosRequest] = useState<ChaosInjections | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [listening, setListening] = useState(false);
  const [share, setShare] = useState<ShareResult | null>(null);
  const [sharing, setSharing] = useState(false);

  const sessionRef = useRef<CockpitSession | null>(null);
  const replayRef = useRef<ReplayHandle | null>(null);
  // The reducer's state is not readable from a callback closure, so the envelope
  // log is mirrored here for the debrief POST — under the same bound, so a long
  // call cannot grow it without limit.
  const logRef = useRef<EnvelopeLog>(emptyLog());
  /**
   * Bumped whenever the current source is torn down. A session's callbacks
   * capture the generation they were created under and no-op once it moves on,
   * so a late envelope or a disconnect from the previous call can never land in
   * the next one.
   */
  const generationRef = useRef(0);
  /**
   * A connect in flight owns a room that `sessionRef` cannot see yet — and if
   * the visitor never answers the microphone prompt it owns it indefinitely.
   * This is how a teardown reaches inside that promise.
   */
  const connectRef = useRef<AbortController | null>(null);

  const clearSources = useCallback(() => {
    generationRef.current += 1;
    connectRef.current?.abort();
    connectRef.current = null;
    replayRef.current?.cancel();
    replayRef.current = null;
    void sessionRef.current?.disconnect().catch(() => {});
    sessionRef.current = null;
  }, []);

  /** Fresh source, fresh state, fresh generation — returns the new generation. */
  const beginSource = useCallback(() => {
    clearSources();
    logRef.current = emptyLog();
    dispatch({ kind: 'reset' });
    setShare(null);
    setError(null);
    // Every new source starts silent-if-observing, and the flag has to be reset
    // here rather than only in `reset()`: watching a second call in a row goes
    // straight from one observer session to the next, and a Listen button left
    // reading "on" would describe a session that attached its tracks muted.
    setListening(false);
    return generationRef.current;
  }, [clearSources]);

  const callbacksFor = useCallback(
    (generation: number) => ({
      onEnvelope: (envelope: Envelope) => {
        if (generationRef.current !== generation) return;
        logRef.current = appendToLog(logRef.current, envelope);
        dispatch({ kind: 'envelope', envelope });
      },
      onDisconnected: () => {
        if (generationRef.current !== generation) return;
        setMode('ended');
      },
    }),
    [],
  );

  useEffect(() => clearSources, [clearSources]);

  const reset = useCallback(() => {
    beginSource();
    setMode('idle');
    // Back to "asked for nothing", not to "asked for off": the next source
    // starts with a panel that reports the agent rather than this browser.
    setChaosRequest(null);
    setMicEnabled(true);
  }, [beginSource]);

  const startReplay = useCallback(() => {
    const generation = beginSource();
    const { onEnvelope, onDisconnected } = callbacksFor(generation);
    setMode('replay');
    replayRef.current = replayFixture(onEnvelope, onDisconnected);
  }, [beginSource, callbacksFor]);

  const startCall = useCallback(async () => {
    const generation = beginSource();
    const controller = new AbortController();
    connectRef.current = controller;
    setMode('connecting');

    try {
      // livekit-client is the bulk of the bundle and is dead weight for anyone
      // watching a replay or a shared debrief, so it loads on demand.
      const { CockpitSession } = await import('./livekit/session');
      const session = await CockpitSession.connect(callbacksFor(generation), controller.signal);

      // The visitor may have reset or started something else while the room was
      // connecting; that call is no longer wanted, and it owns a live mic.
      if (generationRef.current !== generation) {
        await session.disconnect().catch(() => {});
        return;
      }

      connectRef.current = null;
      sessionRef.current = session;
      setMicEnabled(true);
      setMode('live');
    } catch (cause) {
      // A superseded or cancelled attempt has already been torn down, and the
      // visitor asked for it — there is nothing to report.
      if (generationRef.current !== generation) return;
      setError(cause instanceof Error ? cause.message : 'Could not start the call');
      setMode('error');
    }
  }, [beginSource, callbacksFor]);

  /**
   * Joins a call already in progress: no microphone, but the chaos switches on
   * this session are live.
   *
   * Deliberately the same `beginSource()` / generation / AbortController
   * machinery as `startCall`, because the isolation it buys is exactly what an
   * observer needs: a caller session and an observer session are two rooms with
   * two telemetry streams, and an envelope or a disconnect from the one the
   * visitor just left must never land in the one they just joined. Watching two
   * different rooms in a row is the same problem, and the generation counter is
   * the same answer.
   */
  const startObserving = useCallback(
    async (room: string) => {
      const generation = beginSource();
      const controller = new AbortController();
      connectRef.current = controller;
      setMode('connecting');

      try {
        // Loaded on demand for the same reason as `startCall`: livekit-client is
        // the bulk of the bundle, and most visitors never join a room at all.
        const { CockpitSession } = await import('./livekit/session');
        const session = await CockpitSession.observe(
          room,
          callbacksFor(generation),
          controller.signal,
        );

        if (generationRef.current !== generation) {
          await session.disconnect().catch(() => {});
          return;
        }

        connectRef.current = null;
        sessionRef.current = session;
        setMode('observing');
      } catch (cause) {
        if (generationRef.current !== generation) return;
        setError(cause instanceof Error ? cause.message : 'Could not watch that call');
        setMode('error');
      }
    },
    [beginSource, callbacksFor],
  );

  /**
   * Leaving is not ending: the call carries on without this browser, so there is
   * no debrief to offer and nothing to share — straight back to `idle`.
   *
   * What `idle` then looks like is the view's business, not this hook's. On the
   * cockpit it is the hero; on `/live` it is the holding screen, which goes on
   * waiting for the next call. That is the whole reason this resets the source
   * rather than navigating anywhere itself.
   */
  const stopObserving = useCallback(() => {
    reset();
  }, [reset]);

  const endCall = useCallback(async () => {
    // Ending is a teardown like any other: retire the generation so the room's
    // own disconnect event cannot re-enter with stale state, and abort a connect
    // that has not handed back a session yet.
    generationRef.current += 1;
    connectRef.current?.abort();
    connectRef.current = null;
    replayRef.current?.cancel();
    replayRef.current = null;
    await sessionRef.current?.disconnect().catch(() => {});
    sessionRef.current = null;
    setMode('ended');
  }, []);

  /**
   * Unguarded, deliberately: an observer session may arm chaos, and this is the
   * flow the demo is built around — the owner calls from a phone and drives the
   * instruments from the laptop, where the session is an observer.
   *
   * The guard that used to sit here refused the publish AND froze the local
   * state, which is why removing it is a two-line change rather than one: a
   * switch that moved without publishing would be an instrument reading
   * something that never happened, and a publish without the switch moving
   * would be a control that feels dead. Neither now applies — both happen.
   *
   * `toggleMic` keeps its guard. That asymmetry is the entire feature.
   */
  const setChaos = useCallback(async (patch: Partial<ChaosInjections>) => {
    const session = sessionRef.current;
    // Optimistic locally, patch on the wire: the control reads back immediately
    // and the agent is told only what changed. The two are reconciled on screen
    // by the ack, which is the only thing that claims an injection is live.
    //
    // Filtered through the same function the wire uses, so the switch cannot
    // read back a change the published message did not carry — an `undefined`
    // would otherwise overwrite local state and vanish from the JSON.
    const defined = definedInjections(patch);
    // The first press is what turns "asked for nothing" into a request, and it
    // has to land on a full off-state rather than on a partial patch — the
    // panel reads all four banks out of this object.
    setChaosRequest((current) => ({ ...(current ?? CHAOS_REQUEST_OFF), ...defined }));
    await session?.setChaos(defined).catch(() => {});
  }, []);

  /**
   * Still refused on an observer session, and this is the one that matters: the
   * token carries `canPublish: false`, so a mic button that claimed to have
   * muted a microphone that does not exist would be an instrument reading a
   * state the session cannot be in.
   */
  const toggleMic = useCallback(async () => {
    const session = sessionRef.current;
    if (session?.observing) return;
    const next = !micEnabled;
    setMicEnabled(next);
    await session?.setMicrophoneEnabled(next).catch(() => {});
  }, [micEnabled]);

  /**
   * The mirror image of the guard on `toggleMic`: that one refuses on an
   * observer session, this one refuses on everything else. A caller's audio
   * is the call itself and has no business being muted from here — and a replay,
   * a debrief and an idle hero have no audio elements at all, so a switch that
   * moved would be an instrument reading a state that does not exist.
   */
  const toggleListening = useCallback(async () => {
    const session = sessionRef.current;
    if (!session?.observing) return;
    const next = !listening;
    setListening(next);
    await session.setAudioMuted(!next).catch(() => {});
  }, [listening]);

  const shareCall = useCallback(async () => {
    // Snapshot: the live log keeps appending underneath an in-flight POST.
    const messages: Envelope[] = [...logRef.current.entries];
    if (messages.length === 0 || sharing) return;

    setSharing(true);
    try {
      const meta = messages.find((envelope) => envelope.type === 'call_meta');
      const record: DebriefRecord = {
        call_id: meta?.type === 'call_meta' ? meta.payload.call_id : `local-${Date.now()}`,
        meta: meta?.type === 'call_meta' ? meta.payload : null,
        ended_at: Date.now() / 1000,
        messages,
      };
      const response = await fetch('/api/debrief', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record),
      });
      if (response.status === 413) {
        throw new Error('This call is too long to share — the recording exceeds the 256 KB limit.');
      }
      if (!response.ok) throw new Error(`Share failed (${response.status})`);
      setShare((await response.json()) as ShareResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not share this call');
    } finally {
      setSharing(false);
    }
  }, [sharing]);

  return {
    state,
    mode,
    error,
    chaosRequest,
    micEnabled,
    listening,
    share,
    sharing,
    startCall,
    startReplay,
    startObserving,
    stopObserving,
    endCall,
    reset,
    setChaos,
    toggleMic,
    toggleListening,
    shareCall,
  };
}

/**
 * Binds a telemetry source (live room or fixture replay) to the cockpit store
 * and exposes the controls the UI needs. The store is mode-agnostic: switching
 * between a real call and a replay changes only where envelopes come from.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CockpitSession } from './livekit/session';
import { replayFixture, type ReplayHandle } from './telemetry/fixtureSource';
import type { DebriefRecord, Envelope } from './telemetry/schema';
import {
  appendToLog,
  createCockpitState,
  emptyLog,
  reduceEnvelope,
  type CockpitState,
  type EnvelopeLog,
} from './telemetry/store';

export type CockpitMode = 'idle' | 'connecting' | 'live' | 'replay' | 'ended' | 'error';

export interface ShareResult {
  id: string;
  url: string;
}

export interface Cockpit {
  state: CockpitState;
  mode: CockpitMode;
  error: string | null;
  chaosDelayMs: number;
  micEnabled: boolean;
  share: ShareResult | null;
  sharing: boolean;
  startCall: () => Promise<void>;
  startReplay: () => void;
  endCall: () => Promise<void>;
  reset: () => void;
  setChaosDelay: (ms: number) => Promise<void>;
  toggleMic: () => Promise<void>;
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
  const [chaosDelayMs, setChaosDelayMs] = useState(0);
  const [micEnabled, setMicEnabled] = useState(true);
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
    setChaosDelayMs(0);
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

  const setChaosDelay = useCallback(async (ms: number) => {
    setChaosDelayMs(ms);
    await sessionRef.current?.setChaosDelay(ms).catch(() => {});
  }, []);

  const toggleMic = useCallback(async () => {
    const next = !micEnabled;
    setMicEnabled(next);
    await sessionRef.current?.setMicrophoneEnabled(next).catch(() => {});
  }, [micEnabled]);

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
    chaosDelayMs,
    micEnabled,
    share,
    sharing,
    startCall,
    startReplay,
    endCall,
    reset,
    setChaosDelay,
    toggleMic,
    shareCall,
  };
}

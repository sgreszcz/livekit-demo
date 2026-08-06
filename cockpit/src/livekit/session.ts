/**
 * Live call transport: mints a token from the Worker, joins the room, publishes
 * the microphone, plays the agent's audio, and pipes `cockpit` data-channel
 * messages into the telemetry store.
 *
 * Everything the UI needs arrives as an `Envelope`, identical in shape to a
 * fixture replay or a stored debrief.
 */

import {
  RoomEvent,
  Room,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { CONTROL_TOPIC, SCHEMA_VERSION, TELEMETRY_TOPIC, isEnvelope } from '../telemetry/schema';
import type { ChaosControlMessage, Envelope } from '../telemetry/schema';

export interface TokenResponse {
  token: string;
  url: string;
  roomName: string;
}

export interface SessionCallbacks {
  onEnvelope: (envelope: Envelope) => void;
  onDisconnected: () => void;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function fetchToken(): Promise<TokenResponse> {
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`Token request failed (${response.status})`);
  }
  return (await response.json()) as TokenResponse;
}

export class CockpitSession {
  readonly room: Room;
  private audioElements = new Set<HTMLMediaElement>();

  private constructor(room: Room) {
    this.room = room;
  }

  /**
   * Joins the room and publishes the microphone.
   *
   * `signal` is not a nicety. Between `room.connect()` and the microphone
   * resolving, this promise owns a joined room that the caller cannot see — and
   * a caller sitting on an unanswered permission prompt never resolves at all.
   * Aborting tears that half-built session down from the inside.
   */
  static async connect(
    callbacks: SessionCallbacks,
    signal?: AbortSignal,
  ): Promise<CockpitSession> {
    signal?.throwIfAborted();

    const { token, url } = await fetchToken();
    const room = new Room({ adaptiveStream: false, dynacast: false });
    const session = new CockpitSession(room);

    room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant, _kind, topic?: string) => {
      if (topic !== TELEMETRY_TOPIC) return;
      try {
        const parsed: unknown = JSON.parse(decoder.decode(payload));
        if (isEnvelope(parsed)) callbacks.onEnvelope(parsed);
      } catch {
        // A malformed frame must never take the cockpit down mid-call.
      }
    });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication) => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.autoplay = true;
      session.audioElements.add(element);
      document.body.appendChild(element);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      for (const element of track.detach()) {
        element.remove();
        session.audioElements.delete(element);
      }
    });

    // An abort mid-connect has to reach the room this promise is holding, so it
    // tears down from here rather than waiting for a handle to be returned.
    const abort = () => void session.teardown();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      await room.connect(url, token);
      signal?.throwIfAborted();

      // A denied or unavailable microphone must not leave the room joined: the
      // browser would keep playing the agent's audio with nothing holding a
      // handle to stop it.
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (cause) {
        throw new Error(
          'The cockpit needs your microphone to place a call — allow access and try again.',
          { cause },
        );
      }
      signal?.throwIfAborted();
    } catch (cause) {
      await session.teardown();
      throw cause;
    } finally {
      signal?.removeEventListener('abort', abort);
    }

    // Registered only once the session is fully established, so the teardown
    // paths above cannot fire a disconnect callback for a call that never
    // started.
    room.on(RoomEvent.Disconnected, () => {
      session.cleanupAudio();
      callbacks.onDisconnected();
    });

    return session;
  }

  /** Tells the agent how much artificial latency to inject; 0 turns it off. */
  async setChaosDelay(llmDelayMs: number): Promise<void> {
    const message: ChaosControlMessage = {
      v: SCHEMA_VERSION,
      type: 'chaos',
      payload: { llm_delay_ms: llmDelayMs },
    };
    await this.room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), {
      reliable: true,
      topic: CONTROL_TOPIC,
    });
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
  }

  async disconnect(): Promise<void> {
    await this.room.disconnect();
  }

  /** Full teardown for a session that must not survive — safe to call twice. */
  private async teardown(): Promise<void> {
    this.room.removeAllListeners();
    this.cleanupAudio();
    await this.room.disconnect().catch(() => {});
  }

  private cleanupAudio(): void {
    for (const element of this.audioElements) element.remove();
    this.audioElements.clear();
  }
}

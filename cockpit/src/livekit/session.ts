/**
 * Live call transport: mints a token from the Worker, joins the room, publishes
 * the microphone, plays the agent's audio, and pipes `cockpit` data-channel
 * messages into the telemetry store.
 *
 * Everything the UI needs arrives as an `Envelope`, identical in shape to a
 * fixture replay or a stored debrief.
 *
 * Two ways in: `connect` places a call and publishes a microphone, `observe`
 * joins someone else's call on a read-only token and publishes nothing.
 */

import {
  RoomEvent,
  Room,
  Track,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import {
  CONTROL_TOPIC,
  SCHEMA_VERSION,
  TELEMETRY_TOPIC,
  definedInjections,
  isEnvelope,
} from '../telemetry/schema';
import type {
  ChaosControlMessage,
  ChaosInjections,
  Envelope,
  TransportPayload,
  TransportQuality,
} from '../telemetry/schema';
import {
  deriveAudioFields,
  readInboundAudio,
  readOutboundAudio,
  type AudioStatsPair,
} from './webrtcStats';

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

/* ── Transport sampling ────────────────────────────────────────────────────
 *
 * Nothing the agent sends describes the caller's own network path, so the
 * cockpit measures it here and feeds the result into the same store through the
 * same envelope shape. These envelopes are never published on the data channel;
 * they exist locally and travel only in a debrief this browser posts.
 */

const TRANSPORT_SAMPLE_MS = 2000;

const TRANSPORT_QUALITIES: readonly string[] = ['excellent', 'good', 'poor', 'lost', 'unknown'];

/**
 * The stats we want out of the SDK, described structurally rather than by
 * importing `LocalAudioTrack` and testing `instanceof`.
 *
 * This is deliberate version-tolerance: `getSenderStats` is the documented way
 * in of livekit-client 2.21, and if a later SDK renames or drops it the check
 * simply fails and the panel falls back to quality-only. An `instanceof` or a
 * reach into `room.engine` would instead throw, mid-call, on the one code path
 * whose entire job is to report that something is wrong with the connection.
 */
interface SenderStats {
  roundTripTime?: number;
  jitter?: number;
  packetsSent?: number;
  packetsLost?: number;
}

interface SenderStatsSource {
  getSenderStats(): Promise<SenderStats | undefined>;
}

/**
 * The raw report, which both `LocalTrack` and `RemoteTrack` expose in
 * livekit-client 2.21. Probed by shape for the same version-tolerance reason as
 * `getSenderStats` above: the v1.3 figures are an enrichment, and an SDK that
 * stops offering the report should cost the second row of the transport panel,
 * not the call.
 */
interface RtcStatsSource {
  getRTCStatsReport(): Promise<unknown>;
}

function hasRtcStats(track: unknown): track is RtcStatsSource {
  return typeof (track as Partial<RtcStatsSource> | null | undefined)?.getRTCStatsReport ===
    'function';
}

/** Iterates a `Map`-like without assuming it is a `Map`. */
function values<T>(source: unknown): T[] {
  const iterable = source as { forEach?: (callback: (value: T) => void) => void } | null;
  if (typeof iterable?.forEach !== 'function') return [];
  const collected: T[] = [];
  try {
    iterable.forEach((value) => collected.push(value));
  } catch {
    return [];
  }
  return collected;
}

/**
 * `startAudio` is how livekit-client asks the browser to lift an autoplay block.
 * Probed rather than called blind for the same version-tolerance reason as the
 * stats above: an SDK that drops it should cost an observer its audio, not throw
 * on the join path.
 */
interface AudioStarter {
  startAudio(): Promise<void>;
}

function hasStartAudio(room: unknown): room is AudioStarter {
  return typeof (room as Partial<AudioStarter> | null | undefined)?.startAudio === 'function';
}

function hasSenderStats(track: unknown): track is SenderStatsSource {
  return typeof (track as Partial<SenderStatsSource> | null | undefined)?.getSenderStats ===
    'function';
}

function readQuality(participant: Participant): TransportQuality {
  // Read structurally for the same reason as the stats above.
  const value: unknown = (participant as { connectionQuality?: unknown }).connectionQuality;
  return typeof value === 'string' && TRANSPORT_QUALITIES.includes(value)
    ? (value as TransportQuality)
    : 'unknown';
}

/**
 * Estimates the offset between this browser's clock and the agent's.
 *
 * Every other envelope in the store is stamped on the agent clock, and the
 * cockpit derives elapsed time and the whole state strip from the minimum and
 * maximum `ts` it has seen. A browser whose clock is five minutes fast would,
 * by contributing transport samples stamped in its own time, stretch the call
 * to five minutes and squash every state segment into the left edge — a
 * cosmetic-looking bug with an entirely non-cosmetic cause.
 *
 * The estimator is the usual one: keep the smallest observed
 * `browser_now − agent_ts`, since the least-delayed message is the one whose
 * transit time contaminates the offset least.
 */
class AgentClock {
  private offset: number | null = null;

  observe(agentTs: number): void {
    const candidate = Date.now() / 1000 - agentTs;
    if (!Number.isFinite(candidate)) return;
    if (this.offset === null || candidate < this.offset) this.offset = candidate;
  }

  /** False until the agent has spoken once — see `sampleTransport`. */
  get aligned(): boolean {
    return this.offset !== null;
  }

  now(): number {
    return Date.now() / 1000 - (this.offset ?? 0);
  }
}

/**
 * `body` is what tells the Worker which kind of token to mint: `{}` for a caller
 * who publishes a microphone, `{ observe: roomName }` for a read-only observer.
 * One request function rather than two, so a change to error handling cannot
 * apply to only one of them.
 */
async function fetchToken(body: Record<string, unknown> = {}): Promise<TokenResponse> {
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Token request failed (${response.status})`);
  }
  return (await response.json()) as TokenResponse;
}

export class CockpitSession {
  readonly room: Room;
  /**
   * True for a session joined on an observer token. The token itself forbids
   * publishing, so this is not the security boundary — it is what lets the
   * cockpit fail loudly on its own side of the wire instead of firing a publish
   * the server will refuse.
   */
  readonly observing: boolean;
  private audioElements = new Set<HTMLMediaElement>();
  /**
   * Whether the elements this session attaches are silent.
   *
   * An observer starts muted, and the reason is acoustic rather than tidy: the
   * call being watched is very often the watcher's own, on the phone next to the
   * laptop. Laptop speakers into a phone microphone is an echo loop the agent
   * hears too, so it degrades the very call the instruments are measuring.
   *
   * Muting the ELEMENT rather than skipping the attach, or unsubscribing, is
   * what makes unmuting instant: the track stays subscribed and flowing, so
   * `setAudioMuted(false)` is a property write rather than a renegotiation. It
   * also keeps telemetry entirely out of it — envelopes arrive on the data
   * channel, which no audio element has ever had an opinion about.
   */
  private audioMuted: boolean;

  private readonly clock = new AgentClock();
  private emit: (envelope: Envelope) => void = () => {};
  private transportTimer: ReturnType<typeof setInterval> | null = null;
  /** getStats is async; a slow report must not have two samples racing it. */
  private samplingTransport = false;
  /** Packet counters are cumulative, so loss is a delta against the last read. */
  private lastPackets: { sent: number; lost: number } | null = null;
  /**
   * The previous raw-stats reading, for the same reason: bitrate, jitter buffer
   * and concealment are all rates or ratios over an interval. Null until the
   * first sample lands, which is why those four figures appear one interval
   * after the level meters do.
   */
  private lastAudioStats: AudioStatsPair | null = null;

  private constructor(room: Room, observing: boolean) {
    this.room = room;
    this.observing = observing;
    // A caller is audible from the first frame — they are on the call, and a
    // phone call that starts silent is a broken phone call. Only the bystander
    // starts muted.
    this.audioMuted = observing;
  }

  /**
   * The wiring both a caller and an observer need: telemetry in, remote audio
   * out. Shared rather than copied so the two paths cannot drift — an observer
   * that missed a schema change here would show a call with no instruments and
   * no obvious reason why.
   *
   * The audio handler attaches EVERY remote audio track, which for an observer
   * means both the agent and the caller: an observer subscribes to everyone in
   * the room, so watching a call is also listening to it.
   */
  private attachRoomHandlers(callbacks: SessionCallbacks): void {
    const { room } = this;

    room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant, _kind, topic?: string) => {
      if (topic !== TELEMETRY_TOPIC) return;
      try {
        const parsed: unknown = JSON.parse(decoder.decode(payload));
        if (!isEnvelope(parsed)) return;
        // Every agent envelope is also a clock reading; see `AgentClock`.
        this.clock.observe(parsed.ts);
        callbacks.onEnvelope(parsed);
      } catch {
        // A malformed frame must never take the cockpit down mid-call.
      }
    });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication) => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.autoplay = true;
      // Set before the element reaches the document, so there is no window —
      // not even one frame — in which an observer's laptop can make a sound.
      // A track that arrives after the visitor pressed Listen inherits the
      // session's current state rather than reverting to silence.
      element.muted = this.audioMuted;
      this.audioElements.add(element);
      document.body.appendChild(element);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      for (const element of track.detach()) {
        element.remove();
        this.audioElements.delete(element);
      }
    });
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
    /*
     * Re-checked after the token round trip, and this is not belt-and-braces.
     * The abort listener below cannot be registered until there is a session to
     * tear down, and `addEventListener('abort', …)` on an ALREADY-aborted signal
     * never fires. Without this line, a visitor who cancels while the token is
     * in flight still gets a room joined on their behalf a moment later.
     */
    signal?.throwIfAborted();

    const room = new Room({ adaptiveStream: false, dynacast: false });
    const session = new CockpitSession(room, false);
    session.emit = callbacks.onEnvelope;
    session.attachRoomHandlers(callbacks);

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
      session.stopTransport();
      session.cleanupAudio();
      callbacks.onDisconnected();
    });

    // A quality change is the one transport event worth reacting to faster than
    // the sampling interval — it is what the lamp shows, and two seconds of a
    // green lamp on a dead connection is two seconds of lying.
    room.on(RoomEvent.ConnectionQualityChanged, (_quality, participant: Participant) => {
      if (participant !== room.localParticipant) return;
      void session.sampleTransport();
    });

    session.startTransport();
    return session;
  }

  /**
   * Joins a call someone else is on, read-only.
   *
   * The token minted for `{ observe: room }` carries `canPublish: false`, so
   * this session has no microphone and never asks for one — there is no
   * permission prompt anywhere on this path, which is the whole reason a
   * bystander can watch a phone call without being asked for anything.
   *
   * The agent replays its telemetry history to a joining `observer-` identity
   * before resuming live sends, so the store needs no special case: history
   * arrives as ordinary envelopes through the handler above.
   */
  static async observe(
    roomName: string,
    callbacks: SessionCallbacks,
    signal?: AbortSignal,
  ): Promise<CockpitSession> {
    signal?.throwIfAborted();

    const { token, url } = await fetchToken({ observe: roomName });
    // Same window as `connect` — see the note there. Cancelling while the token
    // is in flight must not leave a room joined to someone else's call.
    signal?.throwIfAborted();

    const room = new Room({ adaptiveStream: false, dynacast: false });
    const session = new CockpitSession(room, true);
    session.emit = callbacks.onEnvelope;
    session.attachRoomHandlers(callbacks);

    // Same reasoning as `connect`: between here and a joined room, this promise
    // owns something the caller cannot see or stop.
    const abort = () => void session.teardown();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      await room.connect(url, token);
      signal?.throwIfAborted();
    } catch (cause) {
      await session.teardown();
      throw cause;
    } finally {
      signal?.removeEventListener('abort', abort);
    }

    room.on(RoomEvent.Disconnected, () => {
      session.cleanupAudio();
      callbacks.onDisconnected();
    });

    /*
     * Ask the browser to let this call make noise — before it has any reason to.
     *
     * An observer's tracks are attached muted, so nothing here is trying to play
     * anything yet. What this buys is the unlock itself: a caller gets one free,
     * because granting a microphone unlocks playback as a side effect, while an
     * observer grants nothing and lands squarely in autoplay policy. Spending
     * the activation from the click that started the join — the freshest one
     * this page will ever have — means the later press of Listen is a property
     * write on an already-unlocked context rather than a second negotiation with
     * the browser. `setAudioMuted` asks again on unmute regardless, since that
     * press is itself a user gesture and browsers differ on which one counts.
     *
     * Attempted, never awaited, and probed structurally rather than assumed: a
     * browser that refuses leaves a working instrument panel and a silent call,
     * which is a degraded observer rather than a broken one. Strict mobile
     * Safari is the case most likely to refuse, and it is the case least
     * testable from here — see the note in the session tests.
     */
    if (hasStartAudio(room)) void room.startAudio().catch(() => {});

    // No transport sampling, and no ConnectionQualityChanged handler either.
    // Those samples describe the CALLER's uplink, measured from the microphone
    // the caller publishes; an observer publishes nothing, so the only thing it
    // could measure is its own connection to LiveKit — a different network path
    // entirely. Printing that under "Transport" would be a lie told in the
    // caller's voice.

    return session;
  }

  /* ── Transport ─────────────────────────────────────────────────────────── */

  private startTransport(): void {
    if (this.transportTimer !== null) return;
    this.transportTimer = setInterval(() => void this.sampleTransport(), TRANSPORT_SAMPLE_MS);
  }

  /** Idempotent: every teardown path calls it, and some call it twice. */
  private stopTransport(): void {
    if (this.transportTimer === null) return;
    clearInterval(this.transportTimer);
    this.transportTimer = null;
  }

  private senderStatsSource(): SenderStatsSource | null {
    for (const publication of this.room.localParticipant.audioTrackPublications.values()) {
      if (hasSenderStats(publication.track)) return publication.track;
    }
    return null;
  }

  /** The microphone this browser is publishing, if it can report raw stats. */
  private localRtcStatsSource(): RtcStatsSource | null {
    for (const publication of this.room.localParticipant.audioTrackPublications.values()) {
      if (hasRtcStats(publication.track)) return publication.track;
    }
    return null;
  }

  /**
   * The agent's audio track.
   *
   * "First subscribed remote audio track" is the right rule here rather than a
   * lucky one: on a caller session the agent is the only other participant in
   * the room, and the numbers derived from this are labelled as the agent's
   * inbound speech. (An observer subscribes to the caller too — which is
   * exactly why observers do not sample transport at all.)
   */
  private remoteRtcStatsSource(): RtcStatsSource | null {
    for (const participant of values<{ audioTrackPublications?: unknown }>(
      (this.room as { remoteParticipants?: unknown }).remoteParticipants,
    )) {
      for (const publication of values<{ track?: unknown }>(participant.audioTrackPublications)) {
        if (hasRtcStats(publication.track)) return publication.track;
      }
    }
    return null;
  }

  /**
   * One raw reading of both directions. Never throws: a report that fails to
   * resolve is simply a direction this interval knows nothing about.
   */
  private async readAudioStats(): Promise<AudioStatsPair> {
    const local = this.localRtcStatsSource();
    const remote = this.remoteRtcStatsSource();

    const [outboundReport, inboundReport] = await Promise.all([
      local ? local.getRTCStatsReport().catch(() => undefined) : Promise.resolve(undefined),
      remote ? remote.getRTCStatsReport().catch(() => undefined) : Promise.resolve(undefined),
    ]);

    return {
      inbound: readInboundAudio(inboundReport),
      outbound: readOutboundAudio(outboundReport),
    };
  }

  /**
   * Loss over the last interval, as a percentage of what we sent in it.
   *
   * Both counters are cumulative for the life of the transport, so a ratio of
   * the raw totals would report the call's average forever and never move.
   * Deltas also make a reconnect visible: the counters restart, the delta goes
   * negative, and this re-baselines rather than reporting a loss of −4000%.
   */
  private lossPercent(stats: SenderStats): number | undefined {
    const { packetsSent: sent, packetsLost: lost } = stats;
    if (!Number.isFinite(sent) || !Number.isFinite(lost)) {
      this.lastPackets = null;
      return undefined;
    }

    const previous = this.lastPackets;
    this.lastPackets = { sent: sent as number, lost: lost as number };
    if (previous === null) return undefined;

    const sentDelta = (sent as number) - previous.sent;
    // A counter that went backwards is a new transport, not a measurement.
    if (sentDelta < 0) return undefined;
    // Nothing was sent this interval — a muted microphone measures no loss, it
    // does not measure zero loss.
    if (sentDelta === 0) return undefined;

    const lostDelta = Math.max(0, (lost as number) - previous.lost);
    return Math.min(100, (lostDelta / sentDelta) * 100);
  }

  /**
   * One reading, emitted into the store as a `transport` envelope.
   *
   * Never throws and never rejects: it runs on an interval for the whole call,
   * and an unhandled rejection here would be an unhandled rejection every two
   * seconds.
   */
  private async sampleTransport(): Promise<void> {
    if (this.samplingTransport || this.transportTimer === null) return;
    // Without an agent envelope to align against there is no agent clock to
    // stamp this with, and a sample stamped in browser time would distort every
    // elapsed figure on the page. The agent announces itself on join, so this
    // suppresses at most the first sample or two.
    if (!this.clock.aligned) return;

    this.samplingTransport = true;
    try {
      const payload: TransportPayload = { quality: readQuality(this.room.localParticipant) };

      const source = this.senderStatsSource();
      const stats = source ? await source.getSenderStats().catch(() => undefined) : undefined;

      if (stats) {
        // The WebRTC stats API reports both of these in seconds.
        if (Number.isFinite(stats.roundTripTime)) {
          payload.rtt_ms = Math.round((stats.roundTripTime as number) * 1000);
        }
        if (Number.isFinite(stats.jitter)) {
          payload.jitter_ms = Math.round((stats.jitter as number) * 10000) / 10;
        }
        const loss = this.lossPercent(stats);
        if (loss !== undefined) payload.packet_loss_pct = Math.round(loss * 100) / 100;
      }

      /*
       * The v1.3 enrichment. Kept behind its own try so a stats report that
       * misbehaves costs the second row of the panel rather than the first —
       * RTT, jitter and loss have been sampled successfully since v1.1 and must
       * not start disappearing because a browser changed what it publishes
       * about jitter buffers.
       */
      try {
        const audio = await this.readAudioStats();
        Object.assign(payload, deriveAudioFields(this.lastAudioStats, audio));
        this.lastAudioStats = audio;
      } catch {
        // Re-baseline: whatever went wrong, the next interval starts clean
        // rather than differencing against a reading that may be half-read.
        this.lastAudioStats = null;
      }

      const envelope: unknown = {
        v: SCHEMA_VERSION,
        type: 'transport',
        ts: this.clock.now(),
        payload,
      };

      // Held to the same contract as anything arriving off the wire. A negative
      // round-trip time or a stats report in unexpected units gets dropped here
      // rather than plotted, and the store keeps its guarantee that everything
      // in it validated.
      if (isEnvelope(envelope)) this.emit(envelope);
    } catch {
      // Stats are best effort by design: the panel degrades to quality-only,
      // and a call is never interrupted by its own instrumentation.
    } finally {
      this.samplingTransport = false;
    }
  }

  /**
   * Both publishing paths refuse outright on an observer session rather than
   * attempting a publish the token forbids. The server would reject it anyway,
   * but as an opaque failure deep inside the SDK; this says which rule was
   * broken, at the call site that broke it.
   */
  private assertWritable(action: string): void {
    if (this.observing) {
      throw new Error(`${action} is not available while observing — this session is read-only.`);
    }
  }

  /**
   * Arms or disarms injections, sending only the fields that changed.
   *
   * A patch rather than a full state, because that is what the contract asks
   * for: the agent applies the fields present and leaves the rest alone. It
   * also means two cockpits pointed at one agent cannot fight — flipping the
   * slow-model switch here does not re-assert this browser's idea of the token
   * ceiling over the other browser's.
   *
   * `max_completion_tokens: null` is a value, not an omission: it is how the
   * ceiling is taken off. `JSON.stringify` keeps nulls and drops undefineds,
   * which is exactly the distinction the wire needs.
   */
  async setChaos(patch: Partial<ChaosInjections>): Promise<void> {
    this.assertWritable('Chaos injection');
    // Normalised before it is measured, not after: an `undefined` counts toward
    // `Object.keys().length` and then disappears in `JSON.stringify`, so the
    // unfiltered patch can be non-empty and the published payload empty.
    const payload = definedInjections(patch);
    if (Object.keys(payload).length === 0) return;

    const message: ChaosControlMessage = { v: SCHEMA_VERSION, type: 'chaos', payload };
    await this.room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), {
      reliable: true,
      topic: CONTROL_TOPIC,
    });
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    this.assertWritable('The microphone');
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
  }

  /**
   * Silences or restores what this session is playing — the watcher's speakers,
   * not the call.
   *
   * Deliberately NOT `assertWritable`: this publishes nothing and touches no
   * track. It is a local playback decision, which is exactly why an observer —
   * the one session type forbidden to change anything about the call — is
   * allowed to make it.
   *
   * Never rejects. A browser that refuses to lift its autoplay block leaves the
   * elements unmuted and silent, which the next user gesture may well fix; a
   * thrown error here would instead leave the button's own state arguing with
   * the session's.
   */
  async setAudioMuted(muted: boolean): Promise<void> {
    this.audioMuted = muted;
    for (const element of this.audioElements) element.muted = muted;
    if (muted) return;
    // Unmuting is the first moment this page has actually asked to make a
    // sound, and it happens under a fresh user gesture — the best conditions
    // an autoplay unlock will ever get. See the note in `observe`.
    if (hasStartAudio(this.room)) await this.room.startAudio().catch(() => {});
  }

  async disconnect(): Promise<void> {
    // Stopped here as well as on the Disconnected event: a room that never
    // fires one must not leave an interval sampling a dead transport forever.
    this.stopTransport();
    await this.room.disconnect();
  }

  /** Full teardown for a session that must not survive — safe to call twice. */
  private async teardown(): Promise<void> {
    this.stopTransport();
    this.room.removeAllListeners();
    this.cleanupAudio();
    await this.room.disconnect().catch(() => {});
  }

  private cleanupAudio(): void {
    for (const element of this.audioElements) element.remove();
    this.audioElements.clear();
  }
}

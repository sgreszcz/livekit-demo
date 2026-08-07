/**
 * The observer session, asserted against a fake `livekit-client`.
 *
 * The real package is never loaded: it wants a browser, and what is being
 * checked here is not the SDK but the promises the cockpit makes about how it
 * uses it. The headline one is negative — an observer must never ask for a
 * microphone — and a negative promise is only worth anything if something counts
 * the calls that did not happen.
 *
 * The caller path is exercised too, because `observe` and `connect` now share
 * their room wiring: a refactor that quietly stopped publishing a microphone, or
 * stopped clearing the transport interval, would otherwise be invisible.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CockpitSession } from './session';
import { SCHEMA_VERSION, type Envelope } from '../telemetry/schema';

const mocks = vi.hoisted(() => {
  const ROOM_EVENT = {
    DataReceived: 'dataReceived',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    Disconnected: 'disconnected',
    ConnectionQualityChanged: 'connectionQualityChanged',
  };

  /** Armed per test, read when a room is constructed inside `connect`. */
  const config = { micFails: false, audioBlocked: false };

  const instances: FakeRoom[] = [];

  class FakeRoom {
    handlers = new Map<string, ((...args: never[]) => void)[]>();
    connectCalls: { url: string; token: string }[] = [];
    disconnectCalls = 0;
    localParticipant = {
      setMicrophoneEnabled: config.micFails
        ? vi.fn(async () => {
            throw new Error('NotAllowedError');
          })
        : vi.fn(async () => {}),
      publishData: vi.fn(async () => {}),
      audioTrackPublications: new Map<string, unknown>(),
      connectionQuality: 'excellent',
    };
    /** The agent, on a caller session. Empty unless a test installs one. */
    remoteParticipants = new Map<string, unknown>();

    constructor() {
      instances.push(this);
    }

    on(event: string, handler: (...args: never[]) => void): this {
      const existing = this.handlers.get(event) ?? [];
      existing.push(handler);
      this.handlers.set(event, existing);
      return this;
    }

    removeAllListeners(): this {
      this.handlers.clear();
      return this;
    }

    /** Armed per test, like the microphone above — a real browser may refuse. */
    startAudio = config.audioBlocked
      ? vi.fn(async () => {
          throw new Error('NotAllowedError');
        })
      : vi.fn(async () => {});

    async connect(url: string, token: string): Promise<void> {
      this.connectCalls.push({ url, token });
    }

    async disconnect(): Promise<void> {
      this.disconnectCalls += 1;
    }

    /** Fires an event the way the SDK would. */
    fire(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        (handler as (...args: unknown[]) => void)(...args);
      }
    }
  }

  return { ROOM_EVENT, FakeRoom, instances, config };
});

vi.mock('livekit-client', () => ({
  Room: mocks.FakeRoom,
  RoomEvent: mocks.ROOM_EVENT,
  Track: { Kind: { Audio: 'audio', Video: 'video' } },
}));

const TOKEN_RESPONSE = { token: 'jwt', url: 'wss://livekit.example', roomName: 'cockpit-demo01' };

const ENVELOPE: Envelope = {
  v: SCHEMA_VERSION,
  type: 'state',
  ts: 1723000000,
  payload: { state: 'listening' },
};

const encoder = new TextEncoder();

type FetchStub = (
  input: string,
  init?: { body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

let fetchMock: Mock<FetchStub>;
let callbacks: { onEnvelope: Mock<(envelope: Envelope) => void>; onDisconnected: Mock<() => void> };

/** The room the session under test built — there is exactly one per session. */
const lastRoom = () => mocks.instances[mocks.instances.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  mocks.instances.length = 0;
  mocks.config.micFails = false;
  mocks.config.audioBlocked = false;

  fetchMock = vi.fn(async (_input: string, _init?: { body?: string }) => ({
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => TOKEN_RESPONSE,
  }));
  vi.stubGlobal('fetch', fetchMock);

  // Only the audio-attach path touches the document, and no test here fires a
  // track event — but a session reaching for a missing global would fail in a
  // way none of the assertions below would explain.
  vi.stubGlobal('document', { body: { appendChild: vi.fn() } });

  callbacks = { onEnvelope: vi.fn(), onDisconnected: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function tokenRequestBody(): unknown {
  const init = fetchMock.mock.calls[0][1];
  return JSON.parse(init?.body ?? 'null');
}

function fireFrame(json: string, topic: string | undefined): void {
  lastRoom().fire('dataReceived', encoder.encode(json), undefined, undefined, topic);
}

describe('CockpitSession.observe', () => {
  it('asks the Worker for a token scoped to the room being watched', async () => {
    await CockpitSession.observe('sip-cockpit-abc123', callbacks);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/token');
    expect(tokenRequestBody()).toEqual({ observe: 'sip-cockpit-abc123' });
    expect(lastRoom().connectCalls).toEqual([
      { url: TOKEN_RESPONSE.url, token: TOKEN_RESPONSE.token },
    ]);
  });

  it('never touches the microphone, so nothing ever prompts for permission', async () => {
    const session = await CockpitSession.observe('cockpit-demo01', callbacks);
    const room = lastRoom();

    // The whole promise of the observer path, and the only way to assert a
    // promise like that is to count the calls that did not happen.
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(0);

    await expect(session.setMicrophoneEnabled(true)).rejects.toThrow(/read-only/);
    await expect(session.setMicrophoneEnabled(false)).rejects.toThrow(/read-only/);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(0);
  });

  it('marks the session read-only', async () => {
    const session = await CockpitSession.observe('cockpit-demo01', callbacks);
    expect(session.observing).toBe(true);
  });

  it('delivers a cockpit frame to the store and ignores every other topic', async () => {
    await CockpitSession.observe('cockpit-demo01', callbacks);

    // The agent's replayed history arrives exactly this way too — ordinary
    // envelopes, no special case anywhere in the store.
    fireFrame(JSON.stringify(ENVELOPE), 'cockpit');
    expect(callbacks.onEnvelope).toHaveBeenCalledTimes(1);
    expect(callbacks.onEnvelope).toHaveBeenCalledWith(ENVELOPE);

    fireFrame(JSON.stringify(ENVELOPE), 'cockpit-control');
    fireFrame(JSON.stringify(ENVELOPE), undefined);
    expect(callbacks.onEnvelope).toHaveBeenCalledTimes(1);
  });

  it('drops a malformed frame instead of throwing into the page', async () => {
    await CockpitSession.observe('cockpit-demo01', callbacks);

    expect(() => {
      fireFrame('{not json', 'cockpit');
      fireFrame('{"v":1,"type":"state","ts":1,"payload":{}}', 'cockpit');
    }).not.toThrow();
    expect(callbacks.onEnvelope).not.toHaveBeenCalled();
  });

  it('refuses to publish chaos rather than firing a frame the token forbids', async () => {
    const session = await CockpitSession.observe('cockpit-demo01', callbacks);

    // Every injection, not just the one that existed first: an observer that
    // could still starve the model's tokens would be read-only in name only.
    await expect(session.setChaos({ llm_delay_ms: 800 })).rejects.toThrow(/read-only/);
    await expect(session.setChaos({ tts_delay_ms: 300 })).rejects.toThrow(/read-only/);
    await expect(session.setChaos({ slow_model: true })).rejects.toThrow(/read-only/);
    await expect(session.setChaos({ max_completion_tokens: 30 })).rejects.toThrow(/read-only/);
    expect(lastRoom().localParticipant.publishData).not.toHaveBeenCalled();
  });

  it('samples no transport, and leaves no interval behind after disconnect', async () => {
    const session = await CockpitSession.observe('cockpit-demo01', callbacks);

    // An observer publishes nothing, so there is no uplink of the caller's to
    // measure — and nothing running that could pretend otherwise.
    expect(vi.getTimerCount()).toBe(0);

    await session.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    expect(lastRoom().disconnectCalls).toBe(1);
  });

  it('reports the watched call ending as a plain disconnect', async () => {
    await CockpitSession.observe('cockpit-demo01', callbacks);
    lastRoom().fire('disconnected');
    expect(callbacks.onDisconnected).toHaveBeenCalledTimes(1);
  });

  /*
   * The abort listener cannot exist until there is a session to tear down, and
   * `addEventListener('abort', …)` on an already-aborted signal never fires. So
   * a visitor who hits Cancel while the token is in flight used to get a room
   * joined on their behalf a moment later — briefly audible, and if the connect
   * stalled, holding a call nothing could reach.
   */
  it('joins nothing when the watcher cancels while the token is in flight', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return { ok: true, status: 200, json: async (): Promise<unknown> => TOKEN_RESPONSE };
    });

    await expect(
      CockpitSession.observe('cockpit-demo01', callbacks, controller.signal),
    ).rejects.toThrow();

    // Not "connected and then torn down" — never connected at all.
    expect(mocks.instances).toHaveLength(0);
  });

  it('asks the browser to lift an autoplay block, since it publishes no mic', async () => {
    // A caller unlocks audio as a side effect of granting a microphone; an
    // observer grants nothing, so it has to ask, or it watches a silent call.
    await CockpitSession.observe('cockpit-demo01', callbacks);
    expect(lastRoom().startAudio).toHaveBeenCalledTimes(1);
  });

  it('survives a browser that refuses to start audio', async () => {
    // Strict mobile Safari is the real case here. The refusal must not reject
    // the join or raise an unhandled rejection: a silent observer still has a
    // full set of working instruments, which is degraded, not broken.
    mocks.config.audioBlocked = true;

    const session = await CockpitSession.observe('cockpit-demo01', callbacks);

    expect(session.observing).toBe(true);
    expect(lastRoom().startAudio).toHaveBeenCalledTimes(1);
    expect(callbacks.onDisconnected).not.toHaveBeenCalled();
  });

  it('surfaces a refused token instead of joining anything', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 403,
      json: async (): Promise<unknown> => ({}),
    }));

    await expect(CockpitSession.observe('lobby', callbacks)).rejects.toThrow(/403/);
    expect(mocks.instances).toHaveLength(0);
  });
});

/** The caller path, which must be exactly what it was before it gained a housemate. */
describe('CockpitSession.connect', () => {
  it('still asks for a caller token and publishes the microphone', async () => {
    const session = await CockpitSession.connect(callbacks);

    expect(session.observing).toBe(false);
    expect(tokenRequestBody()).toEqual({});
    expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);

    fireFrame(JSON.stringify(ENVELOPE), 'cockpit');
    expect(callbacks.onEnvelope).toHaveBeenCalledWith(ENVELOPE);

    await session.disconnect();
  });

  it('still explains a refused microphone and leaves no room joined', async () => {
    mocks.config.micFails = true;

    await expect(CockpitSession.connect(callbacks)).rejects.toThrow(/needs your microphone/);
    expect(lastRoom().disconnectCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts transport sampling and clears it on disconnect', async () => {
    const session = await CockpitSession.connect(callbacks);
    // The caller's uplink is the one thing worth sampling here, and it must not
    // outlive the call it is measuring.
    expect(vi.getTimerCount()).toBe(1);

    await session.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The control channel under v1.3.
 *
 * The contract says the agent applies the fields present and leaves the rest
 * alone, which makes a control message a patch. The assertions here are mostly
 * about what is *not* in the frame: a cockpit that helpfully re-sent its whole
 * idea of the state on every click would overwrite whatever a second cockpit
 * pointed at the same agent had just set.
 */
describe('CockpitSession.setChaos', () => {
  /** The JSON actually put on the wire, decoded. */
  function publishedFrames(): { payload: Record<string, unknown>; topic?: string }[] {
    const publish = lastRoom().localParticipant.publishData as unknown as {
      mock: { calls: [Uint8Array, { topic?: string; reliable?: boolean }][] };
    };
    return publish.mock.calls.map(([bytes, options]) => ({
      payload: (JSON.parse(new TextDecoder().decode(bytes)) as { payload: Record<string, unknown> })
        .payload,
      topic: options?.topic,
    }));
  }

  it('sends only the field that changed, on the control topic', async () => {
    const session = await CockpitSession.connect(callbacks);
    await session.setChaos({ llm_delay_ms: 800 });

    const [frame] = publishedFrames();
    expect(frame.topic).toBe('cockpit-control');
    expect(frame.payload).toEqual({ llm_delay_ms: 800 });
    // Not three extra keys asserting this browser's idea of the other three.
    expect(Object.keys(frame.payload)).toHaveLength(1);

    await session.disconnect();
  });

  it('carries each of the four injections in the wire’s own spelling', async () => {
    const session = await CockpitSession.connect(callbacks);
    await session.setChaos({ tts_delay_ms: 300 });
    await session.setChaos({ slow_model: true });
    await session.setChaos({ max_completion_tokens: 30 });

    expect(publishedFrames().map((frame) => frame.payload)).toEqual([
      { tts_delay_ms: 300 },
      { slow_model: true },
      { max_completion_tokens: 30 },
    ]);

    await session.disconnect();
  });

  it('puts an explicit null on the wire to take a token ceiling off', async () => {
    // The one case JSON could silently swallow: `undefined` disappears from a
    // serialised object and `null` does not, and only `null` turns starvation
    // off. A patch that lost this field would leave the agent starved.
    const session = await CockpitSession.connect(callbacks);
    await session.setChaos({ max_completion_tokens: null });

    const [frame] = publishedFrames();
    expect(frame.payload).toEqual({ max_completion_tokens: null });
    expect('max_completion_tokens' in frame.payload).toBe(true);

    await session.disconnect();
  });

  it('publishes nothing at all for an empty patch', async () => {
    const session = await CockpitSession.connect(callbacks);
    await session.setChaos({});
    expect(publishedFrames()).toHaveLength(0);
    await session.disconnect();
  });
});

/**
 * Transport sampling with the v1.3 enrichment.
 *
 * The raw report is faked, because a real `RTCStatsReport` needs a real peer
 * connection with real audio flowing. What is under test is the plumbing: that
 * both directions are found, that the first sample carries levels and the
 * second carries rates, and — the load-bearing one — that a browser publishing
 * none of it still produces the v1.1 sample it always did.
 */
describe('CockpitSession transport sampling', () => {
  const SAMPLE_MS = 2000;

  const senderStats = { roundTripTime: 0.048, jitter: 0.0041, packetsSent: 100, packetsLost: 1 };

  /** Installs a microphone and an agent track on the room under test. */
  function installTracks(options: { rtcStats?: boolean } = {}) {
    const room = lastRoom();
    let tick = 1000;

    const localTrack: Record<string, unknown> = {
      getSenderStats: vi.fn(async () => senderStats),
    };
    const remoteTrack: Record<string, unknown> = {};

    if (options.rtcStats !== false) {
      localTrack.getRTCStatsReport = vi.fn(async () =>
        new Map<string, unknown>([
          ['o', { type: 'outbound-rtp', kind: 'audio', timestamp: tick, bytesSent: tick * 4 }],
          ['m', { type: 'media-source', kind: 'audio', audioLevel: 0.02 }],
        ]),
      );
      remoteTrack.getRTCStatsReport = vi.fn(async () => {
        const report = new Map<string, unknown>([
          [
            'i',
            {
              type: 'inbound-rtp',
              kind: 'audio',
              timestamp: tick,
              audioLevel: 0.31,
              bytesReceived: tick * 3,
              jitterBufferDelay: tick / 1000,
              jitterBufferEmittedCount: tick * 10,
              concealedSamples: tick / 10,
              totalSamplesReceived: tick * 10,
            },
          ],
        ]);
        // Both reports are read per sample; advance the fake clock after the
        // inbound one so the two directions share a timestamp.
        tick += SAMPLE_MS;
        return report;
      });
    }

    room.localParticipant.audioTrackPublications.set('mic', { track: localTrack });
    room.remoteParticipants.set('agent', {
      audioTrackPublications: new Map([['agent-audio', { track: remoteTrack }]]),
    });
  }

  /** Every transport envelope the session has emitted so far. */
  function transportPayloads(): Record<string, unknown>[] {
    return callbacks.onEnvelope.mock.calls
      .map(([envelope]) => envelope)
      .filter((envelope) => envelope.type === 'transport')
      .map((envelope) => envelope.payload as unknown as Record<string, unknown>);
  }

  it('derives the v1.3 fields once there are two readings to difference', async () => {
    const session = await CockpitSession.connect(callbacks);
    // Transport samples are stamped on the agent clock, so nothing is emitted
    // until an agent envelope has been seen.
    fireFrame(JSON.stringify(ENVELOPE), 'cockpit');
    installTracks();

    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    const [first] = transportPayloads();
    // Levels are instantaneous and land immediately; the rates cannot exist yet.
    expect(first.audio_level_in).toBe(0.31);
    expect(first.audio_level_out).toBe(0.02);
    expect(first.bitrate_in_kbps).toBeUndefined();
    expect(first.concealed_pct).toBeUndefined();

    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    const second = transportPayloads()[1];
    expect(second.bitrate_in_kbps).toBeGreaterThan(0);
    expect(second.bitrate_out_kbps).toBeGreaterThan(0);
    expect(second.jitter_buffer_ms).toBeGreaterThan(0);
    expect(second.concealed_pct).toBeCloseTo(1, 6);
    // The v1.1 figures are unaffected by any of it.
    expect(second.rtt_ms).toBe(48);
    expect(second.jitter_ms).toBe(4.1);
    expect(second.quality).toBe('excellent');

    await session.disconnect();
  });

  it('still produces a v1.1 sample from a browser that publishes no raw report', async () => {
    // The regression that would matter most: RTT, jitter and loss have been
    // sampled since v1.1, and must not start disappearing because a browser
    // changed what it says about jitter buffers.
    const session = await CockpitSession.connect(callbacks);
    fireFrame(JSON.stringify(ENVELOPE), 'cockpit');
    installTracks({ rtcStats: false });

    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 2);
    const payloads = transportPayloads();
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload.rtt_ms).toBe(48);
      expect(payload.audio_level_in).toBeUndefined();
      expect(payload.concealed_pct).toBeUndefined();
    }

    await session.disconnect();
  });

  it('keeps sampling after a raw report throws', async () => {
    const session = await CockpitSession.connect(callbacks);
    fireFrame(JSON.stringify(ENVELOPE), 'cockpit');

    const room = lastRoom();
    room.localParticipant.audioTrackPublications.set('mic', {
      track: {
        getSenderStats: vi.fn(async () => senderStats),
        getRTCStatsReport: vi.fn(async () => {
          throw new Error('gone');
        }),
      },
    });

    await vi.advanceTimersByTimeAsync(SAMPLE_MS * 2);
    const payloads = transportPayloads();
    expect(payloads).toHaveLength(2);
    // A call is never interrupted by its own instrumentation.
    expect(payloads[1].rtt_ms).toBe(48);

    await session.disconnect();
  });
});

/**
 * The `undefined` trap on the control channel.
 *
 * `exactOptionalPropertyTypes` is off in this project, so
 * `{ max_completion_tokens: undefined }` type-checks against
 * `Partial<ChaosInjections>`. It also has a non-zero `Object.keys().length` and
 * then disappears in `JSON.stringify` — so an unfiltered patch can be non-empty
 * while the published payload is `{}`, a message asking the agent to change
 * nothing, sent while the cockpit optimistically redraws the switch as off. The
 * ceiling stays on and every instrument agrees it is off.
 */
describe('CockpitSession.setChaos — undefined is not a value', () => {
  const published = () =>
    (lastRoom().localParticipant.publishData as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;

  it('publishes nothing for a patch whose only field is undefined', async () => {
    const session = await CockpitSession.connect(callbacks);
    await session.setChaos({ max_completion_tokens: undefined });
    expect(published()).toHaveLength(0);
    await session.disconnect();
  });

  it('drops an undefined field but still sends the real ones beside it', async () => {
    const session = await CockpitSession.connect(callbacks);
    await session.setChaos({ llm_delay_ms: 400, tts_delay_ms: undefined });

    const frame = JSON.parse(new TextDecoder().decode(published()[0][0] as Uint8Array)) as {
      payload: Record<string, unknown>;
    };
    expect(frame.payload).toEqual({ llm_delay_ms: 400 });
    expect('tts_delay_ms' in frame.payload).toBe(false);

    await session.disconnect();
  });

  it('keeps null, which is a value and the only way to clear a ceiling', async () => {
    const session = await CockpitSession.connect(callbacks);
    await session.setChaos({ max_completion_tokens: null });

    const frame = JSON.parse(new TextDecoder().decode(published()[0][0] as Uint8Array)) as {
      payload: Record<string, unknown>;
    };
    expect('max_completion_tokens' in frame.payload).toBe(true);
    expect(frame.payload.max_completion_tokens).toBeNull();

    await session.disconnect();
  });
});

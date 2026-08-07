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

    await expect(session.setChaosDelay(800)).rejects.toThrow(/read-only/);
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

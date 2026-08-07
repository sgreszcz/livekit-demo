/**
 * The main view: hero until a call starts, then the live instrument cluster,
 * then a debrief once the call ends.
 */

import { useEffect, useMemo } from 'react';
import { CockpitBoard } from '../components/CockpitBoard';
import { Footer } from '../components/Footer';
import { LiveCallCard, type LiveCallEntry } from '../components/LiveCallCard';
import { Mark } from '../components/Mark';
import { MiniWaterfall } from '../components/MiniWaterfall';
import { ModeLamp } from '../components/ModeLamp';
import { Tabs } from '../components/Tabs';
import { useBundleWatch, reloadableMode } from '../bundleWatch';
import { PHONE_DISPLAY, PHONE_E164 } from '../config';
import { navigate } from '../router';
import { fixtureEnvelopes } from '../telemetry/fixtureSource';
import { roomElapsedSeconds } from '../telemetry/activeRooms';
import { callDurationSeconds, reduceAll } from '../telemetry/store';
import { useActiveRooms } from '../useActiveRooms';
import { useCockpit } from '../useCockpit';
import { duration, ms } from '../format';

export function HomeView() {
  const cockpit = useCockpit();
  const { mode, startReplay } = cockpit;
  const showBoard = mode !== 'idle' && mode !== 'error';

  // Only the hero asks who is on the phone. During a call, a replay or a
  // debrief the visitor is reading instruments, and a poll behind them would be
  // network traffic bought for a list nobody can see.
  const onHero = mode === 'idle' || mode === 'error';
  const active = useActiveRooms(onHero);

  /*
   * An open tab keeps running the bundle it downloaded, so a deploy is invisible
   * to everyone already on the page — which is exactly the audience during a
   * demo. The hero is the only state here that can be thrown away without
   * costing anything, so it is the only one that checks. See `bundleWatch`.
   */
  useBundleWatch(reloadableMode(mode));

  /**
   * Elapsed time is recomputed here, on each render, from the snapshot that is
   * already in hand — which means it advances once every poll rather than once
   * a second. That is deliberate: a per-second ticker would be a second timer
   * animating a figure whose underlying reading is five seconds old, and a
   * smooth number is not the same thing as a fresh one.
   */
  // The mode is re-checked here as well as in the hook: the hook clears its
  // snapshot from an effect, which is one render after the mode changed, and
  // that render would flash a lobby over a call that is already connecting.
  const calls: LiveCallEntry[] = active && onHero
    ? active.rooms.map((room) => ({
        room: room.room,
        entry: room.entry,
        elapsedSeconds: roomElapsedSeconds(room, active, Date.now()),
      }))
    : [];

  // `?fixture=1` boots straight into the recorded sample call — the link the
  // hero offers to visitors who would rather not talk to a robot.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('fixture') === '1') startReplay();
  }, [startReplay]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__mark">
          <Mark />
          Glass <span>Cockpit</span>
        </div>
        <Tabs route="home" />
        <ModeLamp mode={mode} />
        <div className="topbar__spacer" />
        {/* One flex child holds every control, so when the bar wraps on a phone
            the controls travel together and stay right-aligned. */}
        <div className="topbar__actions">
          {mode === 'live' ? (
            <>
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => void cockpit.toggleMic()}
              >
                {cockpit.micEnabled ? 'Mute' : 'Unmute'}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => void cockpit.endCall()}
              >
                End call
              </button>
            </>
          ) : null}
          {mode === 'connecting' ? (
            // Joining can stall on an unanswered microphone prompt, so there is
            // always a way out that also tears the half-built room down.
            <button type="button" className="btn btn--quiet" onClick={cockpit.reset}>
              Cancel
            </button>
          ) : null}
          {mode === 'replay' ? (
            <button type="button" className="btn btn--quiet" onClick={() => void cockpit.endCall()}>
              <span className="wide-only">Stop replay</span>
              <span className="narrow-only">Stop</span>
            </button>
          ) : null}
          {mode === 'ended' ? (
            <button type="button" className="btn btn--quiet" onClick={cockpit.reset}>
              <span className="wide-only">Back to start</span>
              <span className="narrow-only">Back</span>
            </button>
          ) : null}
        </div>
      </header>

      {cockpit.error ? <p className="notice">{cockpit.error}</p> : null}

      {/* Above the hero and full width: on a phone this is the first thing on
          the screen, which is the point — someone else's call in progress is a
          better invitation than any button.

          Watching navigates to `/live` rather than joining in place, which
          makes the act of watching a URL: the address bar now holds a link that
          can be sent to someone else, and a refresh mid-watch rejoins instead of
          dumping the visitor back on the pitch. `/live` owns the observer
          experience entirely — this page never enters `observing` mode. */}
      <LiveCallCard
        calls={calls}
        onWatch={(room) => navigate(`/live?room=${encodeURIComponent(room)}`)}
      />

      {mode === 'idle' || mode === 'error' ? <Hero cockpit={cockpit} /> : null}

      {mode === 'ended' ? <Debrief cockpit={cockpit} /> : null}

      {mode === 'connecting' && cockpit.state.log.entries.length === 0 ? (
        <p className="state-note">Requesting a token and joining the room…</p>
      ) : null}

      {showBoard ? (
        <CockpitBoard
          state={cockpit.state}
          follow={mode !== 'ended'}
          /* True only for a call this browser is on. Transport is the caller's
             uplink, measured from the microphone they publish; a replay and a
             finished call have no live uplink at all, and the panel's "not
             recorded" note is the honest answer for both. */
          live={mode === 'live'}
          chaos={{
            request: cockpit.chaosRequest,
            disabled: mode !== 'live',
            onChange: (patch) => void cockpit.setChaos(patch),
          }}
        />
      ) : null}

      <Footer />
    </div>
  );
}

function Hero({ cockpit }: { cockpit: ReturnType<typeof useCockpit> }) {
  return (
    <section className="hero">
      <div className="hero__lead">
        <div className="hero__badge">Live telemetry · LiveKit voice agents</div>

        <h1>
          Glass Cockpit
          <em>The flight recorder for voice agents</em>
        </h1>

        <p className="hero__lede">
          Talk to a LiveKit voice agent and watch it from the inside — every turn broken into
          end-of-utterance detection, transcription, time to first token and time to first audio,
          with interruptions and running cost. <strong>The demo is the easy part.</strong> Flip the
          chaos switch and watch the instruments tell you exactly where the second went.
        </p>

        <div className="hero__actions">
          <button type="button" className="btn btn--primary" onClick={() => void cockpit.startCall()}>
            Call from browser
          </button>
          <button type="button" className="btn" onClick={cockpit.startReplay}>
            See a sample flight
          </button>
        </div>

        <p className="hero__note">
          Browser calls need microphone permission. The sample flight is a recorded call — no
          microphone, no agent, same instruments.
        </p>
      </div>

      <aside className="hero__aside">
        <div className="placard">
          <div className="placard__head">
            <h2 className="legend">Call the agent</h2>
            <span className="tag">SIP trunk</span>
          </div>
          {/* A phone can tap this; a laptop reads it as a number to dial. */}
          <a className="placard__value num" href={`tel:${PHONE_E164}`}>
            {PHONE_DISPLAY}
          </a>
          <div className="placard__foot">
            Call from any phone and you reach the same agent over a SIP trunk. The browser call is
            the one that draws these instruments live.
          </div>
          {/*
           * Said once, quietly, in the caption colour, next to the thing it is
           * about — the number someone is deciding whether to dial.
           *
           * It earns its place by being true and useful rather than defensive:
           * this page's whole pitch is that a call is legible from the outside,
           * and "a call in progress can be watched live from this page" is that
           * pitch stated as a fact about the caller's own call. A banner would
           * make it sound like a risk; a caption makes it sound like candour,
           * which is what it is.
           */}
          <div className="placard__foot placard__foot--note">
            Calls are demo calls — telemetry from every call is public, and a call in progress can
            be watched live from this page.
          </div>
        </div>

        <div className="placard">
          <div className="placard__head">
            <h2 className="legend">Sample flight</h2>
            <span className="tag">Recorded</span>
          </div>
          <SampleSpec />
        </div>
      </aside>
    </section>
  );
}

/**
 * Reads the shipped fixture so the hero advertises the real recording — every
 * figure here is derived, so re-recording the sample cannot leave the placard
 * quoting numbers the replay no longer shows.
 */
function SampleSpec() {
  const sample = useMemo(() => {
    const state = reduceAll(fixtureEnvelopes);
    const measured = state.turns.filter((turn) => turn.totalResponseLatency !== undefined);

    return {
      // The greeting has no caller utterance and so no latency of its own.
      greetings: state.turns.length - measured.length,
      measured: measured.length,
      seconds: callDurationSeconds(state),
      worst: measured.reduce((max, turn) => Math.max(max, turn.totalResponseLatency ?? 0), 0),
      bargeIns: state.turns.filter((turn) => turn.interruptions.includes('barge_in')).length,
      degraded: state.turns.filter((turn) => turn.degraded).length,
      bars: measured.map((turn) => ({
        seconds: turn.totalResponseLatency!,
        degraded: turn.degraded,
      })),
    };
  }, []);

  return (
    <>
    <MiniWaterfall bars={sample.bars} />
    <dl className="spec-list">
      <div>
        <dt>Turns</dt>
        <dd className="num">
          {sample.greetings > 0 ? `Greeting + ${sample.measured}` : sample.measured}
        </dd>
      </div>
      <div>
        <dt>Length</dt>
        <dd className="num">{duration(sample.seconds)}</dd>
      </div>
      <div>
        <dt>Worst</dt>
        <dd className="num">{ms(sample.worst)} ms under chaos</dd>
      </div>
      <div>
        <dt>Includes</dt>
        <dd>
          {sample.bargeIns} barge-in{sample.bargeIns === 1 ? '' : 's'}, {sample.degraded} degraded
          turns
        </dd>
      </div>
    </dl>
    </>
  );
}

function Debrief({ cockpit }: { cockpit: ReturnType<typeof useCockpit> }) {
  const { share, sharing, state } = cockpit;

  return (
    <div className="debrief-bar">
      <div className="debrief-bar__text">
        <span className="legend">Call complete</span>
        <p>
          {state.turns.length} turns over {duration((state.lastTs ?? 0) - (state.firstTs ?? 0))}.
          Everything below is the finished recording.
        </p>
      </div>

      {share ? (
        <div className="share-url">
          <span className="legend">Share</span>
          {/* A new tab so opening the replay does not discard the call it came from. */}
          <a href={share.url} target="_blank" rel="noreferrer noopener">
            {share.url}
          </a>
        </div>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={sharing || state.log.entries.length === 0}
          onClick={() => void cockpit.shareCall()}
        >
          {sharing ? 'Saving…' : 'Share this call'}
        </button>
      )}
    </div>
  );
}

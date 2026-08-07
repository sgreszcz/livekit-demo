/**
 * `/live` — a link you can send someone: "watch my call".
 *
 * The hero is a pitch that happens to list live calls. This is the opposite: a
 * page whose entire job is to be pointed at whatever the agent is doing right
 * now, joined automatically, with a holding pattern rather than a lobby when
 * there is nothing to watch. Sent by text before dialling, it is open and
 * waiting by the time the phone rings.
 *
 * The rules that make that work are all about NOT doing things:
 *
 *   - it never joins a call the visitor has already left, or one that refused
 *     it, which is what stops "Stop watching" being undone by the next poll;
 *   - leaving and hanging up both land back in the holding state rather than on
 *     the hero, because the promise of this URL is that it keeps waiting;
 *   - audio starts muted, exactly as everywhere else an observer session exists
 *     — the likeliest visitor here is the caller, watching their own call on the
 *     laptop beside the phone.
 *
 * The decision of what to join is in `autoJoinTarget`, which is pure and tested.
 * What is left here is wiring.
 */

import { useEffect, useRef, useState } from 'react';
import { CockpitBoard } from '../components/CockpitBoard';
import { Footer } from '../components/Footer';
import { LiveCallCard, type LiveCallEntry } from '../components/LiveCallCard';
import { Mark } from '../components/Mark';
import { ModeLamp } from '../components/ModeLamp';
import { ObserverBar } from '../components/ObserverBar';
import { Tabs } from '../components/Tabs';
import { useBundleWatch, reloadableMode } from '../bundleWatch';
import { roomElapsedSeconds } from '../telemetry/activeRooms';
import { useActiveRooms } from '../useActiveRooms';
import { useCockpit } from '../useCockpit';
import { autoJoinTarget, linkRoomGone } from './liveJoin';

/**
 * The panel is live here, and it is not the only one pointed at this agent —
 * the caller has the same four switches. The contract is last-write-wins per
 * field, so the honest caption is about precedence rather than about ownership.
 *
 * It replaces "Chaos injection is caller-side — this session is read-only",
 * which was true until observer tokens were granted `canPublishData` and is the
 * kind of stale copy that makes a working control look broken.
 */
export const OBSERVER_CHAOS_NOTE =
  'Armed from here or by the caller — the agent applies whichever came last.';

export function LiveView({ room: preferred }: { room: string | null }) {
  const cockpit = useCockpit();
  const { error, mode, reset, startObserving, stopObserving } = cockpit;

  /**
   * Rooms this page is finished with: left, ended, or refused. A ref rather
   * than state because nothing renders from it — it is consulted when a poll
   * lands, and a poll landing is already a render.
   */
  const excludedRef = useRef<Set<string>>(new Set());
  /** The room the current session is on, so that leaving can exclude it. */
  const joinedRef = useRef<string | null>(null);
  /** Why the page is waiting, when there is something worth saying about it. */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Whether this page may join whatever is live, without being asked again.
   *
   * A bare `/live` starts unarmed and offers one button, because loading a URL
   * is not the same as asking to watch a stranger's phone call — and the audio
   * unlock a browser grants under a real click is worth having anyway.
   */
  const [armed, setArmed] = useState(false);

  /**
   * The call a `?room=` link named, until it is joined or found to be over.
   *
   * Held as state rather than read from the prop because it is consumed: the
   * link authorises ONE call, and once that call has been joined or has hung up
   * the page must stop pursuing it. Clearing it is what turns the page back into
   * an ordinary unarmed `/live` — which then asks, rather than silently
   * adopting whoever else is on the agent.
   */
  const [linkTarget, setLinkTarget] = useState(preferred);

  // A visitor can navigate from one `/live?room=` link to another without this
  // component ever unmounting, and the new link is a new authorisation.
  useEffect(() => {
    setLinkTarget(preferred);
  }, [preferred]);

  const holding = mode === 'idle';
  const snapshot = useActiveRooms(holding);

  // The hero's reasoning applies unchanged: this page is stateless while it
  // waits, and a visitor who left it open since before a deploy should be
  // running the deployed code by the time a call arrives.
  useBundleWatch(reloadableMode(mode));

  /*
   * A finished session goes back to waiting rather than to the hero — that is
   * the promise of the URL. The room is retired first: `/api/active` is polled
   * every five seconds, so the call that just ended is still in the snapshot,
   * and without this the page would rejoin the corpse of it.
   *
   * The reason is kept as a local notice because `reset()` clears the cockpit's
   * own error, and "that call could not be watched" is the one thing a visitor
   * staring at a waiting screen actually needs to know.
   */
  useEffect(() => {
    if (mode !== 'ended' && mode !== 'error') return;
    const room = joinedRef.current;
    if (room !== null) excludedRef.current.add(room);
    joinedRef.current = null;
    /*
     * The tail has to match what the page will actually do next. An armed page
     * really does join the next call on its own; an unarmed one — a visitor who
     * arrived on a `?room=` link, whose single authorisation has now been spent
     * — is going to ask. Promising the wrong one of those is a small lie told
     * by the only sentence on the screen.
     */
    const next = armed
      ? 'This page joins the next one automatically.'
      : 'Watch the next one whenever you like.';
    setNotice(
      mode === 'error'
        ? `${error ?? 'That call could not be watched.'} ${next}`
        : `That call ended. ${next}`,
    );
    reset();
  }, [mode, error, armed, reset]);

  /*
   * The join. Re-evaluated on every poll, which is what makes the holding state
   * a holding state: the snapshot is a new object each time one lands, so a call
   * appearing is a render, and a render is a decision.
   */
  useEffect(() => {
    const target = autoJoinTarget({
      mode,
      snapshot,
      preferred: linkTarget,
      excluded: excludedRef.current,
      armed,
    });
    if (target === null) return;
    // Recorded before the await, not after: the session may fail or be left
    // while `startObserving` is still connecting, and the failure path needs to
    // know which room to retire.
    joinedRef.current = target;
    // Spent. If this join fails, or the call later ends, the page drops to the
    // holding screen and asks — it does not go looking for a substitute.
    if (target === linkTarget) setLinkTarget(null);
    setNotice(null);
    void startObserving(target);
  }, [mode, snapshot, linkTarget, armed, startObserving]);

  /*
   * The link named a call that is not there — hung up before the page loaded,
   * or finished with while it was open.
   *
   * The page stops waiting for it and becomes an ordinary unarmed `/live`:
   * "that call has ended, watch the next one", one button, one press. Joining
   * somebody else's call instead would be surprising and would quietly widen
   * what the link's gesture consented to.
   */
  useEffect(() => {
    if (!linkRoomGone({ snapshot, preferred: linkTarget, excluded: excludedRef.current })) return;
    setLinkTarget(null);
    setNotice('That call has ended — watch the next one.');
  }, [snapshot, linkTarget]);

  /**
   * Leaving, cancelling and manually joining all have to agree about the
   * exclusion set, so they go through here rather than calling the cockpit
   * directly. A visitor who cancels a connect and is instantly reconnected to
   * the same room by the next poll has a Cancel button that does nothing.
   */
  const leave = (message: string) => {
    const room = joinedRef.current;
    if (room !== null) excludedRef.current.add(room);
    joinedRef.current = null;
    setNotice(message);
    stopObserving();
  };

  /**
   * The one way back into a call this page has retired. Watching, leaving, and
   * changing your mind is an ordinary thing to do, and without this the only
   * remedy would be reloading the page.
   */
  const watch = (room: string) => {
    excludedRef.current.delete(room);
    joinedRef.current = room;
    setNotice(null);
    setArmed(true);
    void startObserving(room);
  };

  /**
   * The gesture that turns a loaded page into a page that is watching.
   *
   * It arms rather than joins, and the two are the same thing whenever a call is
   * already up — the effect above joins on the next render. When nothing is up
   * it is the more interesting case: the visitor has said yes to the next call,
   * which is the whole promise of leaving this URL open, and they have said it
   * before anything started rather than after.
   */
  const arm = () => {
    setNotice(null);
    setArmed(true);
  };

  /*
   * Only ever the calls this page has already retired: anything else was joined
   * the instant it appeared. So the card is not a lobby here, it is the undo for
   * having left one — and it is the same component the hero uses, which means a
   * visitor who has seen one has seen the other.
   */
  const calls: LiveCallEntry[] =
    snapshot !== null && holding
      ? snapshot.rooms.map((room) => ({
          room: room.room,
          entry: room.entry,
          elapsedSeconds: roomElapsedSeconds(room, snapshot, Date.now()),
        }))
      : [];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__mark">
          <Mark />
          Glass <span>Cockpit</span>
        </div>
        <Tabs route="live" />
        <ModeLamp mode={mode} />
        <div className="topbar__spacer" />
        <div className="topbar__actions">
          {mode === 'connecting' ? (
            <button type="button" className="btn btn--quiet" onClick={() => leave('Not joined.')}>
              Cancel
            </button>
          ) : null}
        </div>
      </header>

      {notice !== null && holding ? <p className="notice">{notice}</p> : null}

      {mode === 'observing' ? (
        <ObserverBar
          listening={cockpit.listening}
          onToggle={() => void cockpit.toggleListening()}
          onStop={() => leave('Stopped watching.')}
        />
      ) : null}

      {/* While a named call is still being looked for, the page is neither
          waiting nor asking — it is resolving the link it was opened with, and
          flashing an arm button for the one poll that takes would be noise. */}
      {holding && linkTarget !== null ? (
        <p className="state-note">Looking for that call…</p>
      ) : null}

      {holding && linkTarget === null ? (
        <Holding hasCalls={calls.length > 0} armed={armed} onArm={arm} />
      ) : null}

      {/* Only once armed. Before that the holding screen carries the single
          button, and a per-call card beside it would be a second one competing
          for the same press. Afterwards the card is the manual way back into a
          call this page has already retired. */}
      {holding && armed && linkTarget === null ? (
        <LiveCallCard calls={calls} onWatch={watch} />
      ) : null}

      {mode === 'connecting' ? <p className="state-note">Joining the call…</p> : null}

      {mode === 'observing' ? (
        <CockpitBoard
          state={cockpit.state}
          follow
          /* Transport is the caller's uplink, measured from the microphone they
             publish. An observer publishes nothing; see the note in HomeView. */
          live={false}
          /* Interactive, exactly as on the caller's own session. The token
             behind an observer carries `canPublishData`, so these publish on
             `cockpit-control` down the same path the caller's do — what an
             observer still cannot do is speak, and that is enforced by the
             token rather than by this prop. */
          chaos={{
            request: cockpit.chaosRequest,
            disabled: false,
            note: OBSERVER_CHAOS_NOTE,
            onChange: (patch) => void cockpit.setChaos(patch),
          }}
        />
      ) : null}

      <Footer />
    </div>
  );
}

/**
 * The waiting screen.
 *
 * Calm on purpose. This page is meant to be left open on a second screen, and a
 * page that spends its idle life apologising, spinning or counting down retries
 * is a page nobody leaves open. It says what it is waiting for and that it will
 * handle it, and then it is quiet.
 *
 * The one button here is the consent gesture. An unarmed page with a call
 * already up does not need it — the call's own card carries a "Watch live"
 * button that names which call is being joined, which is the better question to
 * be asked. What this covers is the emptier and more important case: saying yes
 * to a call that has not started yet, deliberately, before it does.
 */
function Holding({
  hasCalls,
  armed,
  onArm,
}: {
  hasCalls: boolean;
  armed: boolean;
  onArm: () => void;
}) {
  return (
    <section className="holding">
      <span className="lamp lamp--idle">Standing by</span>
      <h1 className="holding__title">
        {!hasCalls
          ? 'No live call right now'
          : armed
            ? 'Pick a call to watch'
            : 'A call is live right now'}
      </h1>

      <p className="holding__lede">
        {armed
          ? 'This page joins the next one automatically — leave it open.'
          : /* Not "no controls": the chaos switches work from here. The two
               things that are genuinely withheld are the microphone and, until
               asked for, the sound. */
            'No microphone and audio starts muted — but the chaos switches work from here.'}
      </p>

      {/*
       * One button and no confirmation. It exists because a browser will not
       * unmute audio without a real click and because joining somebody's call
       * the instant a URL loads is not something a page should do on its own —
       * but one press is the entire price, and there is nothing else to dismiss.
       */}
      {!armed ? (
        <button type="button" className="btn btn--primary" onClick={onArm}>
          {hasCalls ? 'Watch the live call' : 'Watch the next call'}
        </button>
      ) : null}
    </section>
  );
}

/**
 * The bar an observer gets instead of a microphone: one switch, for their own
 * speakers.
 *
 * It exists because of what real use turned out to be. The expected watcher was
 * a bystander on another machine; the actual one is the caller themselves,
 * laptop open beside the phone they are talking into. In that arrangement the
 * laptop's speakers feed the phone's microphone, the agent hears its own voice
 * come back, and the instruments end up measuring a call that the act of
 * watching it degraded. So audio is off until asked for, and the caption says
 * why rather than leaving a muted page looking broken.
 *
 * The switch is prominent — filled, first in the bar — because a visitor
 * watching someone ELSE's call has no way to guess that silence was a decision.
 *
 * Purely presentational: it is handed a boolean and two callbacks, so it renders
 * identically in a test and in a browser.
 */

interface ObserverBarProps {
  /** True once the visitor has asked for audio; false is the default. */
  listening: boolean;
  onToggle: () => void;
  onStop: () => void;
}

/**
 * One line, carrying both things a watcher needs: what this page is (a
 * read-only view of somebody's live call) and why it is silent.
 *
 * Deliberately not two lines, and deliberately not a dialog. This is a demo
 * whose whole argument is the instruments, and a visitor who has to dismiss
 * something before seeing them has been charged an entry fee. Candour reads
 * better as a caption than as a barrier — so it sits in the muted caption
 * colour, says the true thing plainly, and gets out of the way.
 *
 * The echo half is kept close to verbatim: "the instruments update either way"
 * is the part that stops a visitor assuming a silent page is a dead one.
 */
const MUTED_NOTE =
  'Read-only view of a live call — audio muted to prevent echo. If this is your own call, keep it muted; the instruments update either way.';

/** The advice inverts once audio is on: the echo may already be happening. */
const LISTENING_NOTE =
  'Read-only view of a live call — audio on. If this is your own call on the phone beside you, mute again.';

export function ObserverBar({ listening, onToggle, onStop }: ObserverBarProps) {
  return (
    <section className="observer-bar" aria-label="Observer session">
      {/* An action label rather than a state label with `aria-pressed`: the two
          spellings contradict each other for a screen reader, and "what will
          this button do" is the more useful of the two answers. */}
      <button
        type="button"
        className={`btn ${listening ? 'btn--quiet' : 'btn--primary'}`}
        onClick={onToggle}
      >
        {listening ? '🔇 Mute audio' : '🔊 Listen'}
      </button>

      {/*
       * Polite, and only because the note is what changes when the button is
       * pressed — a visitor who cannot see the swap still gets told which of
       * the two situations they are now in.
       */}
      <p className="observer-bar__note" aria-live="polite">
        {listening ? LISTENING_NOTE : MUTED_NOTE}
      </p>

      <button type="button" className="btn btn--quiet" onClick={onStop}>
        <span className="wide-only">Stop watching</span>
        <span className="narrow-only">Stop</span>
      </button>
    </section>
  );
}

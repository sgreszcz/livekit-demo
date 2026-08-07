/**
 * "There is a call on the agent right now — watch it."
 *
 * The card appears on the hero without anyone asking for it, which sets two
 * rules. It is a polite live region rather than an alert: a call starting is
 * news, not an emergency, and a screen reader must not be interrupted mid
 * sentence by it. And it wears the green live vocabulary — the same lamp and
 * ping the "On air" indicator uses — because amber and red on this page mean
 * injected chaos and the turns it degrades. A call in progress is the system
 * working.
 *
 * Purely presentational: it is handed elapsed seconds rather than a clock, so it
 * renders identically in a test and in a browser.
 */

import { duration } from '../format';

export interface LiveCallEntry {
  room: string;
  entry: 'sip' | 'browser';
  /** Null when the call's age is unknown — see `roomElapsedSeconds`. */
  elapsedSeconds: number | null;
}

/**
 * "phone" rather than "sip": the visitor knows what a phone is, and the entry
 * point they care about is how the caller reached the agent. Written as a
 * function rather than a lookup table so an entry value that somehow escaped
 * validation prints a word instead of `undefined`.
 */
function entryLabel(entry: LiveCallEntry['entry']): string {
  return entry === 'sip' ? 'phone' : 'browser';
}

interface LiveCallCardProps {
  calls: readonly LiveCallEntry[];
  onWatch: (room: string) => void;
}

export function LiveCallCard({ calls, onWatch }: LiveCallCardProps) {
  // Nothing at all rather than an empty shell: a permanent "no calls" placard
  // above the hero would be a piece of furniture, and the hero is the pitch.
  if (calls.length === 0) return null;

  return (
    <section className="live-calls" aria-live="polite" aria-label="Calls in progress">
      {calls.map((call) => {
        const elapsed = safeSeconds(call.elapsedSeconds);
        return (
          <div key={call.room} className="live-call">
            <span className="lamp lamp--live">Live</span>
            {/* The elapsed clause is dropped rather than defaulted when the age
                is unknown: "0.0s elapsed" on a call that has been running for
                ten minutes is a worse answer than not saying. */}
            <p className="live-call__text">
              Call in progress · {entryLabel(call.entry)}
              {elapsed !== null ? (
                /*
                 * Hidden from the live region, not from the page. The age
                 * changes on every poll, and inside an `aria-live` container
                 * that makes a screen reader re-announce the whole card every
                 * five seconds — the call is news once, its stopwatch is not.
                 * Sighted users keep the figure; assistive ones keep their
                 * sentence.
                 */
                <span aria-hidden="true">
                  {' · '}
                  <span className="num">{duration(elapsed)}</span> elapsed
                </span>
              ) : null}
            </p>
            <button type="button" className="btn btn--primary" onClick={() => onWatch(call.room)}>
              Watch live
            </button>
          </div>
        );
      })}
    </section>
  );
}

/**
 * `duration()` of a NaN prints "NaNs"; no instrument on this page may do that.
 * An unusable figure degrades to "unknown" (null) rather than to zero, so the
 * card stays silent about the age instead of asserting a wrong one.
 */
function safeSeconds(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

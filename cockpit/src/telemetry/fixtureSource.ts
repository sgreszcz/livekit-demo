/**
 * Replays the recorded sample call at its original cadence, so the cockpit can
 * be developed and demonstrated without a live agent. Envelopes are emitted
 * through exactly the same path as a live data-channel message.
 */

import fixture from '../fixtures/sample-call.jsonl?raw';
import type { Envelope } from './schema';
import { parseEnvelopeLines } from './store';

/** Replay runs at double speed: fast enough to hold attention, slow enough to read. */
export const FIXTURE_SPEED = 2;

export const fixtureEnvelopes: Envelope[] = parseEnvelopeLines(fixture);

export interface ReplayHandle {
  cancel: () => void;
}

/**
 * Schedules each envelope at its recorded offset from the first one.
 * A single chained timer would drift; absolute offsets from a fixed start keep
 * the replay honest even if the tab is throttled mid-run.
 */
export function replayFixture(
  onEnvelope: (envelope: Envelope) => void,
  onComplete?: () => void,
  speed = FIXTURE_SPEED,
): ReplayHandle {
  if (fixtureEnvelopes.length === 0) {
    onComplete?.();
    return { cancel: () => {} };
  }

  const origin = fixtureEnvelopes[0].ts;
  const timers = fixtureEnvelopes.map((envelope) =>
    window.setTimeout(
      () => onEnvelope(envelope),
      ((envelope.ts - origin) / speed) * 1000,
    ),
  );

  const last = fixtureEnvelopes[fixtureEnvelopes.length - 1];
  timers.push(
    window.setTimeout(() => onComplete?.(), ((last.ts - origin) / speed) * 1000 + 400),
  );

  return {
    cancel: () => timers.forEach(window.clearTimeout),
  };
}

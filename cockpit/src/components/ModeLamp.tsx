/**
 * The one indicator that says what this browser is doing.
 *
 * Shared between the cockpit and `/live` rather than copied into each: two
 * pages showing the same six states in different words — or worse, in different
 * colours — is how a lamp stops being trusted. Colour is an encoding here like
 * everywhere else: green is on air, violet is watching without being part of it,
 * amber is in transition, red is a fault.
 */

import type { CockpitMode } from '../useCockpit';

const LAMP: Record<CockpitMode, { className: string; label: string }> = {
  idle: { className: 'lamp--idle', label: 'Standby' },
  connecting: { className: 'lamp--warn', label: 'Connecting' },
  live: { className: 'lamp--live', label: 'On air' },
  replay: { className: 'lamp--live', label: 'Replay' },
  // Violet, not the caller's green and not the chaos amber: this browser is on
  // the call but is not part of it, and that is its own state.
  observing: { className: 'lamp--observe', label: 'Observing · read-only' },
  ended: { className: 'lamp--idle', label: 'Call ended' },
  error: { className: 'lamp--fault', label: 'Fault' },
};

export function ModeLamp({ mode }: { mode: CockpitMode }) {
  const lamp = LAMP[mode];
  return <span className={`lamp ${lamp.className}`}>{lamp.label}</span>;
}

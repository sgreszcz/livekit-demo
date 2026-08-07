/**
 * The live-call strip, rendered from a real `/api/active` payload run through
 * the real parser — the card is the last stop for data that started as an
 * untrusted response, so the test starts where the data does.
 *
 * Static markup rather than a DOM: what matters is the wording, the entry-point
 * translation and the two strings no instrument on this page may ever print.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveCallCard, type LiveCallEntry } from './LiveCallCard';
import { parseActiveResponse, roomElapsedSeconds } from '../telemetry/activeRooms';

const FETCHED_AT_MS = 1_700_000_000_000;

/** Exactly the body the Worker documents, sip room first. */
const PAYLOAD = {
  rooms: [
    { room: 'sip-cockpit-abc123', entry: 'sip', num_participants: 2, created_at: 1723000000 },
    { room: 'cockpit-demo01', entry: 'browser', num_participants: 2, created_at: 1723000030 },
  ],
  generated_at: 1723000042.5,
  degraded: false,
};

function entriesFrom(payload: unknown, nowMs = FETCHED_AT_MS): LiveCallEntry[] {
  const snapshot = parseActiveResponse(payload, FETCHED_AT_MS);
  if (snapshot === null) return [];
  return snapshot.rooms.map((room) => ({
    room: room.room,
    entry: room.entry,
    elapsedSeconds: roomElapsedSeconds(room, snapshot, nowMs),
  }));
}

const render = (calls: LiveCallEntry[]) =>
  renderToStaticMarkup(<LiveCallCard calls={calls} onWatch={() => {}} />);

/** Whatever a visitor is handed, these two strings must never reach the page. */
function assertRenders(markup: string): void {
  expect(markup).not.toContain('undefined');
  expect(markup).not.toContain('NaN');
}

describe('LiveCallCard', () => {
  it('announces each call in progress with its age and a way in', () => {
    const markup = render(entriesFrom(PAYLOAD));
    assertRenders(markup);

    expect(markup).toContain('Live');
    expect(markup).toContain('Call in progress');
    expect(markup).toContain('42.5s'); // the sip room, server-anchored
    expect(markup).toContain('12.5s'); // the browser room
    expect(markup.match(/Watch live/g) ?? []).toHaveLength(2);
  });

  it('says "phone" for a SIP call and "browser" for a browser one', () => {
    // "sip" is the wire's word for it; nobody dials a SIP.
    expect(render(entriesFrom(PAYLOAD))).toContain('phone');
    expect(render(entriesFrom(PAYLOAD))).toContain('browser');
    expect(render(entriesFrom(PAYLOAD))).not.toContain('sip ·');
  });

  it('wears the live lamp rather than a fault colour', () => {
    // A call in progress is the system working: green and the ping, never amber.
    const markup = render(entriesFrom(PAYLOAD));
    expect(markup).toContain('lamp lamp--live');
    expect(markup).not.toContain('lamp--warn');
    expect(markup).not.toContain('lamp--fault');
  });

  it('is a polite live region, because it appears without being asked for', () => {
    expect(render(entriesFrom(PAYLOAD))).toContain('aria-live="polite"');
  });

  it('renders nothing at all when no call is in progress', () => {
    expect(render([])).toBe('');
    expect(render(entriesFrom({ rooms: [], generated_at: 1, degraded: true }))).toBe('');
    // A payload the parser rejected outright is the same absence of news.
    expect(render(entriesFrom('not a payload'))).toBe('');
  });

  it('prints a duration rather than NaN for a room with a nonsense age', () => {
    const markup = render(
      entriesFrom({
        rooms: [{ room: 'cockpit-x', entry: 'browser', num_participants: 1, created_at: 1723009999 }],
        generated_at: 1723000000,
        degraded: false,
      }),
    );
    assertRenders(markup);
    expect(markup).toContain('0.0s');
  });

  /*
   * `created_at: 0` is the Worker's sentinel for "LiveKit reported no creation
   * time", not a timestamp. Taken literally it is midnight 1970, and this card
   * would invite a visitor to watch a call that had been running since before
   * the agent existed.
   */
  it('still offers the call but says nothing about its age when the age is unknown', () => {
    const markup = render(
      entriesFrom({
        rooms: [{ room: 'cockpit-x', entry: 'browser', num_participants: 1, created_at: 0 }],
        generated_at: 1723000042.5,
        degraded: false,
      }),
    );

    assertRenders(markup);
    // The call is watchable — a missing timestamp is no reason to hide it.
    expect(markup).toContain('Call in progress');
    expect(markup).toContain('Watch live');
    // But it claims no age at all, rather than 55 years or a false zero.
    expect(markup).not.toContain('elapsed');
    expect(markup).not.toMatch(/\d+m \d+s/);
  });

  it('drops a room the Worker would refuse a token for before offering to watch it', () => {
    const markup = render(
      entriesFrom({
        rooms: [
          { room: 'lobby', entry: 'browser', num_participants: 1, created_at: 1723000000 },
          PAYLOAD.rooms[0],
        ],
        generated_at: PAYLOAD.generated_at,
        degraded: false,
      }),
    );
    assertRenders(markup);
    expect(markup).not.toContain('lobby');
    expect(markup.match(/Watch live/g) ?? []).toHaveLength(1);
  });
});

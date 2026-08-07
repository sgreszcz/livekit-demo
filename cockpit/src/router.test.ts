/**
 * Route parsing.
 *
 * Small, but it decides what a pasted link opens, and the Worker serves
 * index.html for every path — so anything this function does not recognise
 * silently becomes the cockpit rather than a 404. That makes the negative cases
 * the interesting ones: `/dashboards` and `/dashboard/extra` must not quietly
 * render the fleet page, or the SPA fallback turns typos into wrong answers.
 */

import { describe, expect, it } from 'vitest';
import { parseRoute } from './router';

describe('parseRoute', () => {
  it('reads the cockpit at the root', () => {
    expect(parseRoute('/')).toEqual({ kind: 'home' });
  });

  it('reads the dashboard, with or without a trailing slash', () => {
    expect(parseRoute('/dashboard')).toEqual({ kind: 'dashboard' });
    expect(parseRoute('/dashboard/')).toEqual({ kind: 'dashboard' });
  });

  it('reads a stored debrief and keeps its id', () => {
    expect(parseRoute('/call/k7Qx2f')).toEqual({ kind: 'debrief', id: 'k7Qx2f' });
  });

  it('falls back to the cockpit for anything it does not recognise', () => {
    for (const path of [
      '/dashboards',
      '/dashboard/extra',
      '/Dashboard',
      '/dash',
      '/dashboard?x=1', // a query is not part of the pathname; this is a typo
      '/call/',
      '/call/not-base62!',
      '/lives',
      '/live/extra',
      '/Live',
      '',
    ]) {
      expect(parseRoute(path)).toEqual({ kind: 'home' });
    }
  });

  it('does not mistake a debrief whose id spells dashboard', () => {
    expect(parseRoute('/call/dashboard')).toEqual({ kind: 'debrief', id: 'dashboard' });
  });
});

/**
 * `/live` and the room it may name.
 *
 * The query is the interesting half. A room name arrives from a link anyone can
 * edit and is handed more or less straight to `/api/token`, so the same gate the
 * room list applies is applied here — a name that fails it becomes null, which
 * is the ordinary "watch the newest call" behaviour rather than an error. The
 * page must never be left holding a room name it cannot use.
 */
describe('parseRoute — /live', () => {
  it('reads the live page, with or without a trailing slash', () => {
    expect(parseRoute('/live')).toEqual({ kind: 'live', room: null });
    expect(parseRoute('/live/')).toEqual({ kind: 'live', room: null });
  });

  it('keeps a room the link names', () => {
    expect(parseRoute('/live', '?room=cockpit-demo01')).toEqual({
      kind: 'live',
      room: 'cockpit-demo01',
    });
  });

  /**
   * The case the whole feature exists for, and the one a query parser gets
   * wrong by default: SIP dispatch puts the caller's number in the room name,
   * and `URLSearchParams` reads a literal `+` as a space because that is what
   * form-encoding means. Both spellings have to arrive at the same room — the
   * escaped one is what this app generates, the literal one is what survives
   * being retyped or passed through a link scrubber.
   */
  it('keeps a SIP room name however the + was spelled', () => {
    // Ofcom's drama range — see the note in activeRooms.test.ts.
    const room = 'sip-cockpit-_+447700900123_5xzppVvwo6Px';

    // As this app writes it: encodeURIComponent turns `+` into `%2B`.
    expect(parseRoute('/live', `?room=${encodeURIComponent(room)}`)).toEqual({
      kind: 'live',
      room,
    });

    // As a human pastes it, with the `+` left literal.
    expect(parseRoute('/live', `?room=${room}`)).toEqual({ kind: 'live', room });
  });

  it('still refuses a space that was deliberately encoded', () => {
    // `%20` is somebody asking for a space, which is not a legal room
    // character. Reading `+` as itself must not quietly rewrite this one too.
    expect(parseRoute('/live', '?room=cockpit-demo01%20extra')).toEqual({
      kind: 'live',
      room: null,
    });
  });

  it('reads nothing from a malformed escape rather than throwing', () => {
    // A pasted link is routinely mangled; `decodeURIComponent` throws on this.
    expect(parseRoute('/live', '?room=cockpit-%zz')).toEqual({ kind: 'live', room: null });
  });

  it('ignores other parameters beside the room', () => {
    expect(parseRoute('/live', '?utm_source=text&room=cockpit-demo01')).toEqual({
      kind: 'live',
      room: 'cockpit-demo01',
    });
  });

  it('drops a room name the Worker would refuse, rather than joining nothing', () => {
    for (const query of [
      '?room=lobby', // not a cockpit room
      '?room=', // present and empty
      '?room=../../etc/passwd',
      '?room=<script>',
      `?room=cockpit-${'x'.repeat(200)}`, // past the length the gate allows
      '?nothing=here',
      '',
    ]) {
      expect(parseRoute('/live', query)).toEqual({ kind: 'live', room: null });
    }
  });

  it('reads the room only on /live — a query elsewhere is not a route', () => {
    expect(parseRoute('/', '?room=cockpit-demo01')).toEqual({ kind: 'home' });
    expect(parseRoute('/dashboard', '?room=cockpit-demo01')).toEqual({ kind: 'dashboard' });
  });
});

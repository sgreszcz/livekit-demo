/**
 * What `/live` joins, and — more to the point — what it refuses to join.
 *
 * Every failure mode of this page is a false positive rather than a false
 * negative: joining without being asked, rejoining what the visitor just left,
 * retrying a room that refused, or joining a second call while already watching
 * one. A page that waits too long is merely a page that waits.
 */

import { describe, expect, it } from 'vitest';
import { autoJoinTarget, linkRoomGone } from './liveJoin';
import type { ActiveSnapshot } from '../telemetry/activeRooms';
import type { CockpitMode } from '../useCockpit';

/** A snapshot of the shape `/api/active` produces, named rooms and ages only. */
function snapshot(rooms: [name: string, createdAt: number][]): ActiveSnapshot {
  return {
    rooms: rooms.map(([room, createdAt]) => ({
      room,
      entry: 'sip' as const,
      numParticipants: 2,
      createdAt,
    })),
    generatedAt: 1_786_098_358,
    degraded: false,
    fetchedAtMs: 1_786_098_358_000,
  };
}

/** Armed and idle — the state in which joining is actually on the table. */
function ask(overrides: Partial<Parameters<typeof autoJoinTarget>[0]> = {}) {
  return autoJoinTarget({
    mode: 'idle',
    snapshot: snapshot([['cockpit-demo01', 100]]),
    preferred: null,
    excluded: new Set<string>(),
    armed: true,
    ...overrides,
  });
}

describe('autoJoinTarget — consent', () => {
  it('joins nothing at all until the page has been armed', () => {
    // Loading a URL is not asking to watch a stranger's phone call. The holding
    // screen's button is what turns a visit into a request.
    expect(ask({ armed: false })).toBeNull();
  });

  it('stays unarmed however many calls are up', () => {
    expect(
      ask({
        armed: false,
        snapshot: snapshot([
          ['cockpit-demo01', 100],
          ['cockpit-demo02', 900],
        ]),
      }),
    ).toBeNull();
  });

  it('joins once armed', () => {
    expect(ask({ armed: true })).toBe('cockpit-demo01');
  });

  it('treats a named link as its own authorisation, for that one call', () => {
    // The exception, and the reason it is safe: this URL was composed for a
    // specific call and handed to someone deliberately. It licenses that call
    // and nothing else — see the dead-link tests below.
    expect(
      ask({
        armed: false,
        preferred: 'cockpit-mine',
        snapshot: snapshot([
          ['cockpit-mine', 100],
          ['cockpit-someone-else', 900],
        ]),
      }),
    ).toBe('cockpit-mine');
  });
});

describe('autoJoinTarget — which call', () => {
  it('takes the newest call when the link names none', () => {
    expect(
      ask({
        snapshot: snapshot([
          ['cockpit-old', 100],
          ['cockpit-newest', 900],
          ['cockpit-middle', 500],
        ]),
      }),
    ).toBe('cockpit-newest');
  });

  it('takes the room the link names, even when another is newer', () => {
    // The whole point of `?room=`: "watch MY call", not "watch a call".
    expect(
      ask({
        preferred: 'cockpit-mine',
        snapshot: snapshot([
          ['cockpit-mine', 100],
          ['cockpit-someone-else', 900],
        ]),
      }),
    ).toBe('cockpit-mine');
  });

  it('joins NOTHING when the named room has already hung up', () => {
    // The load-bearing refusal. Someone handed this link was pointed at one
    // call; substituting whoever else is on the agent is surprising, and it
    // quietly widens what the link's gesture consented to. The page says the
    // call has ended and offers to watch the next one instead.
    expect(
      ask({
        preferred: 'cockpit-gone',
        snapshot: snapshot([
          ['cockpit-old', 100],
          ['cockpit-newest', 900],
        ]),
      }),
    ).toBeNull();
  });

  it('will not substitute even for an armed page', () => {
    // Arming is permission to watch whatever is live; it is not permission to
    // reinterpret which call a link meant.
    expect(
      ask({
        armed: true,
        preferred: 'cockpit-gone',
        snapshot: snapshot([['cockpit-newest', 900]]),
      }),
    ).toBeNull();
  });

  it('does not let an unknown creation time claim to be the newest', () => {
    // The Worker encodes "LiveKit did not say" as 0. Read as a date that is
    // 1970, which is the right way round — it must not win a newest-first race,
    // and it must still be joinable when it is all there is.
    expect(
      ask({
        snapshot: snapshot([
          ['cockpit-unknown-age', 0],
          ['cockpit-known', 100],
        ]),
      }),
    ).toBe('cockpit-known');
    expect(ask({ snapshot: snapshot([['cockpit-unknown-age', 0]]) })).toBe('cockpit-unknown-age');
  });

  it('is stable when two calls report the same age', () => {
    expect(
      ask({
        snapshot: snapshot([
          ['cockpit-first', 500],
          ['cockpit-second', 500],
        ]),
      }),
    ).toBe('cockpit-first');
  });
});

describe('autoJoinTarget — what it will not rejoin', () => {
  it('never rejoins a call this page has left', () => {
    // `/api/active` is polled every five seconds, so the call just left is
    // still listed. Without this, Stop watching would undo itself.
    expect(ask({ excluded: new Set(['cockpit-demo01']) })).toBeNull();
  });

  it('moves on to the next call rather than to the one it left', () => {
    expect(
      ask({
        snapshot: snapshot([
          ['cockpit-left', 900],
          ['cockpit-other', 100],
        ]),
        excluded: new Set(['cockpit-left']),
      }),
    ).toBe('cockpit-other');
  });

  it('does not keep retrying a named room that refused it', () => {
    // The failure path adds the room to the exclusion set. A page that retried
    // would hammer `/api/token` for as long as the tab stayed open.
    expect(
      ask({
        preferred: 'cockpit-refused',
        snapshot: snapshot([['cockpit-refused', 900]]),
        excluded: new Set(['cockpit-refused']),
      }),
    ).toBeNull();
  });

  it('does not substitute another call when the named one refused', () => {
    expect(
      ask({
        preferred: 'cockpit-refused',
        snapshot: snapshot([
          ['cockpit-refused', 900],
          ['cockpit-fine', 100],
        ]),
        excluded: new Set(['cockpit-refused']),
      }),
    ).toBeNull();
  });
});

describe('autoJoinTarget — when it will not act at all', () => {
  it('waits when there is no snapshot to act on', () => {
    // A failed or degraded poll is an absence of information, not an absence of
    // calls, and the page keeps polling.
    expect(ask({ snapshot: null })).toBeNull();
  });

  it('waits when the agent has no calls on it', () => {
    expect(ask({ snapshot: snapshot([]) })).toBeNull();
  });

  it('keeps its hands off unless the cockpit is idle', () => {
    // Joining while connecting abandons a room mid-handshake; joining while
    // observing tears down the call the visitor is watching in order to rejoin
    // it. Both are worse than doing nothing.
    const busy: CockpitMode[] = ['connecting', 'live', 'replay', 'observing', 'ended', 'error'];
    for (const mode of busy) {
      expect(ask({ mode })).toBeNull();
    }
    expect(ask({ mode: 'idle' })).toBe('cockpit-demo01');
  });
});

/**
 * When the link's call is over.
 *
 * `autoJoinTarget` refuses to substitute a different call; this is how the page
 * learns to stop waiting for the one it was sent to. Getting this wrong in the
 * cautious direction strands a visitor on a holding screen forever; getting it
 * wrong in the eager direction abandons a live call because one poll failed.
 */
describe('linkRoomGone', () => {
  const gone = (overrides: Parameters<typeof linkRoomGone>[0]) => linkRoomGone(overrides);

  it('says nothing is gone on a bare /live, which named no call', () => {
    expect(
      gone({ snapshot: snapshot([['cockpit-a', 1]]), preferred: null, excluded: new Set() }),
    ).toBe(false);
  });

  it('waits while the named call is still up', () => {
    expect(
      gone({
        snapshot: snapshot([
          ['cockpit-mine', 100],
          ['cockpit-other', 900],
        ]),
        preferred: 'cockpit-mine',
        excluded: new Set(),
      }),
    ).toBe(false);
  });

  it('reports it gone once a snapshot arrives without it', () => {
    expect(
      gone({
        snapshot: snapshot([['cockpit-other', 900]]),
        preferred: 'cockpit-mine',
        excluded: new Set(),
      }),
    ).toBe(true);
  });

  it('reports it gone when the agent has no calls at all', () => {
    expect(gone({ snapshot: snapshot([]), preferred: 'cockpit-mine', excluded: new Set() })).toBe(
      true,
    );
  });

  it('does not treat a failed poll as evidence the call ended', () => {
    // A null snapshot is an absence of information, not information about an
    // absence. Treating it as proof would abandon a live call because one
    // request timed out on a phone.
    expect(gone({ snapshot: null, preferred: 'cockpit-mine', excluded: new Set() })).toBe(false);
  });

  it('reports it gone once this page is finished with it', () => {
    // Watched and left, or refused: the link has been spent either way, and the
    // page must not sit waiting for a call it has already had.
    expect(
      gone({
        snapshot: snapshot([['cockpit-mine', 100]]),
        preferred: 'cockpit-mine',
        excluded: new Set(['cockpit-mine']),
      }),
    ).toBe(true);
  });
});

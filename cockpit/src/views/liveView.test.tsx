/**
 * The `/live` holding screen, rendered.
 *
 * `autoJoinTarget` covers what the page decides; this covers what it says while
 * it has decided nothing. Rendered to static markup rather than a DOM, like the
 * other component tests here: no effect runs, which is exactly the state under
 * test — a page that has just loaded and has not yet been given permission to
 * join anything.
 *
 * The load-bearing assertion is the negative one. On first paint a bare `/live`
 * must be offering to watch rather than watching, because the alternative is a
 * URL that joins a stranger's phone call for anyone who opens it.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveView } from './LiveView';

/** Whatever a visitor is handed, these two strings must never reach the page. */
function assertRenders(markup: string): void {
  expect(markup).not.toContain('undefined');
  expect(markup).not.toContain('NaN');
}

describe('LiveView — holding state', () => {
  it('waits, and says what it is waiting for', () => {
    const markup = renderToStaticMarkup(<LiveView room={null} />);
    assertRenders(markup);
    expect(markup).toContain('No live call right now');
    expect(markup).toContain('Standing by');
  });

  it('asks before watching anything, rather than joining on load', () => {
    const markup = renderToStaticMarkup(<LiveView room={null} />);
    // The gesture, as the visitor meets it.
    expect(markup).toContain('Watch the next call');
    // And nothing is being observed yet: no instruments, no audio bar.
    expect(markup).not.toContain('observer-bar');
    expect(markup).not.toContain('Observing · read-only');
  });

  it('asks exactly once, with one button and nothing to dismiss', () => {
    // A demo may charge a visitor one press for a browser's autoplay policy.
    // It may not charge them a dialog, a checkbox or an acknowledgement.
    const markup = renderToStaticMarkup(<LiveView room={null} />);
    expect(markup.match(/<button/g) ?? []).toHaveLength(1);
    for (const friction of ['type="checkbox"', 'role="dialog"', 'I agree', 'I understand']) {
      expect(markup).not.toContain(friction);
    }
  });

  it('says what the page is in one calm line, claiming nothing untrue', () => {
    const markup = renderToStaticMarkup(<LiveView room={null} />);
    expect(markup).toContain('Read-only view');
    // The spoken greeting says no such thing, so neither may the page.
    expect(markup).not.toContain('told at the start');
  });

  it('does not ask again when the link already named a call', () => {
    // A `?room=` URL was composed for one call and handed over deliberately;
    // that is the gesture, and re-asking for it would be ceremony.
    const markup = renderToStaticMarkup(<LiveView room="cockpit-demo01" />);
    assertRenders(markup);
    expect(markup).not.toContain('Watch the next call');
    expect(markup).not.toContain('Watch the live call');
  });

  it('resolves a named link quietly rather than flashing a button at it', () => {
    // A `?room=` page is neither waiting nor asking for the one poll it takes
    // to find the call — showing the holding screen's button in that window
    // would be a control that appears and vanishes on its own.
    const markup = renderToStaticMarkup(<LiveView room="cockpit-demo01" />);
    expect(markup).toContain('Looking for that call');
    expect(markup).not.toContain('No live call right now');
    expect(markup.match(/<button/g) ?? []).toHaveLength(0);
  });

  it('lights the cockpit tab rather than leaving the bar with nothing current', () => {
    const markup = renderToStaticMarkup(<LiveView room={null} />);
    expect(markup).toContain('aria-current="page"');
  });
});

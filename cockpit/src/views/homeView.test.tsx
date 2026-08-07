/**
 * The hero, and the one quiet sentence it owes a caller.
 *
 * The spoken greeting does not mention that a call can be watched, so this page
 * is the only place it is said — which makes the placement and the tone the
 * whole design. It sits beside the phone number, in the caption colour, next to
 * the decision it is relevant to. It is not a banner, not an interstitial and
 * not a thing to dismiss: this is a demo whose argument is the instruments, and
 * a visitor who has to clear something before seeing them has been charged an
 * entry fee.
 *
 * Rendered to static markup, so no effect runs — the state under test is the
 * first paint a recruiter or a hiring manager actually meets.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeView } from './HomeView';

describe('HomeView — the hero', () => {
  const markup = () => renderToStaticMarkup(<HomeView />);

  it('renders the pitch without printing an unusable figure', () => {
    const page = markup();
    expect(page).not.toContain('undefined');
    expect(page).not.toContain('NaN');
    expect(page).toContain('Glass Cockpit');
  });

  it('tells a caller what a demo call means, beside the number they would dial', () => {
    const page = markup();
    expect(page).toContain('Calls are demo calls');
    expect(page).toContain('telemetry from every call is public');
    expect(page).toContain('can be watched live from this page');
  });

  it('says it in the caption colour rather than as a warning', () => {
    // Amber and red on this page mean injected chaos and the turns it degrades.
    // Borrowing either here would turn candour into an alarm about a phone
    // number, and would cost those colours the meaning they are spent on.
    const page = markup();
    expect(page).toContain('placard__foot--note');
    expect(page).not.toContain('notice--warn');
  });

  it('puts nothing between the visitor and the instruments', () => {
    const page = markup();
    for (const friction of ['type="checkbox"', 'role="dialog"', 'I agree', 'I understand']) {
      expect(page).not.toContain(friction);
    }
  });
});

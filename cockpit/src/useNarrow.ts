import { useEffect, useState } from 'react';

/** Phone width. Kept in step with the `max-width: 640px` block in styles.css. */
export const NARROW_QUERY = '(max-width: 640px)';

/**
 * True on a phone-width viewport.
 *
 * Some of the phone layout is structural rather than cosmetic — a panel that
 * becomes a native `<details>` disclosure is a different element, not a
 * restyled one, and CSS cannot open or close one. So that decision is made
 * here, against the same breakpoint the stylesheet uses.
 *
 * Starts false and corrects itself on mount: static rendering (and the tests
 * that use it) has no `matchMedia`, and the wide layout is the safe default.
 */
export function useNarrow(query: string = NARROW_QUERY): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const media = window.matchMedia(query);
    const sync = () => setNarrow(media.matches);

    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [query]);

  return narrow;
}

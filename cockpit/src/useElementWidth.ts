import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How long a stream of resize notifications must go quiet before the width is
 * believed.
 *
 * A dragged window edge fires `ResizeObserver` on essentially every frame, and
 * the consumer of this width is the waterfall — which rebuilds its whole SVG,
 * every row and every axis tick, for each new value. Without this, the cost of
 * one drag is the chart's node count multiplied by the frame rate, which is how
 * an instrument panel comes to be the reason a laptop's fan spins up.
 *
 * Short enough to feel immediate on release, long enough to swallow a drag.
 */
const SETTLE_MS = 120;

/**
 * Tracks an element's content width so SVG charts can be drawn in real pixels
 * rather than a distorted viewBox — text and hairlines have to stay true.
 *
 * Returns a callback ref rather than an object ref: the measured node can be
 * swapped out as the tree re-renders, and observation has to follow it.
 *
 * The first measurement is synchronous and the rest are debounced. That split
 * matters: a chart that waited 120 ms for its initial width would render once at
 * zero and visibly snap, whereas one that redraws 120 ms after a resize settles
 * simply looks like it kept up.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The last value handed to React. Compared before scheduling anything,
   * because `ResizeObserver` fires for a height change too — and a taller chart
   * at the same width has nothing to redraw.
   */
  const latest = useRef(0);

  const clearTimer = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  };

  const teardown = useCallback(() => {
    clearTimer();
    observer.current?.disconnect();
    observer.current = null;
  }, []);

  const measuredRef = useCallback(
    (node: T | null) => {
      teardown();
      if (!node) return;

      observer.current = new ResizeObserver(([entry]) => {
        const next = entry.contentRect.width;
        if (next === latest.current) return;
        clearTimer();
        timer.current = setTimeout(() => {
          timer.current = null;
          latest.current = next;
          setWidth(next);
        }, SETTLE_MS);
      });
      observer.current.observe(node);

      // Immediately, and without the debounce: this is the measurement the
      // first paint depends on.
      const initial = node.getBoundingClientRect().width;
      latest.current = initial;
      setWidth(initial);
    },
    [teardown],
  );

  useEffect(() => teardown, [teardown]);

  return [measuredRef, width];
}

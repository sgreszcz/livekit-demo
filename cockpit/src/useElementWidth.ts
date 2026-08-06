import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks an element's content width so SVG charts can be drawn in real pixels
 * rather than a distorted viewBox — text and hairlines have to stay true.
 *
 * Returns a callback ref rather than an object ref: the measured node can be
 * swapped out as the tree re-renders, and observation has to follow it.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const measuredRef = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) return;

    observer.current = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.current.observe(node);
    setWidth(node.getBoundingClientRect().width);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return [measuredRef, width];
}

import type { ReactNode } from 'react';
import { useNarrow } from '../useNarrow';

interface PanelProps {
  legend: string;
  aside?: ReactNode;
  /**
   * Reference material rather than instrumentation. On a phone these fold into
   * a closed `<details>` so the cockpit itself is not buried under a five-
   * thousand-pixel stack; on anything wider they are ordinary panels.
   */
  collapsible?: boolean;
  /**
   * Lets a long readout wrap onto a second line instead of being truncated.
   *
   * The default is one nowrap line with an ellipsis, which is right for a short
   * figure and wrong for a summary of five: "median 940 ms · p95 1,810…" is
   * strictly worse than no readout at all, because it looks complete.
   */
  asideWrap?: boolean;
  children: ReactNode;
}

/** A bezelled instrument face: stencilled legend, optional right-hand readout. */
export function Panel({
  legend,
  aside,
  collapsible = false,
  asideWrap = false,
  children,
}: PanelProps) {
  const narrow = useNarrow();
  const asideClass = `panel__aside num${asideWrap ? ' panel__aside--wrap' : ''}`;

  if (collapsible && narrow) {
    return (
      <details className="panel panel--fold">
        {/* `summary` takes phrasing content, so the legend is a span here. */}
        <summary className="panel__head">
          <span className="legend">{legend}</span>
          {aside ? <span className={asideClass}>{aside}</span> : null}
        </summary>
        {children}
      </details>
    );
  }

  return (
    <section className="panel">
      <header className="panel__head">
        <h2 className="legend">{legend}</h2>
        {aside ? <div className={asideClass}>{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

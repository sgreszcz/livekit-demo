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
  children: ReactNode;
}

/** A bezelled instrument face: stencilled legend, optional right-hand readout. */
export function Panel({ legend, aside, collapsible = false, children }: PanelProps) {
  const narrow = useNarrow();

  if (collapsible && narrow) {
    return (
      <details className="panel panel--fold">
        {/* `summary` takes phrasing content, so the legend is a span here. */}
        <summary className="panel__head">
          <span className="legend">{legend}</span>
          {aside ? <span className="panel__aside num">{aside}</span> : null}
        </summary>
        {children}
      </details>
    );
  }

  return (
    <section className="panel">
      <header className="panel__head">
        <h2 className="legend">{legend}</h2>
        {aside ? <div className="panel__aside num">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

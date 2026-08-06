/**
 * A thumbnail of the waterfall for the hero: one thin bar per measured turn,
 * against the same one-second rule the full instrument draws.
 *
 * Purely presentational. It is handed figures already derived from the bundled
 * fixture and owns no data flow of its own — the point is that the front page
 * shows the product's actual output above the fold, not a picture of it.
 *
 * Widths are percentages rather than measured pixels: this drawing carries no
 * text of its own, so it can scale with its column without a ResizeObserver.
 */

import { LATENCY_BUDGET_SECONDS } from '../telemetry/store';

export interface MiniBar {
  seconds: number;
  degraded: boolean;
}

const BAR_HEIGHT = 5;
const BAR_GAP = 4;
/** Headroom so the worst turn does not run flush to the right edge. */
const SCALE_HEADROOM = 1.12;

function fill(bar: MiniBar): string {
  if (bar.degraded) return 'var(--alarm)';
  return bar.seconds > LATENCY_BUDGET_SECONDS ? 'var(--amber)' : 'var(--accent)';
}

export function MiniWaterfall({ bars }: { bars: MiniBar[] }) {
  if (bars.length === 0) return null;

  const longest = bars.reduce((max, bar) => Math.max(max, bar.seconds), 0);
  const scale = Math.max(longest, LATENCY_BUDGET_SECONDS) * SCALE_HEADROOM;
  const budgetPercent = (LATENCY_BUDGET_SECONDS / scale) * 100;
  const height = bars.length * (BAR_HEIGHT + BAR_GAP) - BAR_GAP;
  const over = bars.filter((bar) => bar.seconds > LATENCY_BUDGET_SECONDS).length;

  return (
    <div className="mini">
      <svg
        className="mini__svg"
        width="100%"
        height={height}
        role="img"
        aria-label={
          `${bars.length} recorded turns against the ${LATENCY_BUDGET_SECONDS.toFixed(1)} second ` +
          `response budget; ${over} exceed it`
        }
      >
        <rect
          className="wf-overrun"
          x={`${budgetPercent}%`}
          y={0}
          width={`${100 - budgetPercent}%`}
          height={height}
        />
        {bars.map((bar, index) => (
          <rect
            key={index}
            x={0}
            y={index * (BAR_HEIGHT + BAR_GAP)}
            width={`${Math.max((bar.seconds / scale) * 100, 1)}%`}
            height={BAR_HEIGHT}
            rx={1.5}
            fill={fill(bar)}
          />
        ))}
        <line
          className="wf-budget-rule"
          x1={`${budgetPercent}%`}
          x2={`${budgetPercent}%`}
          y1={0}
          y2={height}
        />
      </svg>

      <div className="mini__foot">
        <span>{bars.length} turns</span>
        <span>{LATENCY_BUDGET_SECONDS.toFixed(1)} s budget</span>
      </div>
    </div>
  );
}

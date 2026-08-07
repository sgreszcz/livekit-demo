/**
 * The caller's own network path — the one part of the call the agent cannot see
 * and therefore cannot report.
 *
 * Every figure here is sampled in this browser from the WebRTC stats of the
 * microphone track we are publishing, so they describe the *uplink*: how long a
 * packet takes to get to LiveKit and back, how unevenly they arrive, and how
 * many never did. That is the leg that decides whether the agent hears a clean
 * utterance, which is why it belongs next to the latency waterfall rather than
 * buried in a debug view.
 *
 * All three figures are optional at every sample. A muted microphone sends no
 * packets to lose, a reconnecting transport has no report to give, and a future
 * SDK may not offer the numbers at all — so the panel is built to render from
 * whatever subset arrived, down to the quality verdict alone.
 */

import type { TransportQuality } from '../telemetry/schema';
import type { TransportSample } from '../telemetry/store';
import { integer } from '../format';

/** How much history a sparkline shows: two minutes at one sample per 2 s. */
const SPARK_WINDOW = 60;

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 24;
/** Keeps the stroke inside the box instead of clipping it at the extremes. */
const SPARK_PAD = 2.5;

const MISSING = '—';

/**
 * The lamp reuses the shell's status-lamp language rather than inventing a
 * second vocabulary for "things that are fine and things that are not".
 *
 * Amber and red are otherwise reserved for injected chaos, and this is the one
 * other place they are earned: a lost transport is a genuine fault readout, in
 * the same class as the topbar's existing fault lamp — not decoration, and not
 * a borrowed hue. Excellent and good share green because the SDK's distinction
 * between them is not one a caller can hear.
 */
const QUALITY_LAMP: Record<TransportQuality, { className: string; label: string }> = {
  excellent: { className: 'lamp--ok', label: 'Excellent' },
  good: { className: 'lamp--ok', label: 'Good' },
  poor: { className: 'lamp--warn', label: 'Poor' },
  lost: { className: 'lamp--fault', label: 'Lost' },
  unknown: { className: 'lamp--idle', label: 'Unknown' },
};

export function TransportLamp({ quality }: { quality: TransportQuality }) {
  const lamp = QUALITY_LAMP[quality] ?? QUALITY_LAMP.unknown;
  return <span className={`lamp ${lamp.className}`}>{lamp.label}</span>;
}

interface TransportPanelProps {
  samples: readonly TransportSample[];
  /**
   * True only for a call this browser is currently on. A replay or a stored
   * debrief is a recording: if it carries no transport samples, it never will,
   * and saying "sampling…" at it forever would be a lie.
   */
  live: boolean;
}

export function TransportPanel({ samples, live }: TransportPanelProps) {
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  if (!latest) {
    return (
      <p className="wf-empty">
        {live
          ? 'Measuring the connection — the first reading lands a couple of seconds in.'
          : 'Not recorded on this call. Transport is sampled in the caller’s browser, so phone ' +
            'calls and recordings made without it carry none.'}
      </p>
    );
  }

  const window = samples.slice(-SPARK_WINDOW);

  return (
    <div>
      <div className="ledger ledger--three">
        <Tile
          label="Round trip"
          value={latest.rttMs !== undefined ? integer(latest.rttMs) : MISSING}
          unit="ms"
          series={window.map((sample) => sample.rttMs)}
        />
        <Tile
          label="Jitter"
          value={latest.jitterMs !== undefined ? latest.jitterMs.toFixed(1) : MISSING}
          unit="ms"
          series={window.map((sample) => sample.jitterMs)}
        />
        <Tile
          label="Loss"
          value={latest.lossPct !== undefined ? latest.lossPct.toFixed(1) : MISSING}
          unit="%"
          series={window.map((sample) => sample.lossPct)}
        />
      </div>

      <p className="ledger__caveat">
        Measured in this browser every 2 s on the microphone we publish, so these describe the
        caller’s uplink to LiveKit — not the agent’s. Never sent to the agent; kept only in this
        call’s recording.
      </p>
    </div>
  );
}

interface TileProps {
  label: string;
  value: string;
  unit: string;
  /** One entry per sample in the window; `undefined` where nothing was read. */
  series: (number | undefined)[];
}

function Tile({ label, value, unit, series }: TileProps) {
  return (
    <div className="ledger__cell">
      <div className="ledger__label">{label}</div>
      <div className="ledger__value ledger__value--tight num">
        {value}
        <small>{unit}</small>
      </div>
      <Sparkline series={series} />
    </div>
  );
}

/**
 * Builds the polyline, or null when there is not yet enough to draw a line.
 *
 * Two things this deliberately does *not* do. It does not close the y-axis at
 * zero: a sparkline is read for its shape, the figure beside it carries the
 * magnitude, and zero-anchoring a round-trip time that lives between 40 and
 * 48 ms draws a flat line that hides every change worth seeing. And it does not
 * compact away the gaps — a sample that read no value keeps its slot on the x
 * axis, so the line bridges the gap rather than sliding later readings earlier
 * in time.
 */
function sparkPoints(series: (number | undefined)[]): string | null {
  const points: { value: number; index: number }[] = [];
  series.forEach((value, index) => {
    if (value !== undefined && Number.isFinite(value)) points.push({ value, index });
  });
  if (points.length < 2) return null;

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  // One denominator for the whole window, so the newest sample sits at the
  // right edge only once the window is full — a two-sample line should look
  // like two samples, not like a full history.
  const span = Math.max(series.length - 1, 1);

  const y = (value: number) =>
    range > 0
      ? SPARK_PAD + (1 - (value - min) / range) * (SPARK_HEIGHT - SPARK_PAD * 2)
      : SPARK_HEIGHT / 2;

  return points
    .map((point) => `${((point.index / span) * SPARK_WIDTH).toFixed(2)},${y(point.value).toFixed(2)}`)
    .join(' ');
}

function Sparkline({ series }: { series: (number | undefined)[] }) {
  const points = sparkPoints(series);

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      /* The box is stretched to the tile's width, which would stretch the
         stroke with it; `non-scaling-stroke` below keeps the line one weight. */
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {points === null ? (
        <line
          className="spark__flat"
          x1={0}
          x2={SPARK_WIDTH}
          y1={SPARK_HEIGHT / 2}
          y2={SPARK_HEIGHT / 2}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <polyline className="spark__line" points={points} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

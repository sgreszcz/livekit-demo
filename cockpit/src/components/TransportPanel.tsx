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
 * Every figure is optional at every sample. A muted microphone sends no packets
 * to lose, a reconnecting transport has no report to give, and browsers differ
 * on which WebRTC counters they publish at all — so the panel is built to
 * render from whatever subset arrived, down to the quality verdict alone.
 *
 * The second row (v1.3) is about the *audio*, not the network. Round-trip time
 * and packet loss describe the uplink; they are the leg the agent's hearing
 * depends on. Concealment is what is left after the jitter buffer has tried and
 * failed to hide a gap in what came back — which makes it the only figure here
 * that corresponds to something a human on the call can actually hear, and it
 * gets the emphasis for that reason.
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
  const decimals = (value: number | undefined, places: number): string =>
    value !== undefined ? value.toFixed(places) : MISSING;

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
          value={decimals(latest.jitterMs, 1)}
          unit="ms"
          series={window.map((sample) => sample.jitterMs)}
        />
        <Tile
          label="Loss"
          value={decimals(latest.lossPct, 1)}
          unit="%"
          series={window.map((sample) => sample.lossPct)}
        />

        {/* Green in, blue out — the page's own encoding, not a new one: green is
            audio leaving the agent and blue is the caller. */}
        <div className="ledger__cell ledger__cell--wide">
          <div className="ledger__label">Audio level</div>
          <div className="meters">
            <Meter label="In" level={latest.levelIn} tone="in" />
            <Meter label="Out" level={latest.levelOut} tone="out" />
          </div>
        </div>

        <Tile label="Bitrate in" value={decimals(latest.bitrateInKbps, 1)} unit="kb/s" />
        <Tile label="Bitrate out" value={decimals(latest.bitrateOutKbps, 1)} unit="kb/s" />
        <Tile label="Jitter buffer" value={decimals(latest.jitterBufferMs, 1)} unit="ms" />

        <Concealed pct={latest.concealedPct} series={window.map((sample) => sample.concealedPct)} />
      </div>

      <p className="ledger__caveat">
        Measured in this browser every 2 s: the first row from the microphone we publish, so it
        describes the caller’s uplink to LiveKit rather than the agent’s; the second from the
        agent’s audio as this browser decodes it. Never sent to the agent; kept only in this call’s
        recording.
      </p>
    </div>
  );
}

/**
 * Concealment thresholds.
 *
 * Amber and red are otherwise reserved for injected chaos, and this earns them
 * on the same grounds the quality lamp does: concealed audio is a fault
 * readout, not decoration. A tenth of a percent is inaudible and stays neutral;
 * past one percent a listener starts hearing it, and past five the call is
 * breaking up.
 */
const CONCEALED_AUDIBLE_PCT = 1;
const CONCEALED_SEVERE_PCT = 5;

function Concealed({ pct, series }: { pct?: number; series: (number | undefined)[] }) {
  const tone =
    pct === undefined || pct < CONCEALED_AUDIBLE_PCT
      ? ''
      : pct < CONCEALED_SEVERE_PCT
        ? ' ledger__value--warn'
        : ' ledger__value--alarm';

  return (
    <div className="ledger__cell ledger__cell--wide ledger__cell--lead">
      <div className="ledger__label">Concealed</div>
      <div className={`ledger__value num${tone}`}>
        {pct !== undefined ? pct.toFixed(2) : MISSING}
        <small>%</small>
      </div>
      <p className="ledger__gloss">Packet loss you can hear</p>
      <Sparkline series={series} />
    </div>
  );
}

/**
 * A live amplitude, 0..1.
 *
 * The bar is the instrument and the figure beside it is the annotation — a
 * level is read as a shape moving, and nobody tracks a two-decimal number at
 * two samples a second. A sample that carried no level draws an empty track
 * rather than a zero-length bar, because a microphone whose level went
 * unreported is not a silent microphone.
 */
function Meter({ label, level, tone }: { label: string; level?: number; tone: 'in' | 'out' }) {
  const known = level !== undefined;
  return (
    <div className="meter">
      <span className="meter__label">{label}</span>
      <span className="meter__track">
        {known ? (
          <span
            className={`meter__fill meter__fill--${tone}`}
            style={{ width: `${Math.min(100, Math.max(0, level * 100))}%` }}
          />
        ) : null}
      </span>
      <span className="meter__value num">{known ? level.toFixed(2) : MISSING}</span>
    </div>
  );
}

interface TileProps {
  label: string;
  value: string;
  unit: string;
  /**
   * One entry per sample in the window; `undefined` where nothing was read.
   *
   * Optional, and the tiles that omit it do so deliberately. Six sparklines in
   * a 316 px rail is a texture rather than six readings — the history is worth
   * drawing for the three figures that characterise the link and for
   * concealment, and the rest are better read as a current value.
   */
  series?: (number | undefined)[];
}

function Tile({ label, value, unit, series }: TileProps) {
  return (
    <div className="ledger__cell">
      <div className="ledger__label">{label}</div>
      <div className="ledger__value ledger__value--tight num">
        {value}
        <small>{unit}</small>
      </div>
      {series ? <Sparkline series={series} /> : null}
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

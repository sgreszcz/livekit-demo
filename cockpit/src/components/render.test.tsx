/**
 * The second half of the crafted-debrief defence.
 *
 * Ingest validation drops malformed envelopes, but a viewer must not depend on
 * it: records predating a schema addition, or a field that goes missing between
 * agent versions, must degrade to a dash rather than take the page down. These
 * render the instruments against deliberately broken state and assert only that
 * nothing throws and nothing prints "undefined".
 *
 * Rendered to static markup rather than a DOM: the assertions here are about
 * surviving bad data, and that needs no layout.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CockpitBoard } from './CockpitBoard';
import { ConnectionInfo } from './ConnectionInfo';
import { StateStrip, stateBreakdown } from './StateStrip';
import { Waterfall, axisScale } from './Waterfall';
import fixture from '../fixtures/sample-call.jsonl?raw';
import type { CallMetaPayload } from '../telemetry/schema';
import {
  LATENCY_BUDGET_SECONDS,
  callDurationSeconds,
  createCockpitState,
  parseEnvelopeLines,
  reduceAll,
  turnWaterfall,
} from '../telemetry/store';
import type { CockpitState, Turn } from '../telemetry/store';

const fixtureState = reduceAll(parseEnvelopeLines(fixture));

/** Whatever a viewer is handed, these two strings must never reach the page. */
function assertRenders(markup: string): void {
  expect(markup).not.toContain('undefined');
  expect(markup).not.toContain('NaN');
}

function withMeta(meta: unknown): CockpitState {
  return { ...createCockpitState(), meta: meta as CallMetaPayload };
}

describe('CockpitBoard', () => {
  it('renders the recorded sample call', () => {
    const markup = renderToStaticMarkup(<CockpitBoard state={fixtureState} follow={false} />);
    assertRenders(markup);
    expect(markup).toContain('cockpit-demo01');
  });

  it('renders an empty call without a meta, a turn or a usage total', () => {
    assertRenders(renderToStaticMarkup(<CockpitBoard state={createCockpitState()} follow />));
  });

  it('survives the crafted debrief that used to crash the viewer', () => {
    // {"messages":[{"type":"call_meta","ts":1,"payload":{}}]} — ingest drops it
    // now, but a stored record from before it did must still render.
    const markup = renderToStaticMarkup(<CockpitBoard state={withMeta({})} follow={false} />);
    assertRenders(markup);
    expect(markup).toContain('—');
  });

  it('survives a meta whose fields are the wrong types', () => {
    const markup = renderToStaticMarkup(
      <CockpitBoard
        state={withMeta({ room: 42, call_id: null, started_at: 'yesterday', pipeline: 'openai' })}
        follow={false}
      />,
    );
    assertRenders(markup);
  });
});

/**
 * The strip's legend and the elapsed figure in the panel head are two readings
 * of the same call. A viewer who adds the first up and gets less than the
 * second stops trusting both — which is exactly what happened while the
 * initializing lead-in was drawn but never listed.
 */
describe('agent state totals', () => {
  const elapsed = callDurationSeconds(fixtureState);
  const breakdown = () =>
    stateBreakdown(fixtureState.states, fixtureState.firstTs ?? 0, fixtureState.lastTs ?? 0);

  it('accounts for every second of the call, lead-in included', () => {
    const { totals } = breakdown();
    const listed = totals.reduce((sum, entry) => sum + entry.seconds, 0);

    expect(elapsed).toBeGreaterThan(0);
    expect(listed).toBeCloseTo(elapsed, 6);
    // The fixture's first state report lands 0.2s after call_meta; without a
    // Connecting entry the legend is short by exactly that.
    expect(totals.map((entry) => entry.label)).toEqual([
      'Connecting',
      'Listening',
      'Thinking',
      'Speaking',
    ]);
  });

  it('prints durations that still reconcile once rounded for display', () => {
    const markup = renderToStaticMarkup(
      <StateStrip
        states={fixtureState.states}
        startTs={fixtureState.firstTs ?? 0}
        endTs={fixtureState.lastTs ?? 0}
      />,
    );
    assertRenders(markup);

    // Only the legend prints a duration between tags; titles are attributes.
    const printed = [...markup.matchAll(/>(\d+(?:\.\d)?)s</g)].map((match) => Number(match[1]));
    expect(printed).toHaveLength(4);
    expect(Math.abs(printed.reduce((sum, value) => sum + value, 0) - elapsed)).toBeLessThanOrEqual(
      0.1,
    );
  });

  it('lists no Connecting entry when the agent reports state immediately', () => {
    const { totals } = stateBreakdown(
      [
        { state: 'listening', ts: 10 },
        { state: 'speaking', ts: 12 },
      ],
      10,
      15,
    );
    expect(totals.map((entry) => entry.label)).toEqual(['Listening', 'Speaking']);
    expect(totals.reduce((sum, entry) => sum + entry.seconds, 0)).toBeCloseTo(5, 6);
  });
});

describe('ConnectionInfo', () => {
  it('prints a dash for every field a broken record is missing', () => {
    const markup = renderToStaticMarkup(
      <ConnectionInfo meta={{} as CallMetaPayload} durationSeconds={0} turnCount={0} />,
    );
    assertRenders(markup);
    // Room, call id, entry, start time and all three models.
    expect(markup.match(/—/g) ?? []).toHaveLength(7);
  });

  it('prints a dash for a pipeline that is present but empty', () => {
    const meta = {
      call_id: 'RM_x',
      room: 'cockpit-x',
      started_at: 1723000000,
      pipeline: {},
      entry: 'browser',
    } as unknown as CallMetaPayload;

    const markup = renderToStaticMarkup(
      <ConnectionInfo meta={meta} durationSeconds={12} turnCount={2} />,
    );
    assertRenders(markup);
    expect(markup).toContain('cockpit-x');
    expect(markup.match(/—/g) ?? []).toHaveLength(3);
  });

  it('prints a dash for an entry point it has no label for', () => {
    const meta = {
      call_id: 'RM_x',
      room: 'cockpit-x',
      started_at: 1723000000,
      pipeline: { stt: 'deepgram/nova-3', llm: 'openai/gpt-4.1-mini', tts: 'cartesia/sonic-3' },
      entry: 'carrier-pigeon',
    } as unknown as CallMetaPayload;

    assertRenders(renderToStaticMarkup(<ConnectionInfo meta={meta} durationSeconds={1} turnCount={1} />));
  });
});

/**
 * The SVG itself only draws once a ResizeObserver has reported a width, which
 * never happens in static rendering — so the geometry is asserted through the
 * axis instead. Everything the drawing does with a stage is
 * `seconds / scale * width`, which is well-defined for every scale below.
 */
describe('axis scale', () => {
  const scaleFor = (turns: Turn[]) => axisScale(turns.map(turnWaterfall));

  it('fits the longest turn including its overlay lanes', () => {
    const scale = scaleFor(fixtureState.turns);
    const longest = Math.max(...fixtureState.turns.map((t) => turnWaterfall(t).spanSeconds));
    expect(longest).toBeCloseTo(4.01, 2);
    expect(scale).toBeGreaterThanOrEqual(longest);
    expect(scale).toBe(4.5);
  });

  it('never squeezes the budget line against the right edge', () => {
    // An axis tighter than the budget would put the 1.0s rule off the chart.
    for (const turns of [[], fixtureState.turns, [fixtureState.turns[0]]]) {
      expect(scaleFor(turns)).toBeGreaterThan(LATENCY_BUDGET_SECONDS);
    }
  });

  it('stays finite and positive for a turn with no metrics', () => {
    const scale = scaleFor([
      { turnId: 'x', index: 0, degraded: false, interruptions: [], firstTs: 0, lastTs: 0 },
    ]);
    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBeGreaterThan(0);
  });
});

describe('Waterfall', () => {
  const bareTurn: Turn = {
    turnId: 't1',
    index: 0,
    degraded: false,
    interruptions: [],
    firstTs: 0,
    lastTs: 0,
  };

  it('numbers the caller turns only, setting the agent greeting apart', () => {
    // The greeting must not consume T1, or every row sits one ahead of the
    // turn id an engineer is reading out of the agent logs.
    const markup = renderToStaticMarkup(<Waterfall turns={fixtureState.turns} />);
    expect(markup).toContain('GREET');
    expect(markup).toContain('>T1<');
    expect(markup).toContain('>T6<');
    expect(markup).not.toContain('>T7<');
  });

  it('renders a turn that has no stage metrics yet', () => {
    assertRenders(renderToStaticMarkup(<Waterfall turns={[bareTurn]} />));
  });

  it('renders a turn that has only half a pipeline', () => {
    const halfTurn: Turn = {
      ...bareTurn,
      llm: {
        ttft: 0.3,
        duration: 0.2, // shorter than ttft: the generation tail must clamp, not invert
        prompt_tokens: 1,
        completion_tokens: 1,
        tokens_per_second: 1,
        llm_calls: 4,
        model: 'openai/gpt-4.1-mini',
      },
    };
    const markup = renderToStaticMarkup(<Waterfall turns={[halfTurn]} />);
    assertRenders(markup);
    expect(markup).toContain('×4');
  });
});

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
import { ChaosControl } from './ChaosControl';
import { CockpitBoard } from './CockpitBoard';
import { ConnectionInfo } from './ConnectionInfo';
import {
  CallsPerDay,
  RatioGauge,
  StageBreakdown,
  callLength,
  latencyValue,
} from './FleetCharts';
import { Tabs } from './Tabs';
import { StateStrip, stateBreakdown } from './StateStrip';
import { TransportLamp, TransportPanel } from './TransportPanel';
import { TurnDetail } from './TurnDetail';
import { Waterfall, axisScale } from './Waterfall';
import fixture from '../fixtures/sample-call.jsonl?raw';
import type { CallMetaPayload, ChaosInjections } from '../telemetry/schema';
import {
  CHAOS_OFF,
  LATENCY_BUDGET_SECONDS,
  callDurationSeconds,
  createCockpitState,
  parseEnvelopeLines,
  reduceAll,
  turnWaterfall,
} from '../telemetry/store';
import type { ChaosState, CockpitState, TransportSample, Turn } from '../telemetry/store';

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

  it('makes every turn row a collapsed toggle rather than inert text', () => {
    const markup = renderToStaticMarkup(<Waterfall turns={fixtureState.turns} />);
    // Seven turns, seven buttons, all closed on first paint.
    expect(markup.match(/aria-expanded="false"/g) ?? []).toHaveLength(7);
    expect(markup).not.toContain('aria-expanded="true"');
    // The drawer is unmounted while closed, so nothing may claim to control it.
    expect(markup).not.toContain('aria-controls');
    expect(markup).not.toContain('wf-drawer');
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

/**
 * The drawer is rendered directly rather than clicked open: these tests run
 * without a DOM, and what is being asserted is that a real turn produces real
 * figures — not that React toggles state.
 */
describe('TurnDetail', () => {
  /** t1 of the fixture: a complete caller turn with every stage reported. */
  const turn = fixtureState.turns[1];

  it('prints every stage of a fixture turn in milliseconds', () => {
    const markup = renderToStaticMarkup(<TurnDetail turn={turn} />);
    assertRenders(markup);

    expect(markup).toContain('410 ms'); // eou.end_of_utterance_delay 0.41
    expect(markup).toContain('120 ms'); // eou.transcription_delay 0.12
    expect(markup).toContain('340 ms'); // llm.ttft 0.34
    expect(markup).toContain('190 ms'); // tts.ttfb 0.19
    expect(markup).toContain('940 ms'); // total_response_latency 0.94
  });

  it('prints the token detail and the audio durations', () => {
    const markup = renderToStaticMarkup(<TurnDetail turn={turn} />);
    expect(markup).toContain('820'); // prompt tokens
    expect(markup).toContain('58'); // completion tokens
    expect(markup).toContain('52.7 tok/s');
    expect(markup).toContain('3.1s'); // stt.audio_duration
    expect(markup).toContain('4.2s'); // tts.audio_duration
    expect(markup).toContain('gpt-4.1-mini');
  });

  it('reads a missing llm_calls as a single invocation', () => {
    // The contract says an absent count means one; printing a dash would imply
    // the agent failed to report rather than that it called the model once.
    expect(turn.llm?.llm_calls).toBeUndefined();
    expect(renderToStaticMarkup(<TurnDetail turn={turn} />)).toContain('>1<');
  });

  it('flags the degraded turn and the barge-in', () => {
    const degraded = renderToStaticMarkup(<TurnDetail turn={fixtureState.turns[3]} />);
    expect(degraded).toContain('Chaos degraded');

    const bargedIn = renderToStaticMarkup(<TurnDetail turn={fixtureState.turns[4]} />);
    expect(bargedIn).toContain('Barge-in');
  });

  it('draws one mini-bar per invocation when the chain is present', () => {
    const chained: Turn = {
      ...turn,
      llm: {
        ttft: 1.5,
        duration: 2.4,
        prompt_tokens: 900,
        completion_tokens: 60,
        tokens_per_second: 48,
        llm_calls: 3,
        chain: [
          { ttft: 0.4, duration: 0.9 },
          { ttft: 0.3, duration: 0.6 },
          { ttft: 0.8, duration: 0.9 },
        ],
        model: 'openai/gpt-4.1-mini',
      },
    };

    const markup = renderToStaticMarkup(<TurnDetail turn={chained} />);
    assertRenders(markup);
    expect(markup.match(/chain__row/g) ?? []).toHaveLength(3);
    expect(markup).toContain('#3');
    // Widths are a share of the longest invocation, never a raw second count.
    expect(markup).not.toContain('width="0.9"');
  });

  it('renders a turn with no metrics at all as dashes, not blanks', () => {
    const bare: Turn = {
      turnId: 'x',
      index: 0,
      degraded: false,
      interruptions: [],
      firstTs: 0,
      lastTs: 0,
    };
    const markup = renderToStaticMarkup(<TurnDetail turn={bare} />);
    assertRenders(markup);
    expect(markup).toContain('—');
  });

  it('survives an llm block whose chain is present but empty', () => {
    const empty: Turn = {
      ...turn,
      llm: { ...turn.llm!, llm_calls: 2, chain: [] },
    };
    assertRenders(renderToStaticMarkup(<TurnDetail turn={empty} />));
  });
});

describe('TransportPanel', () => {
  const sample = (ts: number, rttMs?: number): TransportSample => ({
    ts,
    quality: 'good',
    ...(rttMs !== undefined ? { rttMs, jitterMs: 4.1, lossPct: 0.4 } : null),
  });

  it('says so plainly when a recording carries no transport at all', () => {
    // The fixture is exactly this case, and it is the common one: transport is
    // measured in the caller's browser, so no phone call will ever have it.
    const markup = renderToStaticMarkup(<TransportPanel samples={[]} live={false} />);
    assertRenders(markup);
    expect(markup).toContain('Not recorded on this call');
  });

  it('distinguishes a live call that has not sampled yet from one that never will', () => {
    const markup = renderToStaticMarkup(<TransportPanel samples={[]} live />);
    expect(markup).toContain('Measuring the connection');
    expect(markup).not.toContain('Not recorded');
  });

  it('prints the newest reading and draws the series behind it', () => {
    const markup = renderToStaticMarkup(
      <TransportPanel samples={[sample(1, 40), sample(2, 44), sample(3, 48)]} live />,
    );
    assertRenders(markup);
    expect(markup).toContain('48');
    expect(markup).toContain('4.1');
    expect(markup).toContain('0.4');
    expect(markup).toContain('polyline');
  });

  it('renders a quality-only series without inventing figures', () => {
    // The documented fallback: no numbers, and the panel still stands up.
    const markup = renderToStaticMarkup(
      <TransportPanel samples={[sample(1), sample(2)]} live />,
    );
    assertRenders(markup);
    expect(markup).toContain('—');
    // Nothing to plot, so the baseline stands in for a line.
    expect(markup).not.toContain('polyline');
    expect(markup).toContain('spark__flat');
  });

  it('draws no line from a single reading', () => {
    const markup = renderToStaticMarkup(<TransportPanel samples={[sample(1, 40)]} live />);
    assertRenders(markup);
    expect(markup).toContain('40');
    expect(markup).not.toContain('polyline');
  });

  it('lights the lamp for every quality the SDK can report', () => {
    for (const quality of ['excellent', 'good', 'poor', 'lost', 'unknown'] as const) {
      const markup = renderToStaticMarkup(<TransportLamp quality={quality} />);
      assertRenders(markup);
      expect(markup).toContain('lamp');
    }
  });
});

/**
 * The v1.3 transport row.
 *
 * Same contract as the three figures above it and the same failure to avoid: a
 * panel that needs a full stats report to render is a panel that goes blank
 * exactly when the connection gets interesting. Every one of these six fields
 * is independently optional, so the assertions are mostly about dashes.
 */
describe('TransportPanel — v1.3', () => {
  const enriched: TransportSample = {
    ts: 1,
    quality: 'good',
    rttMs: 48,
    jitterMs: 4.1,
    lossPct: 0.4,
    levelIn: 0.31,
    levelOut: 0.02,
    bitrateInKbps: 24.1,
    bitrateOutKbps: 31.7,
    jitterBufferMs: 61,
    concealedPct: 0.42,
  };

  it('prints every enriched figure and draws both level meters', () => {
    const markup = renderToStaticMarkup(<TransportPanel samples={[enriched]} live />);
    assertRenders(markup);

    expect(markup).toContain('24.1');
    expect(markup).toContain('31.7');
    expect(markup).toContain('61.0');
    expect(markup).toContain('0.42');
    expect(markup).toContain('0.31');
    expect(markup).toContain('0.02');
    // Green in, blue out — the page's own encoding, not a new one.
    expect(markup).toContain('meter__fill--in');
    expect(markup).toContain('meter__fill--out');
    expect(markup).toContain('width:31%');
  });

  it('gives concealment the emphasis and says what it means', () => {
    const markup = renderToStaticMarkup(<TransportPanel samples={[enriched]} live />);
    expect(markup).toContain('Concealed');
    expect(markup).toContain('Packet loss you can hear');
    expect(markup).toContain('ledger__cell--lead');
  });

  it('colours concealment only once it is audible', () => {
    const at = (concealedPct: number) =>
      renderToStaticMarkup(<TransportPanel samples={[{ ...enriched, concealedPct }]} live />);

    // Inaudible: neutral. Amber and red are otherwise reserved for chaos, and
    // a tenth of a percent has not earned one.
    expect(at(0.1)).not.toContain('ledger__value--warn');
    expect(at(0.1)).not.toContain('ledger__value--alarm');

    expect(at(2)).toContain('ledger__value--warn');
    expect(at(2)).not.toContain('ledger__value--alarm');

    expect(at(9)).toContain('ledger__value--alarm');
  });

  it('dashes every v1.3 field a v1.1 recording never carried', () => {
    // Exactly what a debrief stored before these existed looks like, and what
    // a browser that publishes no raw stats report produces live.
    const v11: TransportSample = { ts: 1, quality: 'good', rttMs: 48, jitterMs: 4.1, lossPct: 0.4 };
    const markup = renderToStaticMarkup(<TransportPanel samples={[v11]} live />);
    assertRenders(markup);

    expect(markup).toContain('48');
    // Six dashes: two levels, two bitrates, the jitter buffer and concealment.
    expect(markup.match(/—/g) ?? []).toHaveLength(6);
    // An unreported level draws no fill at all: an empty track reads as "no
    // reading", a zero-width one reads as a measured silence.
    expect(markup).not.toContain('meter__fill');
  });

  it('draws a zero level as a real reading rather than as an absence', () => {
    const muted: TransportSample = { ts: 1, quality: 'good', levelOut: 0, levelIn: 0.4 };
    const markup = renderToStaticMarkup(<TransportPanel samples={[muted]} live />);
    assertRenders(markup);
    expect(markup).toContain('0.00');
    expect(markup).toContain('width:0%');
  });

  it('still says nothing was recorded when a call carried no transport at all', () => {
    const markup = renderToStaticMarkup(<TransportPanel samples={[]} live={false} />);
    expect(markup).toContain('Not recorded on this call');
    expect(markup).not.toContain('Concealed');
  });
});

/**
 * The chaos panel.
 *
 * Two states are on screen and they are not the same thing: what this browser
 * asked for, and what the agent says is live. The read-only case is the one
 * that has to be right — an observer never asked for anything, so rendering its
 * own request would draw four Off switches over a call running under +800 ms.
 */
describe('ChaosControl', () => {
  const OFF: ChaosInjections = {
    llm_delay_ms: 0,
    tts_delay_ms: 0,
    slow_model: false,
    max_completion_tokens: null,
  };

  const ARMED: ChaosState = {
    llmDelayMs: 800,
    ttsDelayMs: 300,
    slowModel: true,
    maxCompletionTokens: 30,
    active: true,
  };

  const render = (props: Partial<Parameters<typeof ChaosControl>[0]> = {}) =>
    renderToStaticMarkup(
      <ChaosControl
        request={OFF}
        acked={CHAOS_OFF}
        disabled={false}
        onChange={() => {}}
        {...props}
      />,
    );

  it('offers all four injections as independent switch banks', () => {
    const markup = render();
    assertRenders(markup);
    for (const label of ['LLM delay', 'Voice delay', 'Slow model', 'Token starvation']) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    // 4 + 3 + 2 + 3 positions.
    expect(markup.match(/chaos__opt/g) ?? []).toHaveLength(12);
  });

  it('reads back the request immediately, before any ack', () => {
    // A control that waits for a network round trip to move feels broken.
    const markup = render({ request: { ...OFF, llm_delay_ms: 1500 } });
    expect(markup).toContain('>+1500</button>');
    expect(markup.match(/aria-pressed="true"/g) ?? []).toHaveLength(4);
  });

  it('prints the agent’s value beside each label, never the request', () => {
    // The honest reading: this line is what claims an injection is happening.
    const markup = render({ request: { ...OFF, llm_delay_ms: 1500 }, acked: ARMED });
    expect(markup).toContain('+800 ms');
    expect(markup).toContain('+300 ms');
    expect(markup).toContain('heavy');
    expect(markup).toContain('30 tok');
    expect(markup).not.toContain('+1500 ms');
  });

  it('shows the agent’s state, not its own, when read-only', () => {
    const markup = render({ request: OFF, acked: ARMED, disabled: true, disabledNote: 'read-only' });
    assertRenders(markup);

    // Every switch dead...
    expect(markup.match(/disabled=""/g) ?? []).toHaveLength(12);
    // ...and yet showing what is armed: an observer watching a degraded call
    // must see which four positions are live.
    expect(markup).toContain('>+800</button>');
    expect(markup).toContain('>Heavy</button>');
    expect(markup).toContain('>30</button>');
    expect(markup).toContain('read-only');
  });

  it('summarises how many injections the agent acknowledged', () => {
    expect(render({ acked: ARMED })).toContain('acknowledged 4 injections');
    expect(render({ acked: { ...CHAOS_OFF, slowModel: true } })).toContain(
      'acknowledged 1 injection.',
    );
    expect(render()).toContain('Nothing injected');
  });

  it('renders an ack from a v1.1 agent as three injections switched off', () => {
    const markup = render({ acked: { ...CHAOS_OFF, llmDelayMs: 400, active: true }, disabled: true });
    assertRenders(markup);
    expect(markup).toContain('+400 ms');
    // Off is selected on the other three banks, not "unknown".
    expect(markup.match(/aria-pressed="true"/g) ?? []).toHaveLength(4);
  });
});

describe('CockpitBoard — chaos panel', () => {
  it('counts the active injections in the panel head', () => {
    const state: CockpitState = {
      ...createCockpitState(),
      chaos: { llmDelayMs: 800, ttsDelayMs: 300, slowModel: false, maxCompletionTokens: null, active: true },
    };
    const markup = renderToStaticMarkup(
      <CockpitBoard
        state={state}
        follow={false}
        chaos={{
          request: { llm_delay_ms: 800, tts_delay_ms: 300, slow_model: false, max_completion_tokens: null },
          disabled: false,
          onChange: () => {},
        }}
      />,
    );
    assertRenders(markup);
    expect(markup).toContain('Chaos engineering');
    expect(markup).toContain('2 active');
  });

  it('reads nominal when the agent has nothing armed', () => {
    const markup = renderToStaticMarkup(
      <CockpitBoard
        state={createCockpitState()}
        follow={false}
        chaos={{
          request: { llm_delay_ms: 0, tts_delay_ms: 0, slow_model: false, max_completion_tokens: null },
          disabled: true,
          onChange: () => {},
        }}
      />,
    );
    expect(markup).toContain('nominal');
  });
});

/** Navigation. Real anchors, so a pasted /dashboard link is a real page. */
describe('Tabs', () => {
  it('marks the current section and links the other with a real href', () => {
    const markup = renderToStaticMarkup(<Tabs route="dashboard" />);
    assertRenders(markup);
    expect(markup).toContain('href="/"');
    expect(markup).toContain('href="/dashboard"');
    expect(markup).toContain('aria-current="page"');
    expect(markup.match(/aria-current="page"/g) ?? []).toHaveLength(1);
    expect(markup).toContain('tab--current');
  });

  it('lights the cockpit tab for a stored debrief, which is a cockpit', () => {
    const markup = renderToStaticMarkup(<Tabs route="debrief" />);
    // Not an empty bar: a debrief is the same instruments over a recording.
    expect(markup).toContain('aria-current="page"');
    expect(markup.indexOf('tab--current')).toBeLessThan(markup.indexOf('/dashboard'));
  });
});

/**
 * The fleet drawings. Every one of them is handed data straight off a network
 * endpoint, so the cases that matter are the empty and the absent ones.
 */
describe('FleetCharts', () => {
  const days = [
    { date: '2026-07-24', value: 0 },
    { date: '2026-07-25', value: 3 },
    { date: '2026-07-26', value: 9 },
  ];

  it('draws one column per day and states the peak', () => {
    const markup = renderToStaticMarkup(<CallsPerDay days={days} />);
    assertRenders(markup);
    expect(markup.match(/daychart__bar/g) ?? []).toHaveLength(3);
    expect(markup).toContain('peak 9/day');
    expect(markup).toContain('24/07');
    expect(markup).toContain('26/07');
    // Every column carries its own exact figure, since 14 labels do not fit.
    expect(markup).toContain('2026-07-26: 9 calls');
    expect(markup).toContain('2026-07-25: 3 calls');
  });

  it('draws no column for a quiet day and says so rather than showing a gap', () => {
    const markup = renderToStaticMarkup(<CallsPerDay days={[{ date: '2026-07-24', value: 0 }]} />);
    assertRenders(markup);
    expect(markup).toContain('height="0"');
    expect(markup).toContain('no calls yet');
  });

  it('says plainly when there is no history at all', () => {
    const markup = renderToStaticMarkup(<CallsPerDay days={[]} />);
    expect(markup).toContain('No call history yet');
  });

  it('gives each stage the waterfall’s own colour', () => {
    const markup = renderToStaticMarkup(
      <StageBreakdown
        stages={[
          { label: 'EOU delay', ms: 420 },
          { label: 'LLM TTFT', ms: 340 },
          { label: 'TTS TTFB', ms: 190 },
        ]}
      />,
    );
    assertRenders(markup);
    expect(markup).toContain('var(--stage-eou)');
    expect(markup).toContain('var(--stage-ttft)');
    expect(markup).toContain('var(--stage-ttfb)');
    // Widths are a share of the longest stage, so the three are comparable.
    expect(markup).toContain('width="100%"');
    expect(markup).toContain('420');
  });

  it('still draws a stage it has no colour for', () => {
    const markup = renderToStaticMarkup(<StageBreakdown stages={[{ label: 'Tool call', ms: 90 }]} />);
    assertRenders(markup);
    expect(markup).toContain('var(--text-mute)');
  });

  it('survives a breakdown where every stage is zero', () => {
    const markup = renderToStaticMarkup(
      <StageBreakdown stages={[{ label: 'EOU delay', ms: 0 }, { label: 'LLM TTFT', ms: 0 }]} />,
    );
    assertRenders(markup);
    expect(markup).toContain('width="0%"');
  });

  it('leaves a gauge empty rather than at zero when nothing was reported', () => {
    const markup = renderToStaticMarkup(
      <RatioGauge label="Degraded" pct={null} tone="alarm" caption="…" />,
    );
    assertRenders(markup);
    expect(markup).toContain('—');
    expect(markup).not.toContain('gauge__fill');
    expect(markup).not.toContain('gauge__value--alarm');
  });

  it('keeps a measured zero neutral and lights a real rate', () => {
    const zero = renderToStaticMarkup(
      <RatioGauge label="Over budget" pct={0} tone="warn" caption="…" />,
    );
    expect(zero).toContain('0.0');
    // Nothing went wrong, so nothing lights up.
    expect(zero).not.toContain('gauge__value--warn');

    const lit = renderToStaticMarkup(
      <RatioGauge label="Over budget" pct={12.5} tone="warn" caption="…" />,
    );
    expect(lit).toContain('gauge__value--warn');
    expect(lit).toContain('width:12.5%');
  });

  it('clamps a percentage the endpoint reported out of range', () => {
    const markup = renderToStaticMarkup(
      <RatioGauge label="Degraded" pct={140} tone="alarm" caption="…" />,
    );
    assertRenders(markup);
    expect(markup).toContain('width:100%');
  });

  it('formats a call length as a human reads one', () => {
    expect(callLength(48)).toBe('48s');
    expect(callLength(63.4)).toBe('1m 03s');
    expect(callLength(0)).toBe('0s');
  });

  it('dashes a latency the endpoint did not report', () => {
    expect(latencyValue(null)).toBe('—');
    expect(latencyValue(1810)).toBe('1,810');
    expect(latencyValue(0)).toBe('0');
  });
});

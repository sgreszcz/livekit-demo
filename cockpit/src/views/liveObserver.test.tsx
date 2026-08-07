/**
 * `/live` while it is actually watching a call.
 *
 * `liveView.test.tsx` covers the holding screen, which is what this page renders
 * before any effect runs. Getting to `observing` needs a joined room, so the
 * cockpit hook is faked here and the page is rendered against it — everything
 * under test is what LiveView WIRES, and wiring is exactly what a fake hook
 * exposes: which props reach the board, and which callbacks are real.
 *
 * The feature: an observer may arm chaos. The owner calls the demo from a phone
 * and drives the instruments from the laptop, and the laptop session is an
 * observer — so a dead chaos panel here puts the demo's best feature out of
 * reach in the flow it was designed for.
 *
 * The line that must not move with it: an observer has no microphone. The token
 * enforces that, and these assertions are the cockpit's own half of the promise
 * — nothing on this page may ask for audio to be published.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Cockpit } from '../useCockpit';
import { createCockpitState, type CockpitState } from '../telemetry/store';

const setChaos = vi.fn(async () => {});
const toggleMic = vi.fn(async () => {});
const toggleListening = vi.fn(async () => {});

/** Whatever the hook is told to be this test. */
let cockpit: Cockpit;

vi.mock('../useCockpit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../useCockpit')>();
  return { ...actual, useCockpit: () => cockpit };
});

/**
 * Every set of props the board was rendered with.
 *
 * The board itself is still the real one — this records what reached it and
 * delegates. Asserting the panel's markup proves it LOOKS live; asserting the
 * props proves it IS, and the difference between those two is precisely the
 * regression worth guarding: an enabled panel whose `onChange` is still the
 * `() => {}` it was handed while the session was read-only would render
 * identically and do nothing.
 */
const boardProps: CockpitBoardProps[] = [];

vi.mock('../components/CockpitBoard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/CockpitBoard')>();
  return {
    ...actual,
    CockpitBoard: (props: CockpitBoardProps) => {
      boardProps.push(props);
      return <actual.CockpitBoard {...props} />;
    },
  };
});

type CockpitBoardProps = Parameters<typeof import('../components/CockpitBoard').CockpitBoard>[0];

const { LiveView, OBSERVER_CHAOS_NOTE } = await import('./LiveView');

/** The chaos props of the most recent render. */
function chaosProps() {
  const props = boardProps.at(-1);
  if (props === undefined) throw new Error('the board was never rendered');
  if (props.chaos === undefined) throw new Error('the board was given no chaos controls');
  return props.chaos;
}

/** A cockpit mid-observation, with whatever the test wants to vary. */
function observing(overrides: Partial<Cockpit> = {}): Cockpit {
  return {
    state: createCockpitState(),
    mode: 'observing',
    error: null,
    chaosRequest: null,
    micEnabled: true,
    listening: false,
    share: null,
    sharing: false,
    startCall: async () => {},
    startReplay: () => {},
    startObserving: async () => {},
    stopObserving: () => {},
    endCall: async () => {},
    reset: () => {},
    setChaos,
    toggleMic,
    toggleListening,
    shareCall: async () => {},
    ...overrides,
  };
}

/** A call already running under two injections the caller armed. */
function degraded(): CockpitState {
  return {
    ...createCockpitState(),
    chaos: {
      llmDelayMs: 800,
      ttsDelayMs: 0,
      slowModel: true,
      maxCompletionTokens: null,
      active: true,
    },
  };
}

function render(): string {
  return renderToStaticMarkup(<LiveView room={null} />);
}

beforeEach(() => {
  setChaos.mockClear();
  toggleMic.mockClear();
  toggleListening.mockClear();
  boardProps.length = 0;
  cockpit = observing();
});

describe('LiveView — observing', () => {
  it('renders the chaos panel live, not dead', () => {
    const markup = render();

    // Twelve switch positions across the four banks, and not one of them
    // disabled. The whole point: the panel used to render inert here.
    expect(markup.match(/chaos__opt/g) ?? []).toHaveLength(12);
    expect(markup).not.toContain('disabled=""');
  });

  it('captions the panel with what is actually true of it', () => {
    const markup = render();

    expect(markup).toContain('the agent applies whichever came last');
    // The old caption is the specific thing that must be gone: it told a
    // visitor the switches in front of them would do nothing.
    expect(markup).not.toContain('Chaos injection is caller-side');
    expect(markup).not.toContain('this session is read-only');
  });

  it('hands the board a live panel wired to the session, not a no-op', () => {
    render();
    const chaos = chaosProps();

    expect(chaos.disabled).toBe(false);
    expect(chaos.note).toBe(OBSERVER_CHAOS_NOTE);

    // Invoked as the panel would invoke it. This is the assertion the markup
    // cannot make: a switch that looks live and reaches nothing renders the
    // same either way.
    chaos.onChange({ llm_delay_ms: 800 });
    expect(setChaos).toHaveBeenCalledTimes(1);
    expect(setChaos).toHaveBeenCalledWith({ llm_delay_ms: 800 });
  });

  it('publishes what the watcher asked for and nothing else', () => {
    // A patch, exactly as the caller path sends: the agent applies the fields
    // present and leaves the rest alone, which is what lets two cockpits share
    // one agent without fighting over the other three injections.
    render();
    chaosProps().onChange({ max_completion_tokens: null });
    expect(setChaos).toHaveBeenCalledWith({ max_completion_tokens: null });
  });

  it('shows what the caller armed, until the watcher touches anything', () => {
    // An observer joins mid-call and has requested nothing, so the panel reads
    // the agent's ack. Four Off switches over a degraded call would be the
    // instrument lying about the call it is watching.
    cockpit = observing({ state: degraded(), chaosRequest: null });
    const markup = render();

    expect(markup).toContain('+800 ms');
    expect(markup).toContain('heavy');
    expect(markup).toContain('>+800</button>');
    expect(markup).toContain('>Heavy</button>');
  });

  it('reads back the watcher’s own request once there is one', () => {
    cockpit = observing({
      state: degraded(),
      chaosRequest: {
        llm_delay_ms: 400,
        tts_delay_ms: 0,
        slow_model: false,
        max_completion_tokens: null,
      },
    });
    const markup = render();

    expect(markup).toContain('>+400</button>');
    // The readouts stay the agent's, always — they are what claims an injection
    // is actually live, and a button press is not an ack.
    expect(markup).toContain('+800 ms');
  });

  it('offers audio and echo advice, and never claims the session is read-only', () => {
    const markup = render();

    expect(markup).toContain('observer-bar');
    expect(markup).toContain('audio is muted to prevent echo');
    expect(markup).toContain('you can arm chaos from here');
    // Nothing anywhere on the page may still say this session cannot affect
    // the call, because it now can.
    expect(markup).not.toContain('read-only');
    expect(markup).not.toContain('Read-only');
  });

  it('says mic-off in the topbar chip rather than read-only', () => {
    const markup = render();
    expect(markup).toContain('Observing · mic off');
  });

  it('asks for no microphone anywhere on the page', () => {
    /*
     * The negative that carries the whole safety argument. `canPublishData` was
     * granted; `canPublish` was not, and the cockpit must not be the thing that
     * tries anyway — a page that called `toggleMic` here would fire a publish
     * the server refuses and, worse, would read as though it had succeeded.
     */
    cockpit = observing({ state: degraded() });
    const markup = render();

    expect(toggleMic).not.toHaveBeenCalled();
    // No mute/unmute control at all: the only audio switch an observer gets is
    // the one for its own speakers.
    expect(markup).not.toContain('>Mute</button>');
    expect(markup).not.toContain('>Unmute</button>');

    // And arming chaos does not reach for one either: the two capabilities are
    // independent, and only one of them was granted.
    chaosProps().onChange({ slow_model: true });
    expect(setChaos).toHaveBeenCalledWith({ slow_model: true });
    expect(toggleMic).not.toHaveBeenCalled();
  });

  it('exports the caption it renders, so the copy has one home', () => {
    expect(render()).toContain(OBSERVER_CHAOS_NOTE);
  });
});

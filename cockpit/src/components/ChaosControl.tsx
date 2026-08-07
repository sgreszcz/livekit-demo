/**
 * Chaos engineering: four independent ways to make the call worse on purpose.
 *
 * This is the point of the demo. Anyone can show a fast happy path; the
 * interesting question is what the instruments do when it slips, and each of
 * these breaks the pipeline somewhere different — one delays the model, one
 * delays the voice, one makes the model genuinely slower, and one cuts its
 * answers short. They compose, so a caller can be shown two faults at once and
 * watch the waterfall attribute them separately.
 *
 * Two states are on screen at all times and they are not the same thing:
 *
 *   - what this browser has *asked* for, which is what the buttons read back,
 *     immediately, because a control that waits for a network round trip to
 *     move feels broken;
 *   - what the agent says is *live*, printed beside each label and taken only
 *     from its ack. That is the honest reading, and it is the only one a
 *     session that has asked for nothing has — so those buttons render the
 *     agent's state instead of an off-state nobody chose.
 *
 * An observer is now one of the browsers that can arm these, not merely one
 * that can read them. Its panel is live, and until the watcher presses
 * something it is also a panel with nothing of its own to show — which is why
 * "has this browser asked for anything" and "are these switches enabled" are
 * two different questions here.
 */

import type { ChaosInjections } from '../telemetry/schema';
import { activeInjectionCount, type ChaosState } from '../telemetry/store';

/** The reason the switches are dead when nobody has said otherwise. */
const DISABLED_NOTE = 'Available once you are in a live call — a replay is already written.';

const MISSING = 'off';

interface ChaosControlProps {
  /**
   * What this browser has requested, or null if it has not asked for anything.
   * Ignored while `disabled`.
   */
  request: ChaosInjections | null;
  /** The agent's own account of what is armed, from its ack envelope. */
  acked: ChaosState;
  disabled: boolean;
  /**
   * Replaces the caption, in whichever state the panel is in.
   *
   * It began as disabled-only copy, for panels whose reason for being dead was
   * not the usual one. It now also covers the opposite case: an observer's
   * panel is fully live, but the standard caption speaks as though this browser
   * were the only one at the switches, and on an observed call it is not.
   */
  note?: string;
  onChange: (patch: Partial<ChaosInjections>) => void;
}

/** The agent's state in the shape the controls are written against. */
function ackedAsRequest(acked: ChaosState): ChaosInjections {
  return {
    llm_delay_ms: acked.llmDelayMs,
    tts_delay_ms: acked.ttsDelayMs,
    slow_model: acked.slowModel,
    max_completion_tokens: acked.maxCompletionTokens,
  };
}

const delayReadout = (ms: number): string => (ms > 0 ? `+${ms} ms` : MISSING);

export function ChaosControl({ request, acked, disabled, note, onChange }: ChaosControlProps) {
  /*
   * A panel shows the operator only once there IS an operator; otherwise it
   * shows the agent.
   *
   * Two ways to have no operator, and both must resolve the same way. A
   * disabled panel — a replay, a finished call — never had one. An observer's
   * panel is fully live and may still have none: it joined a call already in
   * progress, and until the watcher presses something the only truth available
   * is the agent's ack. Rendering an untouched off-state in either case would
   * draw four Off switches over a call that is at that moment running under
   * +800 ms, which is the specific lie this swap exists to prevent.
   */
  const shown = disabled ? ackedAsRequest(acked) : (request ?? ackedAsRequest(acked));
  const activeCount = activeInjectionCount(acked);

  return (
    <div className="chaos-panel">
      <Injection
        label="LLM delay"
        readout={delayReadout(acked.llmDelayMs)}
        disabled={disabled}
        options={[0, 400, 800, 1500].map((value) => ({
          key: String(value),
          label: value === 0 ? 'Off' : `+${value}`,
          off: value === 0,
          selected: shown.llm_delay_ms === value,
          onPick: () => onChange({ llm_delay_ms: value }),
        }))}
      />

      <Injection
        label="Voice delay"
        readout={delayReadout(acked.ttsDelayMs)}
        disabled={disabled}
        options={[0, 300, 600].map((value) => ({
          key: String(value),
          label: value === 0 ? 'Off' : `+${value}`,
          off: value === 0,
          selected: shown.tts_delay_ms === value,
          onPick: () => onChange({ tts_delay_ms: value }),
        }))}
      />

      <Injection
        label="Slow model"
        readout={acked.slowModel ? 'heavy' : MISSING}
        disabled={disabled}
        options={[false, true].map((value) => ({
          key: String(value),
          label: value ? 'Heavy' : 'Off',
          off: !value,
          selected: shown.slow_model === value,
          onPick: () => onChange({ slow_model: value }),
        }))}
      />

      <Injection
        label="Token starvation"
        readout={acked.maxCompletionTokens !== null ? `${acked.maxCompletionTokens} tok` : MISSING}
        disabled={disabled}
        options={[null, 30, 80].map((value) => ({
          key: String(value),
          label: value === null ? 'Off' : String(value),
          off: value === null,
          selected: shown.max_completion_tokens === value,
          onPick: () => onChange({ max_completion_tokens: value }),
        }))}
      />

      <p className="chaos__note">
        {note ??
          (disabled
            ? DISABLED_NOTE
            : activeCount === 0
              ? 'Nothing injected. Turn something up and watch the waterfall find it.'
              : `Agent acknowledged ${activeCount} injection${activeCount === 1 ? '' : 's'}. ` +
                'Turns that ran under one are flagged in the waterfall.')}
      </p>
    </div>
  );
}

interface InjectionOption {
  key: string;
  label: string;
  /** The off position, which wears the healthy green rather than the amber. */
  off: boolean;
  selected: boolean;
  onPick: () => void;
}

interface InjectionProps {
  label: string;
  /** The agent's current setting for this one injection, in its own units. */
  readout: string;
  disabled: boolean;
  options: InjectionOption[];
}

function Injection({ label, readout, disabled, options }: InjectionProps) {
  return (
    <div className="inject">
      <div className="inject__head">
        <span className="inject__label">{label}</span>
        {/* Always the agent's value, never the request — this line is what says
            an injection is actually happening, so it may not report a button
            press the agent has not answered. */}
        <span className={`inject__state num${readout === MISSING ? '' : ' inject__state--armed'}`}>
          {readout}
        </span>
      </div>
      <div className="chaos" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            className="chaos__opt"
            aria-pressed={option.selected}
            data-off={option.off}
            disabled={disabled}
            onClick={option.onPick}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Injects artificial latency in front of the LLM so the waterfall can be made
 * to fail on demand. This is the point of the demo: anyone can show a fast
 * happy path, the interesting question is what the instruments do when it slips.
 */

const OPTIONS = [0, 400, 800, 1500] as const;

/** The reason the switch is dead when nobody has said otherwise. */
const DISABLED_NOTE = 'Available once you are in a live call — a replay is already written.';

interface ChaosControlProps {
  delayMs: number;
  acknowledged: boolean;
  disabled: boolean;
  /**
   * Replaces the disabled copy for callers whose reason is a different one — an
   * observer is not looking at a finished recording, and telling them to wait
   * for a live call would be advice they cannot act on.
   */
  disabledNote?: string;
  onChange: (delayMs: number) => void;
}

export function ChaosControl({
  delayMs,
  acknowledged,
  disabled,
  disabledNote,
  onChange,
}: ChaosControlProps) {
  return (
    <div>
      <div className="chaos" role="group" aria-label="Injected LLM latency">
        {OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className="chaos__opt"
            aria-pressed={delayMs === option}
            data-off={option === 0}
            disabled={disabled}
            onClick={() => onChange(option)}
          >
            {option === 0 ? 'Off' : `+${option}`}
          </button>
        ))}
      </div>
      <p className="chaos__note">
        {disabled
          ? (disabledNote ?? DISABLED_NOTE)
          : delayMs === 0
            ? 'Milliseconds added ahead of every LLM call. Turn it up and watch the amber band grow.'
            : acknowledged
              ? `Agent acknowledged +${delayMs} ms. Degraded turns are flagged in the waterfall.`
              : `Requested +${delayMs} ms — waiting for the agent to acknowledge.`}
      </p>
    </div>
  );
}

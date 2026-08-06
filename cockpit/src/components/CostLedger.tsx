/**
 * Running spend. The agent computes cost from its own price table, so this is
 * an estimate by construction and is labelled as one — a demo that quietly
 * implies billing accuracy is a demo that gets someone in trouble.
 */

import type { UsagePayload } from '../telemetry/schema';
import { duration, integer, usd } from '../format';

export function CostLedger({ usage }: { usage: UsagePayload | null }) {
  const totals = usage ?? {
    llm_prompt_tokens: 0,
    llm_completion_tokens: 0,
    stt_audio_seconds: 0,
    tts_characters: 0,
    est_cost_usd: 0,
  };

  return (
    <div>
      <div className="ledger">
        <Cell label="Prompt tokens" value={integer(totals.llm_prompt_tokens)} />
        <Cell label="Output tokens" value={integer(totals.llm_completion_tokens)} />
        <Cell label="STT audio" value={duration(totals.stt_audio_seconds)} />
        <Cell label="TTS characters" value={integer(totals.tts_characters)} />
        <div className="ledger__cell ledger__cell--wide ledger__cell--cost">
          <div className="ledger__label">Estimated spend</div>
          <div className="ledger__value num">
            {usd(totals.est_cost_usd)}
            <small>USD</small>
          </div>
        </div>
      </div>
      <p className="ledger__caveat">
        Approximate. Priced from the agent's configured rate card at the moment of the call, not
        from provider invoices.
      </p>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="ledger__cell">
      <div className="ledger__label">{label}</div>
      <div className="ledger__value num">{value}</div>
    </div>
  );
}

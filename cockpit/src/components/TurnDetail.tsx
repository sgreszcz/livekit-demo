/**
 * Everything the waterfall row had to leave out.
 *
 * The row is a shape: one bar on a shared axis, comparable at a glance. This is
 * the same turn as figures — the four stage timings the bar is made of, what
 * the model was handed and produced, how much audio went each way, and any
 * flags the row could only hint at with a chip.
 *
 * Fields degrade to a dash rather than vanishing. A stage that reported nothing
 * is itself a finding — "the TTS never reported a first byte" is worth seeing,
 * and a row that quietly disappeared would not say it.
 */

import type { LlmChainLink } from '../telemetry/schema';
import type { Turn } from '../telemetry/store';
import { duration, integer, ms, shortModel } from '../format';

const MISSING = '—';

/** Seconds -> "410 ms", or a dash when the stage never reported. */
function stage(seconds: number | undefined): string {
  return seconds === undefined ? MISSING : `${ms(seconds)} ms`;
}

function count(value: number | undefined): string {
  return value === undefined ? MISSING : integer(value);
}

function seconds(value: number | undefined): string {
  return value === undefined ? MISSING : duration(value);
}

function model(value: string | undefined): string {
  return typeof value === 'string' && value.length > 0 ? shortModel(value) : MISSING;
}

/**
 * The v1 contract carries no per-turn TTS character count — only the running
 * total in `usage`. This reads one defensively anyway: an agent that starts
 * reporting it gets the row for free, and until one does the row is simply
 * absent. Adding the field to the wire types instead would be changing a
 * contract this side of the wire does not own.
 */
function optionalCount(source: unknown, key: string): number | undefined {
  const value: unknown = (source as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function TurnDetail({ turn }: { turn: Turn }) {
  const { eou, stt, llm, tts } = turn;
  const invocations = llm?.llm_calls ?? (llm ? 1 : undefined);
  const ttsCharacters = optionalCount(tts, 'characters');

  const bargeIns = turn.interruptions.filter((kind) => kind === 'barge_in').length;
  const falseInterruptions = turn.interruptions.length - bargeIns;

  return (
    <div className="detail">
      <section className="detail__group">
        <h3 className="legend">Stages</h3>
        <dl className="spec-list">
          <Row label="EOU" value={stage(eou?.end_of_utterance_delay)} />
          <Row label="Transcript" value={stage(eou?.transcription_delay)} />
          <Row label="TTFT" value={stage(llm?.ttft)} />
          <Row label="TTFB" value={stage(tts?.ttfb)} />
          <Row
            label="Wait"
            value={stage(turn.totalResponseLatency)}
            title={
              turn.totalResponseLatency === undefined
                ? 'Agent-initiated: there is no caller utterance to measure a wait from.'
                : 'EOU + TTFT + TTFB — what the caller actually waited through.'
            }
          />
        </dl>
      </section>

      <section className="detail__group">
        <h3 className="legend">Model</h3>
        <dl className="spec-list">
          <Row label="Model" value={model(llm?.model)} title={llm?.model} />
          <Row label="Prompt" value={count(llm?.prompt_tokens)} />
          <Row label="Output" value={count(llm?.completion_tokens)} />
          <Row
            label="Rate"
            value={
              llm?.tokens_per_second === undefined
                ? MISSING
                : `${llm.tokens_per_second.toFixed(1)} tok/s`
            }
          />
          <Row label="Calls" value={count(invocations)} />
        </dl>
        {llm?.chain && llm.chain.length > 0 ? <ChainBars chain={llm.chain} /> : null}
      </section>

      <section className="detail__group">
        <h3 className="legend">Audio</h3>
        <dl className="spec-list">
          <Row label="Caller" value={seconds(stt?.audio_duration)} />
          <Row label="STT" value={model(stt?.model)} title={stt?.model} />
          <Row label="Agent" value={seconds(tts?.audio_duration)} />
          {ttsCharacters !== undefined ? (
            <Row label="Chars" value={integer(ttsCharacters)} />
          ) : null}
          <Row label="TTS" value={model(tts?.model)} title={tts?.model} />
        </dl>
      </section>

      {turn.degraded || turn.interruptions.length > 0 ? (
        <div className="detail__flags">
          {turn.degraded ? (
            <span className="chip chip--alarm">Chaos degraded</span>
          ) : null}
          {bargeIns > 0 ? (
            <span className="chip chip--info">
              {bargeIns === 1 ? 'Barge-in' : `${bargeIns} barge-ins`}
            </span>
          ) : null}
          {falseInterruptions > 0 ? (
            <span className="chip chip--quiet">
              {falseInterruptions === 1
                ? 'False interruption'
                : `${falseInterruptions} false interruptions`}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="num" title={title}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The tool chain, one mini-bar per invocation.
 *
 * The bright leading segment is that call's own time to first token; the dim
 * remainder is the rest of its duration. All bars share one scale, so a chain
 * where the *last* call was the slow one looks different from one where the
 * first was — which is the whole reason to draw it rather than print the sum.
 *
 * The gaps between bars are not drawn: the SDK does not measure tool execution
 * time, so the space between one invocation ending and the next beginning is
 * unmeasured, and inventing a width for it would be inventing data.
 */
function ChainBars({ chain }: { chain: readonly LlmChainLink[] }) {
  const scale = chain.reduce((max, link) => Math.max(max, link.duration, link.ttft), 0);
  const width = (value: number) => (scale > 0 ? (value / scale) * 100 : 0);

  return (
    <ol className="chain" aria-label="Per-invocation breakdown of the tool chain">
      {chain.map((link, index) => (
        <li className="chain__row" key={index}>
          <span className="chain__ord num">#{index + 1}</span>
          {/* Height matches the viewBox height, so stretching the box to the
              column width scales x only and the bar keeps its weight. */}
          <svg className="chain__bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
            <rect className="chain__tail" x={0} y={0} width={width(link.duration)} height={8} />
            <rect className="chain__ttft" x={0} y={0} width={width(link.ttft)} height={8} />
          </svg>
          <span className="chain__figure num">
            {ms(link.ttft)} / {ms(link.duration)}
            <small>ms</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

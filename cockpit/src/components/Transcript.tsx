/**
 * What was said, with what it cost in time. Interim user text updates in place
 * and is marked provisional; a final user line carries its turn's latency, so
 * the transcript reads as a record rather than a chat log.
 *
 * Text here is caller speech and model output — it is rendered as React
 * children and therefore escaped. Never introduce dangerouslySetInnerHTML.
 */

import { useEffect, useRef } from 'react';
import { LATENCY_BUDGET_SECONDS } from '../telemetry/store';
import type { TranscriptLine, Turn } from '../telemetry/store';
import { ms } from '../format';

interface TranscriptProps {
  lines: TranscriptLine[];
  turns: Turn[];
  /** Replays and debriefs start at the top; a live call follows the tail. */
  follow: boolean;
}

export function Transcript({ lines, turns, follow }: TranscriptProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));

  useEffect(() => {
    if (!follow || !paneRef.current) return;
    paneRef.current.scrollTop = paneRef.current.scrollHeight;
  }, [follow, lines]);

  if (lines.length === 0) {
    return <p className="wf-empty">Nothing said yet.</p>;
  }

  return (
    // The wrapper exists only to hang a bottom fade off: a scroll pane whose
    // last line ends flush with the panel edge reads as the end of the record.
    <div className="transcript-pane">
      <div className="transcript" ref={paneRef}>
        {lines.map((line) => {
          const turn = turnsById.get(line.turnId);
          const showTiming =
            line.role === 'user' && line.final && turn?.totalResponseLatency !== undefined;

          return (
            <div
              key={`${line.turnId}:${line.role}`}
              className={`line line--${line.role}${line.final ? '' : ' line--interim'}`}
            >
              <div className="line__who">{line.role === 'user' ? 'Caller' : 'Agent'}</div>
              <div className="line__body">
                <p className="line__text">{line.text}</p>
                {showTiming && turn ? (
                  <div className="line__meta">
                    <span
                      className={`chip ${
                        turn.degraded
                          ? 'chip--alarm'
                          : turn.totalResponseLatency! > LATENCY_BUDGET_SECONDS
                            ? 'chip--warn'
                            : 'chip--ok'
                      }`}
                    >
                      {ms(turn.totalResponseLatency!)} ms to answer
                    </span>
                    {turn.llm ? (
                      <span className="chip chip--quiet">TTFT {ms(turn.llm.ttft)} ms</span>
                    ) : null}
                    {turn.interruptions.includes('barge_in') ? (
                      <span className="chip chip--info">Barge-in</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

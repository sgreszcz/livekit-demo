/**
 * A stored call at /call/:id. The record is replayed through the same reducer
 * as a live session, so the instruments are identical — just no longer moving.
 */

import { useEffect, useState } from 'react';
import { CockpitBoard } from '../components/CockpitBoard';
import { Footer } from '../components/Footer';
import { Mark } from '../components/Mark';
import { navigate } from '../router';
import { isEnvelope, type DebriefRecord } from '../telemetry/schema';
import { reduceAll, type CockpitState } from '../telemetry/store';
import { clockTime } from '../format';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; state: CockpitState; record: DebriefRecord };

export function DebriefView({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/debrief/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (response.status === 404) {
          throw new Error("This call recording has expired or doesn't exist.");
        }
        if (!response.ok) throw new Error(`Could not load this call (${response.status})`);

        const record = (await response.json()) as DebriefRecord;
        const messages = Array.isArray(record.messages) ? record.messages.filter(isEnvelope) : [];
        setLoad({
          status: 'ready',
          record,
          state: reduceAll(messages),
        });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setLoad({
          status: 'error',
          message: cause instanceof Error ? cause.message : 'Could not load this call',
        });
      }
    })();

    return () => controller.abort();
  }, [id]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__mark">
          <Mark />
          Glass <span>Cockpit</span>
        </div>
        <span className="lamp lamp--idle">Recorded call</span>
        <div className="topbar__spacer" />
        <div className="topbar__actions">
          <button type="button" className="btn btn--quiet" onClick={() => navigate('/')}>
            <span className="wide-only">Make your own call</span>
            <span className="narrow-only">New call</span>
          </button>
        </div>
      </header>

      {load.status === 'loading' ? <p className="state-note">Loading call {id}…</p> : null}
      {/* A missing recording is a dead end, not a fault: neutral, and it hands
          the visitor somewhere to go. Red on this page means degraded telemetry
          and nothing else. */}
      {load.status === 'error' ? (
        <div className="notice">
          <span>{load.message}</span>
          <a className="notice__action" href="/?fixture=1">
            Watch the sample flight instead
          </a>
        </div>
      ) : null}

      {load.status === 'ready' ? (
        <>
          <div className="debrief-bar">
            <div className="debrief-bar__text">
              <span className="legend">Debrief · {id}</span>
              <p>
                {load.state.turns.length} turns
                {load.record.ended_at ? ` · ended ${clockTime(load.record.ended_at)}` : ''}
                {load.state.meta ? ` · ${load.state.meta.entry} entry` : ''}
              </p>
            </div>
          </div>
          <CockpitBoard state={load.state} follow={false} />
        </>
      ) : null}

      <Footer />
    </div>
  );
}

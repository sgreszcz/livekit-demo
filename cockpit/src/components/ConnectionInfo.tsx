/**
 * Which room, which models, and how the caller got in.
 *
 * Every field is read defensively. Ingest validation should mean a `call_meta`
 * payload is complete by the time it lands here, but this panel also renders
 * records fetched from KV, and a viewer must degrade to a dash rather than
 * throw on a field an older or crafted record happens to be missing.
 */

import type { CallMetaPayload } from '../telemetry/schema';
import { clockTime, duration, shortModel } from '../format';

interface ConnectionInfoProps {
  meta: CallMetaPayload | null;
  durationSeconds: number;
  turnCount: number;
}

const MISSING = '—';

const ENTRY_LABELS: Record<string, string> = {
  browser: 'Browser (WebRTC)',
  sip: 'Phone (SIP trunk)',
};

function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : MISSING;
}

function model(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? shortModel(value) : MISSING;
}

function started(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? clockTime(value) : MISSING;
}

export function ConnectionInfo({ meta, durationSeconds, turnCount }: ConnectionInfoProps) {
  if (!meta) {
    return <p className="wf-empty">Waiting for the agent to announce itself.</p>;
  }

  const pipeline = meta.pipeline as Partial<CallMetaPayload['pipeline']> | undefined;

  return (
    <dl className="spec-list">
      <Row label="Room" value={text(meta.room)} />
      <Row label="Call ID" value={text(meta.call_id)} />
      <Row label="Entry" value={ENTRY_LABELS[meta.entry] ?? text(meta.entry)} />
      <Row label="Started" value={started(meta.started_at)} />
      <Row label="Elapsed" value={`${duration(durationSeconds)} · ${turnCount} turns`} />
      <Row label="STT" value={model(pipeline?.stt)} title={pipeline?.stt} />
      <Row label="LLM" value={model(pipeline?.llm)} title={pipeline?.llm} />
      <Row label="TTS" value={model(pipeline?.tts)} title={pipeline?.tts} />
    </dl>
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

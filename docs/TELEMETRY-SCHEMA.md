# Glass Cockpit telemetry schema (v1)

The contract between the Python agent worker (`agent/`) and the cockpit SPA (`cockpit/`).
Neither side changes this file unilaterally — it is the single source of truth both are
tested against.

## Transport

- Agent → browser: LiveKit data channel, `publish_data(payload, topic="cockpit", reliable=True)`.
- Browser → agent (chaos toggle): same channel, topic `cockpit-control`.
- Payload: UTF-8 JSON, one envelope per message, max ~15 KB (data channel packet limit is
  15 KiB — an oversized transcript is truncated with an explicit `…[truncated]` marker).

## Envelope

```json
{
  "v": 1,
  "type": "turn | transcript | state | interruption | usage | chaos | call_meta | transport",
  "ts": 1723000000.123,          // unix seconds, agent clock, float
  "speech_id": "abc123",         // present where the SDK provides one
  "payload": { ... }             // type-specific, see below
}
```

## Message types

### `turn` — per-turn latency waterfall (the core message)
Emitted incrementally as each stage's metrics arrive for a `speech_id`; the frontend
merges partial `turn` messages by `speech_id` (last-write-wins per field). All durations
in **seconds** (SDK-native), frontend renders ms.

```json
{
  "turn_id": "abc123",              // == speech_id
  "eou": { "end_of_utterance_delay": 0.42, "transcription_delay": 0.11 },
  "stt": { "duration": 0.0, "audio_duration": 2.10, "model": "deepgram/nova-3" },
  "llm": { "ttft": 0.35, "duration": 1.20, "prompt_tokens": 900, "completion_tokens": 60,
            "tokens_per_second": 48.0, "llm_calls": 1, "model": "..." },
  "tts": { "ttfb": 0.18, "duration": 1.90, "audio_duration": 3.40, "model": "cartesia/sonic-3" },
  "total_response_latency": 0.95,   // eou.end_of_utterance_delay + llm.ttft + tts.ttfb (agent computes)
  "degraded": false                 // true if chaos delay was applied to this turn's LLM chain
}
```

Semantics that both sides MUST honor:

- **The stages overlap in real time.** The *perceived* critical path is
  `eou.end_of_utterance_delay + llm.ttft + tts.ttfb` — that sum IS
  `total_response_latency` and is the only thing compared against a latency budget.
  `transcription_delay` runs concurrently within the EOU window (render as overlay,
  never additive). `llm.duration − llm.ttft` (generation tail) and `tts.duration`
  overlap agent speech — the caller is already hearing audio — so they render as
  de-emphasised overlays, never as part of the solid bar. A waterfall whose solid
  bar width disagrees with the printed `total_response_latency` is a bug.
- **Tool-calling turns run the LLM more than once.** `llm` reports the *chain*:
  `llm_calls` = number of invocations (OPTIONAL — consumers MUST read a missing
  value as 1), an OPTIONAL `chain` array (`[{ "ttft": 0.4, "duration": 1.1 }, …]`,
  one entry per invocation in order, emitted when `llm_calls > 1`) lets the
  frontend show the per-invocation breakdown, `prompt_tokens`/`completion_tokens`
  are summed,
  `duration` is the summed chain duration, and `ttft` is the *effective perceived*
  first token — Σ durations of all invocations before the last, plus the last
  invocation's ttft. (Tool execution time between invocations is not measured by the
  SDK and is therefore not included; it can make audible latency exceed the bar.)
- **Agent-initiated turns** (the greeting) have no `eou`, no `stt`, no user transcript
  and never a `total_response_latency`; the frontend renders a partial row.
- **Streaming STT reports `duration` 0.0** in livekit-agents 1.6.8; only
  `audio_duration` is meaningful.

### `transcript`
```json
{ "role": "user | agent", "text": "...", "final": true, "turn_id": "abc123" }
```
Interim user transcripts have `"final": false` and may repeat; frontend replaces by turn_id+role until final.

### `state`
```json
{ "state": "initializing | listening | thinking | speaking", "prev": "listening" }
```

### `interruption`
```json
{ "kind": "barge_in | false_interruption", "turn_id": "abc123" }
```
`barge_in`: agent_state_changed speaking→listening/thinking before speech completed.

### `usage` — running totals, emitted after each turn
```json
{
  "llm_prompt_tokens": 4200, "llm_completion_tokens": 380,
  "stt_audio_seconds": 33.5, "tts_characters": 1240,
  "est_cost_usd": 0.0123          // from price table in agent config; labeled approximate in UI
}
```

### `chaos` — agent acknowledges a control change (also flags UI)
```json
{ "llm_delay_ms": 800, "active": true }
```

### `transport` — browser-sourced WebRTC transport samples (v1.1)
Unlike every other type, `transport` envelopes are created BY THE COCKPIT ITSELF
(the agent never sees the caller's network path): the browser samples
`livekit-client` `getStats()` roughly every 2 s and feeds the envelope into the
same store as remote telemetry. They are never sent over the data channel, and
appear only in browser-posted debriefs.

```json
{ "rtt_ms": 48, "jitter_ms": 4.1, "packet_loss_pct": 0.0, "quality": "excellent | good | poor | lost | unknown" }
```

### `call_meta` — once, on agent join
```json
{ "call_id": "rm_xyz", "room": "cockpit-...", "started_at": 1723000000.0,
  "pipeline": { "stt": "deepgram/nova-3", "llm": "...", "tts": "cartesia/sonic-3" },
  "entry": "browser | sip" }
```

## Observers (v1.2)

A participant whose identity starts with `observer-` is a read-only viewer (subscribe
only, no mic, no data publishing — enforced by its token grants). When one joins
mid-call, the agent replays every envelope emitted so far, in original order,
byte-identical, via `publish_data(..., destination_identities=[<observer>])` —
**addressed to that observer only**, so the caller's own cockpit never receives
duplicates. Observers then receive live envelopes exactly like the caller does.
The snapshot is a retransmission, not an emission: it does not appear in debriefs.

## Control channel (browser → agent, topic `cockpit-control`)

```json
{ "v": 1, "type": "chaos", "payload": { "llm_delay_ms": 800 } }   // 0 = off
```

## Debrief (agent → Worker, HTTP POST at session end)

`POST $DEBRIEF_URL` with header `Authorization: Bearer $DEBRIEF_TOKEN`:
```json
{ "call_id": "...", "meta": { ...call_meta payload... }, "ended_at": 1723000123.0,
  "messages": [ ...every envelope emitted during the call, in order... ] }
```
Worker stores to KV under a short random id and returns `{ "id": "k7Qx2f", "url": "https://cockpit.agentmaker.io/call/k7Qx2f" }`.
The agent logs the URL; for browser calls the frontend also assembles its own copy live.

## Fixture

`docs/fixtures/sample-call.jsonl` — one envelope per line, 72 envelopes, 49.5s: an
agent greeting (t0, partial turn) plus six user turns (t1–t6) including one barge-in
and two chaos-degraded turns. Generated programmatically with producer-consistent
event ordering (user transcript + eou + buffered stt flush together; usage after each
speaking→listening transition) and cumulative usage totals priced by `agent/pricing.py`.
Regenerate via the generator script rather than hand-editing.

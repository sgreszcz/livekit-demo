# Glass Cockpit — agent worker

A LiveKit voice agent that measures itself and streams the results to the cockpit SPA.

```
agent.py       entrypoint: persona, pipeline, session event wiring, debrief upload
telemetry.py   TurnStore (per-turn merge, usage, barge-in) + envelope builders + publisher
chaos.py       ChaosController and the DelayedLLM wrapper
pricing.py     approximate price table for the running cost estimate
```

The whole pipeline runs on **LiveKit Inference**, so the only credentials needed are
`LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.

## Running

```bash
uv sync
uv run pytest                    # offline, no credentials needed

uv run python agent.py console   # talk to it locally through your microphone
uv run python agent.py dev       # worker against LiveKit Cloud, hot reload
uv run python agent.py start     # production worker
```

Models are configurable; the defaults are the ones the cockpit expects.

| Variable | Default |
| --- | --- |
| `COCKPIT_STT_MODEL` | `deepgram/nova-3` |
| `COCKPIT_LLM_MODEL` | `openai/gpt-4.1-mini` |
| `COCKPIT_TTS_MODEL` | `cartesia/sonic-3` |
| `DEBRIEF_URL` | unset — debrief upload is skipped |
| `DEBRIEF_TOKEN` | unset |

## How the telemetry is assembled

The wire format is fixed by [`docs/TELEMETRY-SCHEMA.md`](../docs/TELEMETRY-SCHEMA.md).
The interesting part is that the SDK does *not* hand you a finished turn — it reports
each stage separately, on its own schedule, and only some of those reports carry a
speech id:

| Signal | Carries `speech_id`? |
| --- | --- |
| `EOUMetrics` | yes — this is what names the turn |
| `LLMMetrics`, `TTSMetrics` | yes |
| `STTMetrics` | **no** |
| `user_input_transcribed` | **no** (has an `item_id`, not a speech id) |

`TurnStore` reconciles this. The caller's transcript and the STT metrics both describe
the utterance *before* turn detection has named the turn it triggers, so they are
buffered and published by `record_eou` once an id exists. Attributing them on arrival
would file them against the previous turn.

For `eou` and `tts` the first metric of a turn wins. `llm` and `stt` accumulate,
because both stages can report more than once for a single turn. A turn that calls a
tool runs the LLM twice, so the `llm` block describes the whole chain: `llm_calls`
counts the invocations, tokens and duration are summed, and `ttft` is the *perceived*
first token — every earlier invocation ran to completion before the last one started.
Each invocation re-publishes the turn, and `total_response_latency` with it if the
chain grew after the totals first went out; the cockpit's last-write-wins merge takes
the corrected value.

Envelopes are published through a single queue drained by one task, so wire order
matches emission order — the cockpit relies on that when merging partial turns.

## Chaos mode

`DelayedLLM` wraps the Inference LLM and sleeps *inside* the stream the SDK is already
timing, so the injected delay lands in the reported `ttft` and every downstream stage
shifts with it. The degradation the cockpit renders is therefore real, not cosmetic.
The delay lives in a shared `ChaosController`, so the browser can retune it mid-call
over the `cockpit-control` topic without swapping models or restarting the session.

Because the toggle can move mid-turn, a turn is *not* marked `degraded` from whatever
the switch reads when its metrics arrive. `DelayedLLM` logs the delay it actually
applied against the completion's request id, and `TurnStore` claims that entry when
the matching `LLMMetrics` lands; a turn is degraded if any invocation in its chain
really was delayed.

## Deviations from the schema doc

Two, both forced by the SDK, neither structural:

1. **Interim user transcripts are not emitted.** The schema allows `"final": false`
   transcripts. The SDK exposes no speech id until end-of-utterance, so an interim
   transcript cannot be given a correct `turn_id`; publishing it under a provisional id
   would leave the frontend with an orphan row it never resolves. Only final user
   transcripts go out. Agent transcripts and all other types are unaffected.

2. **`AgentState` has a fifth value, `idle`, that the schema does not model.** It is
   reported as `listening`.

`docs/fixtures/sample-call.jsonl` is generated, and its `usage` totals are priced by
`pricing.py`, so the tests reproduce them exactly. Its `llm` blocks omit `llm_calls`
(every fixture turn is a single invocation); consumers should read a missing
`llm_calls` as one.

## Deploying

```bash
lk agent create      # first time
lk agent deploy
```

The `Dockerfile` targets `python:3.12-slim`, installs with `uv sync --locked`, and
runs `python agent.py start`.

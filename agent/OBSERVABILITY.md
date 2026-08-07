# Observing the agent in production

What LiveKit Cloud actually gives you, what it does not, and what this agent now emits
to make up the difference. Everything below was verified against
`livekit-agents 1.6.8` in `agent/.venv/lib/python3.12/site-packages/livekit/agents/`
unless it is explicitly flagged as needing a live call.

## 1. `lk agent logs` is already structured JSON

`lk agent logs` streams the worker process's stdout. The SDK's production log handler
emits **one JSON object per line**, so no extra plumbing is needed to parse it. Fields
observed in production:

| field | meaning |
| --- | --- |
| `message` | the formatted log text |
| `level` | `INFO`, `WARNING`, … |
| `name` | logger name (`glass-cockpit`, `livekit.agents`, …) |
| `pid` | worker process id |
| `job_id` | e.g. `AJ_pRqFWmUmK8jE` — the unit that maps 1:1 to a room |
| `room` | **the raw room name** |
| `timestamp` | ISO-8601 |

Because of that, the per-call summary this agent emits (`telemetry.log_call_summary`) is
machine-readable straight out of the CLI. The line is the marker `call_summary`, one
space, then compact single-line JSON:

```
call_summary {"call_id":"RM_abc","entry":"sip","room":"sip-cockpit-_+REDACTED_5xzpp",...}
```

Fleet latency from the last hour of logs:

```sh
lk agent logs --since 1h \
  | jq -c 'select(.message | startswith("call_summary"))
           | .message | sub("^call_summary "; "") | fromjson' \
  | jq -s '{
      calls:  length,
      sip:    (map(select(.entry=="sip"))    | length),
      worst_p95_ms: (map(.latency_p95_ms | select(. != null)) | max),
      median_p50_ms:(map(.latency_p50_ms | select(. != null)) | sort
                     | if length==0 then null else .[(length/2|floor)] end),
      total_cost_usd: (map(.est_cost_usd) | add),
      hangups: (map(select(.close_reason=="participant_disconnected")) | length)
    }'
```

Every field in the summary — `call_id`, `entry`, `room`, `close_reason`,
`duration_seconds`, `turns`, `turns_completed`, `latency_p50_ms`, `latency_p95_ms`,
`degraded_turns`, `barge_ins`, `prompt_tokens`, `completion_tokens`, `stt_seconds`,
`tts_characters`, `est_cost_usd` — is a scalar, on purpose: a log aggregator can group
and sum them without a schema. Percentiles are **nearest rank**
(`rank = ceil(p/100 × n)`, 1-indexed, clamped), so every value reported is a latency some
turn really had; they are `null`, never `0`, when the call completed no turns.

> ### ⚠️ LiveKit's own log lines leak the caller's phone number
>
> The `room` field on every LiveKit-emitted line carries the **raw** room name, and SIP
> dispatch names rooms after the caller: `sip-cockpit-_+447700900123_5xzppVvwo6Px`. That
> is outside this repo's control — it is the SDK's own logging context.
>
> What *is* in this repo's control is redacted at source (`telemetry.redact_room_name`,
> mirroring `redactRoomName` in `worker/src/rooms.ts` byte for byte): the `room` field of
> `call_meta`, and therefore the data channel, every stored debrief, and the
> `call_summary` line. Treat `lk agent logs` output as PII: do not paste it into tickets,
> and do not ship it to a log store with a longer retention than you would give a phone
> book.

## 2. Session close ≠ job shutdown — this is why debriefs were lost

The single most important operational fact about this SDK:

**A job lives until the ROOM closes, and a room stays open while any participant is in
it.** The agent session closing (caller hung up) does not end the job.

Verified in production. Job `AJ_pRqFWmUmK8jE`: the session closed at 10:47:32 —
`"closing agent session due to participant disconnect"`, reason `CLIENT_INITIATED`, the
SIP caller had hung up. Eleven minutes later the process had still not exited and no
debrief had been posted, because an observer cockpit (`observer-Ma8WeW6P`) had joined at
10:47:22 and was still sitting in the room holding it open.

The old code posted the debrief from `ctx.add_shutdown_callback(...)` alone. So:

* a lingering observer or an abandoned browser tab deferred the debrief **indefinitely**;
* if the worker drained or was redeployed in that window, the call was lost for good;
* only 2 of many SIP calls ever produced a stored debrief.

Two more compounding faults, both fixed:

* The shutdown callback was registered **after** `await _resolve_entry(ctx)`, which waited
  for the caller participant with no timeout. A caller who hung up before the agent
  finished connecting meant that await never resolved, so the callback was never even
  registered — the call left no record at all. Entry is now derived synchronously from the
  room name (`telemetry.classify_entry_room`, same prefix rule as `classifyEntry` in
  `worker/src/active.ts`); the participant wait survives only as a fire-and-forget
  diagnostic that logs a warning if the two disagree, and gates nothing.
* The upload used `httpx.AsyncClient(timeout=10.0)`, but
  `livekit.agents.worker.WorkerOptions.shutdown_process_timeout` is `10.0` **total** for
  the whole job shutdown, enforced at `ipc/supervised_proc.py:327` by
  `asyncio.wait_for(self._shutdown_ack_fut, timeout=close_timeout)` and then a hard kill.
  `publisher.aclose()` spends part of that budget first. A slow upload was killed with no
  log line at all. The final POST is now `FINAL_TIMEOUT = 4.0` and logs a warning naming
  the timeout when it is exceeded.

### What the agent does now

| when | what | verb | timeout |
| --- | --- | --- | --- |
| every `CHECKPOINT_SECONDS = 15` while live | checkpoint, `in_progress: true` | `PUT` | `3.0` |
| `session.on("close")` | `call_summary` log line + final debrief, `in_progress: false` | `POST` | `4.0` |
| `ctx.add_shutdown_callback` | retry the final debrief if the close path failed | `POST` | `4.0` |

* `ended_at` for the final debrief is `CloseEvent.created_at` — the **session** close time.
  Taking `time.time()` at job shutdown is what once stored a 10.5-second conversation as a
  4376-second call.
* Checkpoints are skipped when the envelope count has not moved, are stopped before the
  final flush (the Worker deletes the checkpoint record on the final `POST`, so a late
  checkpoint would resurrect the call as permanently in-progress), and can never raise.
* The final body is uploaded **once on success**. A failed session-close flush is left
  un-finalised on purpose so the shutdown path retries it; the Worker upserts by `call_id`,
  so a duplicate is survivable anyway.
* A call that dies mid-flight now loses at most 15 seconds, and Grafana can see calls in
  progress.

`CloseEvent` (`livekit/agents/voice/events.py:582`) carries `.reason` — a `CloseReason`
str-enum of `error`, `job_shutdown`, `participant_disconnected`, `user_initiated`,
`task_completed` — and `.created_at` (float unix seconds). The handler is **synchronous**;
the flush is handed to `asyncio.create_task` and the task reference is held, because
`create_task` keeps only a weak one.

## 3. `session_usage_updated` — the SDK's own accounting

There is a second source of truth for tokens and characters that this repo does not use.

* `SessionUsageUpdatedEvent` (`livekit/agents/voice/events.py:410`) carries
  `usage: AgentSessionUsage`, which is `model_usage: list[ModelUsage]`
  (`livekit/agents/metrics/usage.py:129`).
* It is aggregated per `(provider, model)` by `ModelUsageCollector`
  (`livekit/agents/metrics/usage.py:133`) and emitted from
  `voice/agent_activity.py:1842`.
* It is richer than this repo's totals: cached vs uncached input tokens, audio vs text
  tokens, per-provider splits, TTS `characters_count` and `audio_duration`.

Production logs currently print:

```
metrics_collected is deprecated. Use session_usage_updated for usage tracking
and ChatMessage.metrics for per-turn latency.
```

emitted from `AgentSession.on` (`voice/agent_session.py:705-711`) the moment anything
subscribes to `metrics_collected`. This repo's whole telemetry pipeline is wired to
`metrics_collected`, so **it is on a deprecation path for SDK v2.0**.

**Not wired, deliberately.** `metrics_collected` still works in 1.6.8, and
`session_usage_updated` is *usage only* — it carries no `ttft`, no `ttfb`, no
`end_of_utterance_delay`, so it cannot feed the latency waterfall that is this demo's
entire subject. Rewriting the pipeline onto it now would be a large change that buys
nothing today.

**Recommendation** (small, additive, do it before the v2.0 bump): subscribe to
`session_usage_updated`, keep the latest event, and fold its per-`(provider, model)`
totals into the `call_summary` line as a `sdk_usage` block alongside the existing
`prompt_tokens`/`completion_tokens`. That gives an independent cross-check of the cost
estimate at near-zero cost, and makes the v2.0 migration a deletion rather than a
rewrite. Per-turn latency will need `ChatMessage.metrics`, which is the larger piece of
that migration.

## 4. Still needs a live call to confirm

Everything above about the SDK was read from the installed source or observed in
production logs. These have **not** been observed end to end and should be checked on the
next real call:

1. **That `session.on("close")` actually fires on a SIP hangup**, and how long before
   `CloseReason.PARTICIPANT_DISCONNECTED` arrives. All unit coverage stubs the event.
2. **That the final `POST` completes inside 4.0 s from the deployed region** to the
   Cloudflare Worker. If `debrief upload exceeded FINAL_TIMEOUT` shows up in
   `lk agent logs`, the budget needs re-splitting between `publisher.aclose()` and the
   upload — not a longer timeout, which is what caused the original silent kill.
3. **That checkpoints land and are deleted.** Confirm a `PUT` every 15 s during a call,
   that the in-progress record disappears from KV after the final `POST`, and that no
   checkpoint arrives after it.
4. **That the observer-holds-the-room case is now harmless**: join as an observer, hang up
   the SIP leg, and confirm the debrief is stored immediately rather than minutes later.
5. **That `call_summary` appears in `lk agent logs` as a parseable line** with the `jq`
   pipeline above, and that `duration_seconds` matches the real call length rather than
   the job's lifetime.
6. **That the entry cross-check stays silent.** An `entry mismatch` warning means the room
   naming convention moved and `classify_entry_room` needs updating on both sides.

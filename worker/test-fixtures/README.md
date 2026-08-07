# Real call recordings, used as test fixtures

Five debriefs pulled verbatim from the production KV namespace on 2026-08-07.
They exist so `src/fixtures.test.ts` can check the fleet arithmetic against
recordings the code did not get to influence — synthetic fixtures agree with
whatever misunderstanding produced them.

These are the recordings in which `GET /api/metrics` reported
`avg_call_seconds: 536.8`.

## Sanitisation

Exactly one thing was changed: the caller's phone number in SIP room names was
replaced with `+447700900123`, from Ofcom's range reserved for drama and
fiction. Nothing else — not a timestamp, not a measurement, not a transcript —
was altered, so the numbers in the tests are the numbers the system produced.

The transcripts were reviewed before being committed; they are a visitor asking
the demo about its own latency, and contain no personal data.

| file | what it is |
|---|---|
| `browser-greeting-only-idle.json` | **The bug.** 10.5 s of telemetry inside a 4376-second room. A visitor opened the cockpit, the agent greeted them, nobody replied, and the tab stayed open for over an hour holding the room — and therefore the agent's job — alive. `ended_at − started_at` called this a 73-minute call. |
| `browser-four-turns-long-tail.json` | A real four-turn conversation, 59.6 s long, followed by 183 s of silence before the room closed. The milder, and far more common, shape of the same problem. |
| `sip-eight-turns.json` | The richest recording: a phone call, 70 envelopes, 8 turns of which 6 completed, one turn with a two-invocation LLM chain. Its room name carries a phone number, so it is also the redaction fixture. |
| `sip-three-turns.json` | A shorter phone call, and the source of the fleet's slowest turn (5.339 s). |
| `browser-four-turns.json` | An ordinary browser call that ended normally — the control. |

## Refreshing them

Don't, casually: the expectations in `src/fixtures.test.ts` were computed by
hand from these exact envelopes, and replacing a file invalidates them. If you
do need new ones, re-derive every expectation by hand from the raw JSON rather
than by running the code and copying what it said — that is the entire point of
this directory.

Sanitise before writing anything to disk. The originals are fetched with:

```
npx wrangler kv key list --namespace-id <id> --remote
npx wrangler kv key get <key> --namespace-id <id> --remote
```

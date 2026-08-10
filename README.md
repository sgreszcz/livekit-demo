# Glass Cockpit

A LiveKit voice agent with its own flight recorder. Call it — from the browser or a
real UK phone number — and watch every turn of the conversation from the inside:
end-of-utterance detection, transcription, LLM time-to-first-token, TTS time-to-first-byte,
interruptions, and running cost, rendered live in a glass-cockpit dashboard. Ask the
agent "how's the call quality?" and it reads you its own telemetry. Flip the chaos
toggle and watch the waterfall degrade.

Built because the voice-agent demo is easy — production is where teams bleed.

- **Live demo:** https://cockpit.agentmaker.io — or call **+44 20 4652 7116** from any phone
- **Telemetry contract:** [docs/TELEMETRY-SCHEMA.md](docs/TELEMETRY-SCHEMA.md)

## Architecture

```
Phone (+44, Twilio elastic SIP trunk) ─┐
                                       ├─► LiveKit Cloud room ◄── Browser (livekit-client)
Python agent (livekit-agents,          │
  hosted on LiveKit Cloud Agents) ─────┘
  ├─ STT / LLM / TTS on LiveKit Inference — one API key, no provider sprawl
  ├─ per-turn telemetry → room data channel, topic "cockpit"
  ├─ chaos: runtime-injectable LLM latency, attributed per invocation
  ├─ get_call_metrics tool — the agent reads its own instruments
  ├─ demo calls hard-capped at 5 min (COCKPIT_MAX_CALL_SECONDS), spoken 30 s warning
  └─ end of call → POST debrief → Cloudflare KV → shareable /call/:id replay

Cloudflare Worker (cockpit.agentmaker.io)
  ├─ serves the cockpit SPA (Vite + React)
  ├─ POST /api/token    — mints scoped, short-TTL room tokens
  └─ POST/GET /api/debrief — stores and serves call recordings
```

## Repo layout

- `agent/` — Python voice agent worker (pipeline, telemetry bus, chaos, self-diagnostics tool)
- `cockpit/` — Vite + React cockpit SPA
- `worker/` — Cloudflare Worker: static hosting, LiveKit token minting, debrief storage
- `docs/` — the telemetry wire contract and the generated reference fixture

## Running it yourself

Prerequisites: Python 3.12+ with [uv](https://docs.astral.sh/uv/), Node 22+, a
[LiveKit Cloud](https://cloud.livekit.io) project (free tier is fine — Inference
runs under the same API key).

```bash
# agent: unit tests offline, console mode with mic once .env is filled from .env.example
cd agent && uv sync && uv run pytest
uv run python agent.py console

# cockpit: build + tests (fixture replay needs no credentials)
cd ../cockpit && npm install && npm run build && npm test

# worker: serves the built SPA + APIs locally
cd ../worker && npm install && npx vitest run
cp .dev.vars.example .dev.vars   # fill in LiveKit creds
npx wrangler dev                 # http://localhost:8787  (?fixture=1 = recorded call)
```

Deploying: `npx wrangler deploy` for the Worker (set `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `DEBRIEF_TOKEN` as secrets); `lk agent create` then
`lk agent deploy` from `agent/` for the worker process — note `agent/livekit.toml`
is this deployment's identity, so a fork deletes it and runs `lk agent create` fresh.
Inbound SIP is a Twilio elastic trunk pointed at your project's
`<subdomain>.sip.livekit.cloud` with a LiveKit inbound trunk + dispatch rule.

By Steve Greszczyszyn — [agentmaker.io](https://agentmaker.io)

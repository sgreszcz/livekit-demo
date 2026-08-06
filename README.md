# Glass Cockpit

A LiveKit voice agent with its own flight recorder. Call it — from the browser or a
real UK phone number — and watch every turn of the conversation from the inside:
end-of-utterance detection, transcription, LLM time-to-first-token, TTS time-to-first-byte,
interruptions, and running cost, rendered live in a glass-cockpit dashboard. Ask the
agent "how's the call quality?" and it reads you its own telemetry. Flip the chaos
toggle and watch the waterfall degrade.

Built because the voice-agent demo is easy — production is where teams bleed.

- **Live demo:** https://cockpit.agentmaker.io — or call **+44 7782 684 287** from any phone
- **Architecture:** `docs/` — Python agent (livekit-agents + LiveKit Inference) deployed
  on LiveKit Cloud; telemetry over the room data channel; cockpit SPA + token/debrief
  API on a Cloudflare Worker; inbound SIP via Twilio trunk.
- **Telemetry contract:** [docs/TELEMETRY-SCHEMA.md](docs/TELEMETRY-SCHEMA.md)

## Repo layout

- `agent/` — Python voice agent worker (pipeline, telemetry bus, chaos, self-diagnostics tool)
- `cockpit/` — Vite + React cockpit SPA
- `worker/` — Cloudflare Worker: static hosting, LiveKit token minting, debrief storage
- `docs/` — schema, fixtures, role context

By Steve Greszczyszyn — [agentmaker.io](https://agentmaker.io)

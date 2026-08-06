"""Regenerate docs/fixtures/sample-call.jsonl with producer-consistent semantics.

Ordering mirrors what agent/telemetry.py can actually emit:
- greeting turn (agent-initiated): llm/tts turn envelopes + agent transcript, no eou
- per user turn: final transcript + eou flush, then stt (buffered, flushed with eou),
  llm, tts (which completes the waterfall), agent transcript, usage after speaking ends
- streaming STT reports duration 0.0 in livekit-agents 1.6.8
- usage totals are exact cumulative sums; est_cost_usd computed by pricing.py
"""

import json
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "agent"))
import pricing  # noqa: E402

PIPELINE = {"stt": "deepgram/nova-3", "llm": "openai/gpt-4.1-mini", "tts": "cartesia/sonic-3"}
T0 = 1723000000.0

lines = []
clock = [T0]
totals = {"prompt": 0, "completion": 0, "stt": 0.0, "chars": 0}


def ts(dt=0.0):
    clock[0] += dt
    return round(clock[0], 1)


def env(type_, payload, speech_id=None, dt=0.1):
    e = {"v": 1, "type": type_, "ts": ts(dt)}
    if speech_id:
        e["speech_id"] = speech_id
    e["payload"] = payload
    lines.append(e)
    return e


def usage():
    cost = pricing.estimate_cost_usd(
        llm_model=PIPELINE["llm"], prompt_tokens=totals["prompt"],
        completion_tokens=totals["completion"], stt_model=PIPELINE["stt"],
        stt_audio_seconds=totals["stt"], tts_model=PIPELINE["tts"],
        tts_characters=totals["chars"],
    )
    env("usage", {
        "llm_prompt_tokens": totals["prompt"], "llm_completion_tokens": totals["completion"],
        "stt_audio_seconds": round(totals["stt"], 1), "tts_characters": totals["chars"],
        "est_cost_usd": cost,
    })


def llm_env(tid, ttft, dur, p, c, tps):
    totals["prompt"] += p
    totals["completion"] += c
    env("turn", {"turn_id": tid, "llm": {"ttft": ttft, "duration": dur, "prompt_tokens": p,
        "completion_tokens": c, "tokens_per_second": tps, "model": PIPELINE["llm"]}},
        speech_id=tid, dt=dur)


def tts_env(tid, ttfb, dur, audio, extra=None):
    env("turn", {"turn_id": tid, "tts": {"ttfb": ttfb, "duration": dur,
        "audio_duration": audio, "model": PIPELINE["tts"]}, **(extra or {})},
        speech_id=tid, dt=0.2)


def agent_says(tid, text):
    totals["chars"] += len(text)
    env("transcript", {"role": "agent", "text": text, "final": True, "turn_id": tid},
        speech_id=tid, dt=0.1)


def state(new, prev, dt=0.1):
    env("state", {"state": new, "prev": prev}, dt=dt)


# --- call start + greeting (agent-initiated: no eou, no user transcript) ---
env("call_meta", {"call_id": "RM_demo0001", "room": "cockpit-demo01", "started_at": T0,
    "pipeline": PIPELINE, "entry": "browser"}, dt=0.0)
state("listening", "initializing", 0.2)
state("thinking", "listening", 0.3)
llm_env("t0", 0.62, 1.4, 577, 79, 56.4)
state("speaking", "thinking", 0.1)
tts_env("t0", 0.19, 2.1, 9.4)
agent_says("t0", "Welcome to Glass Cockpit. You're talking to a LiveKit voice agent, and everything on your screen is my own live telemetry — every turn we take, measured stage by stage. Ask me about the numbers, or try chaos mode.")
clock[0] += 8.5
usage()
state("listening", "speaking")

TURNS = [
    # tid, user text, eou(eou_delay, trans_delay), stt_audio, llm(ttft,dur,p,c,tps),
    # tts(ttfb,dur,audio), agent text, degraded, barge_in
    ("t1", "Hey, what is this demo exactly?", (0.41, 0.12), 3.1, (0.34, 1.1, 820, 58, 52.7),
     (0.19, 2.0, 4.2),
     "You're seeing my flight recorder. Every turn is broken into end-of-utterance detection, my first token, and my first audio byte — the three delays you actually experience as waiting.", False, False),
    ("t2", "How's the call quality right now?", (0.38, 0.10), 2.8, (0.61, 1.4, 1090, 74, 49.0),
     (0.17, 2.3, 5.0),
     "Your last turn took about nine hundred and forty milliseconds end to end — four hundred and ten in turn detection, three hundred and forty to my first token, one ninety to first audio. We're in good shape.", False, False),
    ("t3", "Turn on chaos mode, eight hundred milliseconds.", (0.44, 0.13), 2.5,
     (1.15, 1.9, 2010, 41, 47.2), (0.18, 1.6, 3.2),
     "Chaos is on — I'm now adding eight hundred milliseconds before every response. Watch my waterfall get worse.", True, False),
    ("t4", "Yeah, this feels slower now.", (0.40, 0.11), 2.6, (1.21, 2.0, 4050, 66, 46.1),
     (0.20, 2.4, 5.1),
     "Exactly — that pause you just felt is the injected model latency. In production this is what a slow region or an overloaded provider feels like.", True, True),
    ("t5", "Okay okay, turn it off.", (0.39, 0.10), 2.2, (0.33, 0.9, 5100, 38, 51.3),
     (0.18, 1.4, 2.9),
     "Chaos off. You also just barged in on me — you'll see that marked on the previous turn. Back to nominal.", False, False),
    ("t6", "Cool. Who built you?", (0.42, 0.12), 2.7, (0.36, 1.2, 6200, 71, 50.4),
     (0.19, 2.2, 4.8),
     "Steve Greszczyszyn — twenty years of Cisco voice infrastructure, now building AI agents. He built this cockpit because the demo is the easy part; production is where teams bleed.", False, False),
]

for tid, user, (eou_d, tr_d), stt_audio, (ttft, dur, p, c, tps), (ttfb, tdur, taudio), agent_text, degraded, barge in TURNS:
    clock[0] += 2.0  # user speaking
    if tid == "t3":
        # chaos toggle arrives from the dashboard while the user is mid-request
        env("chaos", {"llm_delay_ms": 800, "active": True}, dt=0.3)
    if tid == "t5":
        env("chaos", {"llm_delay_ms": 0, "active": False}, dt=0.3)
    # eou flush order: user transcript, eou, buffered stt — same batch, same ts
    env("transcript", {"role": "user", "text": user, "final": True, "turn_id": tid},
        speech_id=tid, dt=eou_d)
    env("turn", {"turn_id": tid, "eou": {"end_of_utterance_delay": eou_d,
        "transcription_delay": tr_d}}, speech_id=tid, dt=0.0)
    totals["stt"] += stt_audio
    env("turn", {"turn_id": tid, "stt": {"duration": 0.0, "audio_duration": stt_audio,
        "model": PIPELINE["stt"]}}, speech_id=tid, dt=0.0)
    state("thinking", "listening", 0.0)
    llm_env(tid, ttft, dur, p, c, tps)
    state("speaking", "thinking", 0.0)
    total = round(eou_d + ttft + ttfb, 3)
    tts_env(tid, ttfb, tdur, taudio,
            {"total_response_latency": total, "degraded": degraded})
    agent_says(tid, agent_text)
    if barge:
        clock[0] += 1.5
        env("interruption", {"kind": "barge_in", "turn_id": tid}, speech_id=tid, dt=0.0)
        state("listening", "speaking", 0.0)
    else:
        clock[0] += max(0.5, taudio - tdur)
        state("listening", "speaking")
    usage()

out = str(__import__("pathlib").Path(__file__).resolve().parent / "sample-call.jsonl")
with open(out, "w") as f:
    for line in lines:
        f.write(json.dumps(line, separators=(",", ":")) + "\n")

print(f"{len(lines)} envelopes; duration {round(clock[0]-T0,1)}s; "
      f"final usage {totals} cost "
      f"{pricing.estimate_cost_usd(llm_model=PIPELINE['llm'], prompt_tokens=totals['prompt'], completion_tokens=totals['completion'], stt_model=PIPELINE['stt'], stt_audio_seconds=totals['stt'], tts_model=PIPELINE['tts'], tts_characters=totals['chars'])}")

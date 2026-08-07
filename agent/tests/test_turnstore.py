"""Offline tests for the telemetry store, envelope shapes and chaos control.

Nothing here touches the network or needs LiveKit credentials. The store is fed
synthetic metrics in the order the SDK really emits them, and one test replays the
recorded call in ``docs/fixtures/sample-call.jsonl`` to prove the store understands
the envelopes it produces.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from livekit.agents.utils import is_given

import pricing
from chaos import (
    MAX_COMPLETION_TOKENS,
    MAX_DELAY_MS,
    MIN_COMPLETION_TOKENS,
    AppliedChaosLog,
    ChaosCommand,
    ChaosController,
    parse_control_message,
)
from telemetry import (
    MAX_PACKET_BYTES,
    SCHEMA_VERSION,
    AppliedChaos,
    PipelineModels,
    TurnStore,
    encode_envelope,
)

FIXTURE = Path(__file__).resolve().parents[2] / "docs" / "fixtures" / "sample-call.jsonl"

MODELS = PipelineModels(stt="deepgram/nova-3", llm="openai/gpt-4.1-mini", tts="cartesia/sonic-3")

ENVELOPE_TYPES = {
    "turn",
    "transcript",
    "state",
    "interruption",
    "usage",
    "chaos",
    "call_meta",
}


# --------------------------------------------------------------------- helpers


def assert_valid_envelope(env: dict) -> None:
    """Check an envelope against the wire contract in docs/TELEMETRY-SCHEMA.md."""
    assert env["v"] == SCHEMA_VERSION
    assert env["type"] in ENVELOPE_TYPES
    assert isinstance(env["ts"], float)
    assert isinstance(env["payload"], dict)
    if "speech_id" in env:
        assert isinstance(env["speech_id"], str)

    payload = env["payload"]
    if env["type"] == "turn":
        assert isinstance(payload["turn_id"], str)
        for stage in ("eou", "stt", "llm", "tts"):
            if stage in payload:
                assert isinstance(payload[stage], dict)
        # llm_calls is optional on the wire (absent means one); when present it counts.
        if "llm" in payload and "llm_calls" in payload["llm"]:
            llm = payload["llm"]
            assert llm["llm_calls"] >= 1
            # `chain` is optional, and the schema emits it only for a multi-call turn.
            if llm["llm_calls"] > 1:
                assert len(llm["chain"]) == llm["llm_calls"]
                for call in llm["chain"]:
                    assert set(call) == {"ttft", "duration"}
                    assert isinstance(call["ttft"], float)
                    assert isinstance(call["duration"], float)
            else:
                assert "chain" not in llm
        if "total_response_latency" in payload:
            assert isinstance(payload["total_response_latency"], float)
            assert isinstance(payload["degraded"], bool)
    elif env["type"] == "transcript":
        assert payload["role"] in ("user", "agent")
        assert isinstance(payload["text"], str)
        assert isinstance(payload["final"], bool)
        assert isinstance(payload["turn_id"], str)
    elif env["type"] == "state":
        assert payload["state"] in ("initializing", "listening", "thinking", "speaking")
        assert payload["prev"] in ("initializing", "listening", "thinking", "speaking")
    elif env["type"] == "interruption":
        assert payload["kind"] in ("barge_in", "false_interruption")
        assert isinstance(payload["turn_id"], str)
    elif env["type"] == "usage":
        assert isinstance(payload["llm_prompt_tokens"], int)
        assert isinstance(payload["llm_completion_tokens"], int)
        assert isinstance(payload["stt_audio_seconds"], float)
        assert isinstance(payload["tts_characters"], int)
        assert isinstance(payload["est_cost_usd"], float)
    elif env["type"] == "chaos":
        assert isinstance(payload["llm_delay_ms"], int)
        assert isinstance(payload["active"], bool)
        # The v1.3 injections are validated where present, not required: the recorded
        # fixture predates them, and a consumer merging envelopes must tolerate both.
        # That the live controller always emits all of them is asserted separately, in
        # test_chaos_controller_starts_idle_and_acks_the_full_state.
        assert set(payload) <= {
            "llm_delay_ms",
            "tts_delay_ms",
            "slow_model",
            "max_completion_tokens",
            "active",
        }
        if "tts_delay_ms" in payload:
            assert isinstance(payload["tts_delay_ms"], int)
        if "slow_model" in payload:
            assert isinstance(payload["slow_model"], bool)
        if "max_completion_tokens" in payload:
            assert payload["max_completion_tokens"] is None or isinstance(
                payload["max_completion_tokens"], int
            )
    elif env["type"] == "call_meta":
        assert set(payload["pipeline"]) == {"stt", "llm", "tts"}
        assert payload["entry"] in ("browser", "sip")


def drive_turn(
    store: TurnStore,
    turn_id: str,
    *,
    eou_delay: float = 0.41,
    ttft: float = 0.34,
    ttfb: float = 0.19,
    prompt_tokens: int = 820,
    completion_tokens: int = 58,
    characters_count: int = 142,
    stt_audio: float = 3.1,
    request_id: str | None = None,
    tts_request_id: str | None = None,
) -> list[dict]:
    """Feed one turn's events in the order the SDK really emits them.

    STT metrics and the caller's transcript land before turn detection names the turn,
    so they come first and are flushed by record_eou.
    """
    store.record_stt(duration=0.0, audio_duration=stt_audio)
    envelopes: list[dict | None] = list(
        store.record_eou(turn_id, end_of_utterance_delay=eou_delay, transcription_delay=0.12)
    )
    envelopes += [
        store.record_llm(
            turn_id,
            ttft=ttft,
            duration=1.1,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            request_id=request_id,
        ),
        store.record_tts(
            turn_id,
            ttfb=ttfb,
            duration=2.0,
            audio_duration=4.2,
            characters_count=characters_count,
            request_id=tts_request_id,
        ),
    ]
    return [e for e in envelopes if e is not None]


@pytest.fixture
def store() -> TurnStore:
    return TurnStore(models=MODELS)


# ------------------------------------------------------------- merge behaviour


def test_metrics_merge_into_one_turn(store: TurnStore) -> None:
    envelopes = drive_turn(store, "t1")

    assert len(envelopes) == 4
    for env in envelopes:
        assert_valid_envelope(env)
        assert env["type"] == "turn"
        assert env["speech_id"] == "t1"
        assert env["payload"]["turn_id"] == "t1"

    # Each envelope carries only the stage that just arrived; the frontend merges.
    assert set(envelopes[0]["payload"]) == {"turn_id", "eou"}
    assert set(envelopes[1]["payload"]) == {"turn_id", "stt"}
    assert set(envelopes[2]["payload"]) == {"turn_id", "llm"}

    turn = store.get("t1")
    assert turn is not None
    assert turn.eou == {"end_of_utterance_delay": 0.41, "transcription_delay": 0.12}
    assert turn.stt["model"] == "deepgram/nova-3"
    assert turn.llm["model"] == "openai/gpt-4.1-mini"
    assert turn.tts["model"] == "cartesia/sonic-3"


def test_total_response_latency_math(store: TurnStore) -> None:
    envelopes = drive_turn(store, "t1", eou_delay=0.41, ttft=0.34, ttfb=0.19)

    # TTS is the last of the three stages the sum needs, so it carries the total.
    tts_env = envelopes[-1]
    assert set(tts_env["payload"]) == {
        "turn_id",
        "tts",
        "total_response_latency",
        "degraded",
    }
    assert tts_env["payload"]["total_response_latency"] == pytest.approx(0.94)
    assert tts_env["payload"]["degraded"] is False

    # It is published exactly once, not repeated on every later envelope.
    assert sum("total_response_latency" in e["payload"] for e in envelopes) == 1
    assert store.get("t1").total_response_latency == pytest.approx(0.41 + 0.34 + 0.19)


def test_latency_completes_whichever_stage_lands_last(store: TurnStore) -> None:
    """The waterfall is order-independent: TTS may report before the LLM."""
    store.record_eou("t1", end_of_utterance_delay=0.40, transcription_delay=0.10)
    tts_env = store.record_tts(
        "t1", ttfb=0.20, duration=1.0, audio_duration=2.0, characters_count=50
    )
    assert "total_response_latency" not in tts_env["payload"]

    llm_env = store.record_llm("t1", ttft=0.30, duration=1.0, prompt_tokens=10, completion_tokens=5)
    assert llm_env["payload"]["total_response_latency"] == pytest.approx(0.90)


# ------------------------------------------------------------ tool-call chains


def test_tool_calling_turn_reports_the_whole_llm_chain(store: TurnStore) -> None:
    """A turn that calls a tool runs the LLM twice and must report both runs.

    Regression: reporting only the first invocation claimed sub-second latency for a
    reply the caller waited multiple seconds for.
    """
    store.record_eou("t1", end_of_utterance_delay=0.40, transcription_delay=0.10)
    first = store.record_llm(
        "t1", ttft=0.30, duration=0.50, prompt_tokens=100, completion_tokens=10
    )
    assert first["payload"]["llm"] == {
        "ttft": 0.30,
        "duration": 0.50,
        "prompt_tokens": 100,
        "completion_tokens": 10,
        "tokens_per_second": 20.0,
        "llm_calls": 1,
        "model": "openai/gpt-4.1-mini",
    }

    second = store.record_llm(
        "t1", ttft=0.90, duration=1.50, prompt_tokens=200, completion_tokens=20
    )
    assert second is not None, "a second invocation must re-publish the turn"
    chain = second["payload"]["llm"]
    assert chain["llm_calls"] == 2
    # The caller waits out the whole first invocation before the second's first token.
    assert chain["ttft"] == pytest.approx(0.50 + 0.90)
    assert chain["duration"] == pytest.approx(2.00)
    assert chain["prompt_tokens"] == 300
    assert chain["completion_tokens"] == 30
    assert chain["tokens_per_second"] == pytest.approx(15.0)

    usage = store.usage_payload()
    assert usage["llm_prompt_tokens"] == 300
    assert usage["llm_completion_tokens"] == 30


def test_a_single_call_turn_carries_no_chain_array(store: TurnStore) -> None:
    """`chain` would only restate ttft/duration for the common case, so it is omitted."""
    store.record_eou("t1", end_of_utterance_delay=0.40, transcription_delay=0.10)
    env = store.record_llm("t1", ttft=0.30, duration=0.50, prompt_tokens=100, completion_tokens=10)
    assert "chain" not in env["payload"]["llm"]
    assert_valid_envelope(env)


def test_a_tool_calling_turn_breaks_the_chain_down_per_invocation(store: TurnStore) -> None:
    """The summed block hides where the time went; `chain` is how the cockpit shows it.

    Two invocations of 0.50 s and 1.50 s produce the same 1.40 s effective ttft as one
    slow call would — only the per-invocation entries distinguish them.
    """
    store.record_eou("t1", end_of_utterance_delay=0.40, transcription_delay=0.10)
    store.record_llm("t1", ttft=0.30, duration=0.50, prompt_tokens=100, completion_tokens=10)
    env = store.record_llm("t1", ttft=0.90, duration=1.50, prompt_tokens=200, completion_tokens=20)

    llm = env["payload"]["llm"]
    # Invocation order, raw per-call values — not the collapsed perceived ttft.
    assert llm["chain"] == [
        {"ttft": 0.30, "duration": 0.50},
        {"ttft": 0.90, "duration": 1.50},
    ]
    assert llm["ttft"] == pytest.approx(1.40)
    assert_valid_envelope(env)

    third = store.record_llm("t1", ttft=0.20, duration=0.40, prompt_tokens=50, completion_tokens=5)
    assert third["payload"]["llm"]["chain"][-1] == {"ttft": 0.20, "duration": 0.40}
    assert len(third["payload"]["llm"]["chain"]) == 3


def test_chain_entries_are_rounded_like_every_other_duration(store: TurnStore) -> None:
    """Float noise off the SDK must not reach the wire — `_r` applies here too."""
    store.record_eou("t1", end_of_utterance_delay=0.40, transcription_delay=0.10)
    store.record_llm(
        "t1", ttft=0.1234567, duration=0.5000004, prompt_tokens=100, completion_tokens=10
    )
    env = store.record_llm(
        "t1", ttft=0.9876543, duration=1.5000009, prompt_tokens=200, completion_tokens=20
    )
    assert env["payload"]["llm"]["chain"] == [
        {"ttft": 0.123, "duration": 0.5},
        {"ttft": 0.988, "duration": 1.5},
    ]


def test_a_later_invocation_corrects_an_already_published_total(store: TurnStore) -> None:
    """Totals go out at TTS; a tool step landing after that must correct them."""
    store.record_eou("t1", end_of_utterance_delay=0.40, transcription_delay=0.10)
    store.record_llm("t1", ttft=0.30, duration=0.50, prompt_tokens=100, completion_tokens=10)
    tts = store.record_tts("t1", ttfb=0.20, duration=1.0, audio_duration=2.0, characters_count=50)
    assert tts["payload"]["total_response_latency"] == pytest.approx(0.90)

    corrected = store.record_llm(
        "t1", ttft=0.90, duration=1.50, prompt_tokens=200, completion_tokens=20
    )
    assert corrected["payload"]["total_response_latency"] == pytest.approx(0.40 + 1.40 + 0.20)
    assert corrected["payload"]["degraded"] is False
    assert store.get("t1").total_response_latency == pytest.approx(2.00)


# ------------------------------------------------------ pending-buffer handling


def test_two_finals_before_end_of_utterance_are_joined(store: TurnStore) -> None:
    """One utterance can be finalised in pieces; neither piece may be dropped."""
    store.record_user_transcript("Turn on chaos mode,")
    store.record_user_transcript("eight hundred milliseconds.")

    envelopes = store.record_eou("t1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    assert envelopes[0]["payload"]["text"] == "Turn on chaos mode, eight hundred milliseconds."
    assert store.get("t1").user_text == "Turn on chaos mode, eight hundred milliseconds."


def test_two_stt_metrics_before_end_of_utterance_accumulate(store: TurnStore) -> None:
    store.record_stt(duration=0.0, audio_duration=1.4)
    store.record_stt(duration=0.0, audio_duration=1.7)

    envelopes = store.record_eou("t1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    stt = envelopes[-1]["payload"]["stt"]
    assert stt["audio_duration"] == pytest.approx(3.1)
    # Streaming STT reports no request duration, and summing zeros keeps it that way.
    assert stt["duration"] == 0.0
    assert store.usage_payload()["stt_audio_seconds"] == pytest.approx(3.1)


def test_stt_arriving_after_a_flush_lands_on_the_next_turn(store: TurnStore) -> None:
    """The plugin sends usage ahead of the final transcript, so post-flush means next.

    Regression: the one-slot buffer meant such a metric could survive to be flushed
    against a later turn than the one it belongs to, or be clobbered before it landed.
    """
    store.record_stt(duration=0.0, audio_duration=3.1)
    store.record_eou("t1", end_of_utterance_delay=0.41, transcription_delay=0.12)
    assert store.get("t1").stt["audio_duration"] == pytest.approx(3.1)

    store.record_stt(duration=0.0, audio_duration=2.8)
    envelopes = store.record_eou("t2", end_of_utterance_delay=0.38, transcription_delay=0.10)

    assert store.get("t2").stt["audio_duration"] == pytest.approx(2.8)
    assert store.get("t1").stt["audio_duration"] == pytest.approx(3.1)
    assert envelopes[-1]["payload"]["stt"]["audio_duration"] == pytest.approx(2.8)


def test_stt_and_transcript_attach_to_the_turn_the_utterance_triggers(
    store: TurnStore,
) -> None:
    """Both arrive before the SDK names the turn, so both wait for the EOU that does.

    Attributing them to `current_turn_id` on arrival would misfile them onto the
    *previous* turn, which is the bug this pins down.
    """
    store.record_stt(duration=0.28, audio_duration=3.1)
    store.record_user_transcript("Hey, what is this demo exactly?")

    envelopes = store.record_eou("t1", end_of_utterance_delay=0.41, transcription_delay=0.12)
    assert [e["type"] for e in envelopes] == ["transcript", "turn", "turn"]
    for env in envelopes:
        assert_valid_envelope(env)
        assert env["speech_id"] == "t1"

    assert envelopes[0]["payload"] == {
        "role": "user",
        "text": "Hey, what is this demo exactly?",
        "final": True,
        "turn_id": "t1",
    }
    assert "eou" in envelopes[1]["payload"]
    assert envelopes[2]["payload"]["stt"]["audio_duration"] == pytest.approx(3.1)
    assert store.get("t1").user_text == "Hey, what is this demo exactly?"

    # The next utterance files against the next turn, not this one.
    store.record_stt(duration=0.3, audio_duration=2.8)
    store.record_user_transcript("How's the call quality?")
    envelopes = store.record_eou("t2", end_of_utterance_delay=0.38, transcription_delay=0.10)
    assert all(e["payload"]["turn_id"] == "t2" for e in envelopes)
    assert store.get("t1").user_text == "Hey, what is this demo exactly?"


def test_eou_without_buffered_input_publishes_only_the_turn(store: TurnStore) -> None:
    envelopes = store.record_eou("t1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    assert [e["type"] for e in envelopes] == ["turn"]
    assert set(envelopes[0]["payload"]) == {"turn_id", "eou"}


def test_stt_audio_counts_toward_usage_even_if_never_attributed(
    store: TurnStore,
) -> None:
    """Audio recognised before any turn is billed regardless of where it renders."""
    store.record_stt(duration=0.2, audio_duration=1.0)
    assert store.usage_payload()["stt_audio_seconds"] == pytest.approx(1.0)


# ------------------------------------------------------------ chaos / degraded


def _llm_delay(seconds: float) -> AppliedChaos:
    return AppliedChaos(delay=seconds, model=MODELS.llm)


def chaos_store() -> tuple[TurnStore, AppliedChaosLog, AppliedChaosLog]:
    """A store wired to its own attribution logs, the way agent.py wires the real one."""
    llm_log, tts_log = AppliedChaosLog(), AppliedChaosLog()
    store = TurnStore(
        models=MODELS,
        applied_llm_chaos=llm_log.take,
        applied_tts_chaos=tts_log.take,
    )
    return store, llm_log, tts_log


def test_degraded_follows_the_delay_actually_applied() -> None:
    store, llm_log, _ = chaos_store()

    llm_log.record(_llm_delay(0.0), request_id="r1")
    assert drive_turn(store, "t1", request_id="r1")[-1]["payload"]["degraded"] is False

    llm_log.record(_llm_delay(0.8), request_id="r2")
    degraded = drive_turn(store, "t2", ttft=1.15, request_id="r2")
    assert degraded[-1]["payload"]["degraded"] is True
    assert store.get("t2").total_response_latency == pytest.approx(0.41 + 1.15 + 0.19)

    llm_log.record(_llm_delay(0.0), request_id="r3")
    assert drive_turn(store, "t3", request_id="r3")[-1]["payload"]["degraded"] is False


def test_toggling_chaos_after_the_completion_ran_does_not_mark_the_turn() -> None:
    """Regression: degraded was read off the live toggle when metrics arrived.

    A visitor flipping the switch while the agent was already speaking painted the
    in-flight turn red even though its completion had run at full speed — and the
    reverse, flipping it off, painted a genuinely delayed turn clean.
    """
    store, llm_log, _ = chaos_store()

    llm_log.record(_llm_delay(0.0), request_id="clean")  # this completion ran chaos-free
    store.record_eou("t1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    store.record_llm(
        "t1", ttft=0.3, duration=1.0, prompt_tokens=10, completion_tokens=5, request_id="clean"
    )
    # ...and only now does the visitor switch chaos on, mid-turn.
    env = store.record_tts("t1", ttfb=0.2, duration=1.0, audio_duration=2.0, characters_count=30)
    assert env["payload"]["degraded"] is False

    llm_log.record(_llm_delay(0.5), request_id="slow")  # this one really was delayed
    store.record_eou("t2", end_of_utterance_delay=0.4, transcription_delay=0.1)
    store.record_llm(
        "t2", ttft=0.9, duration=1.0, prompt_tokens=10, completion_tokens=5, request_id="slow"
    )
    # ...and the visitor switches chaos off again before this turn finishes.
    env = store.record_tts("t2", ttfb=0.2, duration=1.0, audio_duration=2.0, characters_count=30)
    assert env["payload"]["degraded"] is True


def test_a_degraded_step_anywhere_in_the_chain_marks_the_turn() -> None:
    store, llm_log, _ = chaos_store()

    llm_log.record(_llm_delay(0.0), request_id="a")
    llm_log.record(_llm_delay(0.8), request_id="b")
    store.record_eou("t1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    store.record_llm(
        "t1", ttft=0.3, duration=0.5, prompt_tokens=10, completion_tokens=5, request_id="a"
    )
    store.record_tts("t1", ttfb=0.2, duration=1.0, audio_duration=2.0, characters_count=30)
    env = store.record_llm(
        "t1", ttft=1.1, duration=1.4, prompt_tokens=20, completion_tokens=8, request_id="b"
    )
    assert env["payload"]["degraded"] is True
    assert store.get("t1").degraded is True


# Each injection has to mark a turn degraded on its own; the demo lets the visitor
# enable any one of them alone, and a waterfall that renders clean while the agent is
# audibly slowed (or audibly truncated) is the exact lie this whole design exists to
# prevent.
@pytest.mark.parametrize(
    ("label", "applied"),
    [
        ("llm delay", AppliedChaos(delay=0.8, model=MODELS.llm)),
        ("slow model", AppliedChaos(model="openai/gpt-4.1", slow_model=True)),
        ("token clamp", AppliedChaos(model=MODELS.llm, max_completion_tokens=30)),
    ],
)
def test_each_llm_injection_marks_the_turn_degraded_on_its_own(
    label: str, applied: AppliedChaos
) -> None:
    store, llm_log, _ = chaos_store()
    llm_log.record(applied, request_id="r1")

    envelopes = drive_turn(store, "t1", request_id="r1")

    assert envelopes[-1]["payload"]["degraded"] is True, f"{label} must degrade the turn"
    assert store.get("t1").degraded is True


def test_a_tts_delay_alone_marks_the_turn_degraded() -> None:
    """The LLM ran clean; only synthesis was slowed — the turn is still degraded."""
    store, llm_log, tts_log = chaos_store()
    llm_log.record(_llm_delay(0.0), request_id="r1")
    tts_log.record(AppliedChaos(delay=0.5), request_id="s1")

    envelopes = drive_turn(store, "t1", request_id="r1", tts_request_id="s1")

    assert envelopes[-1]["payload"]["degraded"] is True
    assert store.get("t1").degraded is True


def test_an_undelayed_synthesis_leaves_the_turn_clean() -> None:
    store, llm_log, tts_log = chaos_store()
    llm_log.record(_llm_delay(0.0), request_id="r1")
    tts_log.record(AppliedChaos(), request_id="s1")

    envelopes = drive_turn(store, "t1", request_id="r1", tts_request_id="s1")

    assert envelopes[-1]["payload"]["degraded"] is False
    assert store.get("t1").degraded is False


def test_a_late_degraded_tts_segment_republishes_the_flag() -> None:
    """A second segment can be the first thing chaos touched, after totals shipped.

    The turn's `tts` block is write-once, so the repeat metric produces no stage
    update — but the correction still has to reach the cockpit, or the turn stays
    painted clean for the rest of the call.
    """
    store, llm_log, tts_log = chaos_store()
    llm_log.record(_llm_delay(0.0), request_id="r1")
    tts_log.record(AppliedChaos(), request_id="s1")
    tts_log.record(AppliedChaos(delay=0.4), request_id="s2")

    envelopes = drive_turn(store, "t1", request_id="r1", tts_request_id="s1")
    assert envelopes[-1]["payload"]["degraded"] is False

    correction = store.record_tts(
        "t1", ttfb=0.9, duration=1.0, audio_duration=2.0, characters_count=30, request_id="s2"
    )
    assert correction is not None, "the flag flip must still reach the cockpit"
    assert_valid_envelope(correction)
    # No stage block: the tts block is unchanged, only the attribution moved.
    assert set(correction["payload"]) == {"turn_id", "degraded"}
    assert correction["payload"]["degraded"] is True
    assert store.get("t1").degraded is True


def test_the_flag_is_not_republished_once_it_has_settled() -> None:
    store, llm_log, tts_log = chaos_store()
    llm_log.record(_llm_delay(0.0), request_id="r1")
    for request_id in ("s1", "s2", "s3"):
        tts_log.record(AppliedChaos(), request_id=request_id)

    drive_turn(store, "t1", request_id="r1", tts_request_id="s1")
    for request_id in ("s2", "s3"):
        repeat = store.record_tts(
            "t1",
            ttfb=0.2,
            duration=1.0,
            audio_duration=2.0,
            characters_count=30,
            request_id=request_id,
        )
        assert repeat is None, "an unchanged repeat segment must stay off the wire"


def test_the_turn_reports_the_model_each_invocation_actually_used() -> None:
    """Chaos swaps the model per call, so the envelope cannot echo the configured one."""
    store, llm_log, _ = chaos_store()
    llm_log.record(AppliedChaos(model="openai/gpt-4.1", slow_model=True), request_id="slow")

    env = store.record_llm(
        "t1", ttft=0.9, duration=2.0, prompt_tokens=10, completion_tokens=5, request_id="slow"
    )

    assert env["payload"]["llm"]["model"] == "openai/gpt-4.1"
    assert env["payload"]["llm"]["model"] != MODELS.llm


def test_a_chain_reports_the_last_model_and_keeps_chain_entries_bare() -> None:
    """A tool turn can straddle a swap: the top-level model is the one still speaking."""
    store, llm_log, _ = chaos_store()
    llm_log.record(AppliedChaos(model=MODELS.llm), request_id="fast")
    llm_log.record(AppliedChaos(model="openai/gpt-4.1", slow_model=True), request_id="slow")

    store.record_llm(
        "t1", ttft=0.3, duration=0.5, prompt_tokens=10, completion_tokens=5, request_id="fast"
    )
    env = store.record_llm(
        "t1", ttft=1.2, duration=2.0, prompt_tokens=20, completion_tokens=8, request_id="slow"
    )

    block = env["payload"]["llm"]
    assert block["model"] == "openai/gpt-4.1"
    assert block["llm_calls"] == 2
    # The schema pins chain entries to {ttft, duration} — no per-entry model field.
    assert [set(entry) for entry in block["chain"]] == [{"ttft", "duration"}] * 2


def test_the_turn_falls_back_to_the_configured_model_without_attribution() -> None:
    """A store with no chaos controller still names the pipeline's model."""
    store = TurnStore(models=MODELS)
    env = store.record_llm("t1", ttft=0.3, duration=1.0, prompt_tokens=10, completion_tokens=5)
    assert env["payload"]["llm"]["model"] == MODELS.llm


def test_applied_chaos_log_matches_on_request_id_and_falls_back_to_fifo() -> None:
    log = AppliedChaosLog()
    log.record(_llm_delay(0.5), request_id="first")
    log.record(_llm_delay(0.0), request_id="second")

    # Metrics can be claimed out of order when the ids are known.
    assert log.take("second").delay == pytest.approx(0.0)
    assert log.take("first").delay == pytest.approx(0.5)
    empty = log.take("first")
    assert empty.delay == pytest.approx(0.0), "an empty log means no chaos applied"
    assert empty.degraded is False

    # A provider that reports no request id still gets the oldest unclaimed entry.
    log.record(_llm_delay(0.3))
    log.record(_llm_delay(0.9))
    assert log.take("").delay == pytest.approx(0.3)
    assert log.take(None).delay == pytest.approx(0.9)


def test_applied_chaos_log_is_bounded() -> None:
    log = AppliedChaosLog(capacity=2)
    for i in range(5):
        log.record(_llm_delay(float(i)))
    assert [log.take().delay, log.take().delay, log.take().delay] == [3.0, 4.0, 0.0]


@pytest.mark.parametrize(
    ("applied", "degraded"),
    [
        (AppliedChaos(), False),
        (AppliedChaos(model="openai/gpt-4.1-mini"), False),
        (AppliedChaos(delay=0.001), True),
        (AppliedChaos(slow_model=True), True),
        (AppliedChaos(max_completion_tokens=MAX_COMPLETION_TOKENS), True),
    ],
)
def test_applied_chaos_knows_whether_it_degraded_anything(
    applied: AppliedChaos, degraded: bool
) -> None:
    assert applied.degraded is degraded


# ------------------------------------------------------------- chaos controller


def test_chaos_controller_starts_idle_and_acks_the_full_state() -> None:
    chaos = ChaosController()
    assert chaos.envelope_payload() == {
        "llm_delay_ms": 0,
        "tts_delay_ms": 0,
        "slow_model": False,
        "max_completion_tokens": None,
        "active": False,
    }


def test_chaos_controller_acks_every_field_it_holds() -> None:
    chaos = ChaosController(800, tts_delay_ms=500, slow_model=True, max_completion_tokens=30)
    assert chaos.envelope_payload() == {
        "llm_delay_ms": 800,
        "tts_delay_ms": 500,
        "slow_model": True,
        "max_completion_tokens": 30,
        "active": True,
    }
    assert chaos.llm_delay_seconds == pytest.approx(0.8)
    assert chaos.tts_delay_seconds == pytest.approx(0.5)


# `active` drives the cockpit's chaos light, so every injection has to raise it alone.
@pytest.mark.parametrize(
    "kwargs",
    [
        {"llm_delay_ms": 1},
        {"tts_delay_ms": 1},
        {"slow_model": True},
        {"max_completion_tokens": MIN_COMPLETION_TOKENS},
    ],
)
def test_any_single_injection_makes_the_controller_active(kwargs: dict) -> None:
    assert ChaosController(**kwargs).active is True
    assert ChaosController().active is False


def test_chaos_controller_clamps_everything_it_is_given() -> None:
    chaos = ChaosController()

    chaos.set_llm_delay_ms(-50)
    chaos.set_tts_delay_ms(-50)
    assert (chaos.llm_delay_ms, chaos.tts_delay_ms) == (0, 0)

    chaos.set_llm_delay_ms(999_999)
    chaos.set_tts_delay_ms(999_999)
    assert (chaos.llm_delay_ms, chaos.tts_delay_ms) == (MAX_DELAY_MS, MAX_DELAY_MS)

    # A zero-token clamp would produce no answer at all, which reads as a broken
    # agent rather than a starved one.
    chaos.set_max_completion_tokens(0)
    assert chaos.max_completion_tokens == MIN_COMPLETION_TOKENS
    chaos.set_max_completion_tokens(10**6)
    assert chaos.max_completion_tokens == MAX_COMPLETION_TOKENS
    chaos.set_max_completion_tokens(None)
    assert chaos.max_completion_tokens is None


def test_applying_a_partial_command_leaves_the_rest_alone() -> None:
    chaos = ChaosController(800, tts_delay_ms=500, slow_model=True, max_completion_tokens=30)

    chaos.apply(ChaosCommand(llm_delay_ms=0))

    assert chaos.llm_delay_ms == 0
    assert chaos.tts_delay_ms == 500
    assert chaos.slow_model is True
    assert chaos.max_completion_tokens == 30
    assert chaos.active is True


def test_applying_a_null_token_clamp_turns_it_off() -> None:
    """`null` is an instruction, not an omission — the schema distinguishes them."""
    chaos = ChaosController(max_completion_tokens=30)

    chaos.apply(ChaosCommand(max_completion_tokens=None))
    assert chaos.max_completion_tokens is None
    assert chaos.active is False


def test_applying_an_empty_command_changes_nothing() -> None:
    chaos = ChaosController(800, tts_delay_ms=500, slow_model=True, max_completion_tokens=30)
    before = chaos.envelope_payload()

    chaos.apply(ChaosCommand())

    assert chaos.envelope_payload() == before


# ------------------------------------------------------ control-message parsing


def _packet(payload: dict) -> bytes:
    return json.dumps({"v": 1, "type": "chaos", "payload": payload}).encode()


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"llm_delay_ms": 800}, ChaosCommand(llm_delay_ms=800)),
        ({"llm_delay_ms": 0}, ChaosCommand(llm_delay_ms=0)),
        ({"tts_delay_ms": 500}, ChaosCommand(tts_delay_ms=500)),
        ({"slow_model": True}, ChaosCommand(slow_model=True)),
        ({"slow_model": False}, ChaosCommand(slow_model=False)),
        ({"max_completion_tokens": 30}, ChaosCommand(max_completion_tokens=30)),
        ({"max_completion_tokens": None}, ChaosCommand(max_completion_tokens=None)),
        (
            {
                "llm_delay_ms": 800,
                "tts_delay_ms": 500,
                "slow_model": True,
                "max_completion_tokens": 30,
            },
            ChaosCommand(
                llm_delay_ms=800, tts_delay_ms=500, slow_model=True, max_completion_tokens=30
            ),
        ),
        # Unknown fields are ignored, not fatal: the schema may grow.
        ({"llm_delay_ms": 800, "future_knob": "???"}, ChaosCommand(llm_delay_ms=800)),
    ],
)
def test_parse_control_message_accepts_partial_commands(
    payload: dict, expected: ChaosCommand
) -> None:
    assert parse_control_message(_packet(payload)) == expected


def test_an_absent_field_is_not_the_same_as_a_zero_one() -> None:
    """The wire distinguishes "leave it alone" from "turn it off"; so must the parse."""
    absent = parse_control_message(_packet({"llm_delay_ms": 800}))
    assert absent is not None
    assert not is_given(absent.tts_delay_ms)
    assert not is_given(absent.max_completion_tokens)

    explicit = parse_control_message(_packet({"tts_delay_ms": 0, "max_completion_tokens": None}))
    assert explicit == ChaosCommand(tts_delay_ms=0, max_completion_tokens=None)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        # Values out of range are clamped at parse time rather than rejected: a slider
        # pinned to its maximum is a legitimate request, just an out-of-range one.
        ({"llm_delay_ms": 999_999}, ChaosCommand(llm_delay_ms=MAX_DELAY_MS)),
        ({"llm_delay_ms": -5}, ChaosCommand(llm_delay_ms=0)),
        ({"tts_delay_ms": -5}, ChaosCommand(tts_delay_ms=0)),
        ({"llm_delay_ms": 800.7}, ChaosCommand(llm_delay_ms=800)),
        ({"max_completion_tokens": 0}, ChaosCommand(max_completion_tokens=MIN_COMPLETION_TOKENS)),
        (
            {"max_completion_tokens": 10**6},
            ChaosCommand(max_completion_tokens=MAX_COMPLETION_TOKENS),
        ),
        ({"max_completion_tokens": 30.9}, ChaosCommand(max_completion_tokens=30)),
    ],
)
def test_parse_control_message_clamps_out_of_range_values(
    payload: dict, expected: ChaosCommand
) -> None:
    assert parse_control_message(_packet(payload)) == expected


def test_a_400_digit_delay_is_finite_and_clamps() -> None:
    raw = b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":1' + b"0" * 400 + b"}}"
    command = parse_control_message(raw)
    assert command == ChaosCommand(llm_delay_ms=MAX_DELAY_MS)


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"not json",
        b"null",
        b"[]",
        b'"chaos"',
        b"1723",
        b"\xff\xfe not utf-8",
        b'{"payload":[]}',
        b'{"v":1,"type":"something-else","payload":{"llm_delay_ms":800}}',
        b'{"v":1,"type":"chaos"}',
        b'{"v":1,"type":"chaos","payload":null}',
        b'{"v":1,"type":"chaos","payload":[]}',
        b'{"v":1,"type":"chaos","payload":"800"}',
        b'{"v":1,"type":"chaos","payload":{}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":"fast"}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":true}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":false}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":null}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":[800]}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":{"ms":800}}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":NaN}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":Infinity}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":-Infinity}}',
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":1e400}}',
        b'{"v":1,"type":"chaos","payload":{"tts_delay_ms":"soon"}}',
        b'{"v":1,"type":"chaos","payload":{"tts_delay_ms":NaN}}',
        # Booleans are strict: a truthy int is not a flag, and guessing is worse.
        b'{"v":1,"type":"chaos","payload":{"slow_model":1}}',
        b'{"v":1,"type":"chaos","payload":{"slow_model":"true"}}',
        b'{"v":1,"type":"chaos","payload":{"slow_model":"yes"}}',
        b'{"v":1,"type":"chaos","payload":{"slow_model":null}}',
        b'{"v":1,"type":"chaos","payload":{"max_completion_tokens":"thirty"}}',
        b'{"v":1,"type":"chaos","payload":{"max_completion_tokens":true}}',
        b'{"v":1,"type":"chaos","payload":{"max_completion_tokens":Infinity}}',
        # Every field junk means nothing valid survives, so there is nothing to ack.
        b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":"x","slow_model":2}}',
    ],
)
def test_parse_control_message_rejects_junk(raw: bytes) -> None:
    """The control channel is public: no payload may raise out of the data handler."""
    assert parse_control_message(raw) is None


def test_one_bad_field_does_not_discard_the_good_ones() -> None:
    """A single broken control widget must not disable the whole panel."""
    command = parse_control_message(
        _packet({"llm_delay_ms": 800, "slow_model": "yes", "max_completion_tokens": 30})
    )
    assert command == ChaosCommand(llm_delay_ms=800, max_completion_tokens=30)
    assert not is_given(command.slow_model), "the malformed field is dropped, not guessed"


def test_a_parsed_command_is_always_safe_to_apply() -> None:
    """Whatever survives parsing is already in range, however hostile the packet."""
    for payload in (
        {"llm_delay_ms": -(10**9)},
        {"llm_delay_ms": 10**9, "tts_delay_ms": 10**9},
        {"max_completion_tokens": -1},
        {"max_completion_tokens": 10**9},
    ):
        command = parse_control_message(_packet(payload))
        assert command is not None
        chaos = ChaosController()
        chaos.apply(command)
        assert 0 <= chaos.llm_delay_ms <= MAX_DELAY_MS
        assert 0 <= chaos.tts_delay_ms <= MAX_DELAY_MS
        tokens = chaos.max_completion_tokens
        assert tokens is None or MIN_COMPLETION_TOKENS <= tokens <= MAX_COMPLETION_TOKENS


# ------------------------------------------------------ interruptions & states


def test_barge_in_detected_from_state_transition(store: TurnStore) -> None:
    drive_turn(store, "t1")

    envelopes = store.record_state("speaking", "listening", speech_interrupted=True)
    assert [e["type"] for e in envelopes] == ["interruption", "state"]
    for env in envelopes:
        assert_valid_envelope(env)

    assert envelopes[0]["payload"] == {"kind": "barge_in", "turn_id": "t1"}
    assert envelopes[1]["payload"] == {"state": "listening", "prev": "speaking"}
    assert store.get("t1").barge_in is True


def test_uninterrupted_state_change_is_not_a_barge_in(store: TurnStore) -> None:
    drive_turn(store, "t1")
    envelopes = store.record_state("speaking", "listening", speech_interrupted=False)
    assert [e["type"] for e in envelopes] == ["state"]
    assert store.get("t1").barge_in is False


def test_barge_in_requires_leaving_speaking(store: TurnStore) -> None:
    drive_turn(store, "t1")
    envelopes = store.record_state("listening", "thinking", speech_interrupted=True)
    assert [e["type"] for e in envelopes] == ["state"]


def test_idle_state_is_reported_as_listening(store: TurnStore) -> None:
    (env,) = store.record_state("speaking", "idle")
    assert env["payload"] == {"state": "listening", "prev": "speaking"}
    assert_valid_envelope(env)


def test_false_interruption(store: TurnStore) -> None:
    assert store.record_false_interruption() is None

    drive_turn(store, "t1")
    env = store.record_false_interruption()
    assert_valid_envelope(env)
    assert env["payload"] == {"kind": "false_interruption", "turn_id": "t1"}


# -------------------------------------------------------------- usage & pricing


def test_usage_accumulates_across_turns(store: TurnStore) -> None:
    drive_turn(store, "t1", prompt_tokens=820, completion_tokens=58, characters_count=142)
    drive_turn(
        store,
        "t2",
        prompt_tokens=1090,
        completion_tokens=74,
        characters_count=155,
        stt_audio=2.8,
    )

    env = store.record_usage()
    assert_valid_envelope(env)
    assert env["payload"]["llm_prompt_tokens"] == 1910
    assert env["payload"]["llm_completion_tokens"] == 132
    assert env["payload"]["tts_characters"] == 297
    assert env["payload"]["stt_audio_seconds"] == pytest.approx(5.9)
    assert env["payload"]["est_cost_usd"] > 0


def test_price_table_reproduces_every_fixture_estimate() -> None:
    """The fixture's costs were priced by this table, so they must reproduce exactly."""
    usages = [e["payload"] for e in _fixture_envelopes() if e["type"] == "usage"]
    assert len(usages) == 7

    for usage in usages:
        assert (
            pricing.estimate_cost_usd(
                llm_usage={
                    MODELS.llm: (usage["llm_prompt_tokens"], usage["llm_completion_tokens"])
                },
                stt_model=MODELS.stt,
                stt_audio_seconds=usage["stt_audio_seconds"],
                tts_model=MODELS.tts,
                tts_characters=usage["tts_characters"],
            )
            == usage["est_cost_usd"]
        )

    assert usages[-1] == {
        "llm_prompt_tokens": 19847,
        "llm_completion_tokens": 427,
        "stt_audio_seconds": 15.9,
        "tts_characters": 1134,
        "est_cost_usd": 0.022,
    }


def test_unknown_models_still_cost_something() -> None:
    assert (
        pricing.estimate_cost_usd(
            llm_usage={"someone/unreleased-model": (1_000_000, 0)},
            stt_model="someone/unreleased-stt",
            stt_audio_seconds=0.0,
            tts_model="someone/unreleased-tts",
            tts_characters=0,
        )
        > 0
    )


# ------------------------------------------------------------------ call_meta


def test_call_meta_envelope(store: TurnStore) -> None:
    env = store.call_meta(
        call_id="RM_abc", room="cockpit-abc", started_at=1723000000.0, entry="sip"
    )
    assert_valid_envelope(env)
    assert env["payload"]["pipeline"] == {
        "stt": "deepgram/nova-3",
        "llm": "openai/gpt-4.1-mini",
        "tts": "cartesia/sonic-3",
    }
    assert env["payload"]["entry"] == "sip"


# --------------------------------------------------------------------- summary


def test_summary_before_any_turn(store: TurnStore) -> None:
    assert "haven't finished a full turn" in store.summary()


def test_summary_reads_out_the_waterfall() -> None:
    store, log, _ = chaos_store()
    log.record(_llm_delay(0.8), request_id="r1")
    drive_turn(store, "t1", eou_delay=0.41, ttft=1.15, ttfb=0.19, request_id="r1")
    store.record_state("speaking", "listening", speech_interrupted=True)

    summary = store.summary()
    assert "1750 milliseconds" in summary  # 0.41 + 1.15 + 0.19
    assert "410 milliseconds" in summary
    assert "chaos mode" in summary
    assert "interrupted me 1 time" in summary
    assert "estimate, not a bill" in summary


# ------------------------------------------------------------------- transport


def _transcript_envelope(store: TurnStore, text: str) -> dict:
    store.record_user_transcript(text)
    envelopes = store.record_eou("t1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    return envelopes[0]


def test_encode_envelope_truncates_oversized_transcripts(store: TurnStore) -> None:
    env = _transcript_envelope(store, "x" * (MAX_PACKET_BYTES * 2))

    encoded = encode_envelope(env)
    assert len(encoded) <= MAX_PACKET_BYTES
    decoded = json.loads(encoded)
    assert decoded["payload"]["text"].endswith("[truncated]")
    assert decoded["payload"]["turn_id"] == "t1"


def test_encode_envelope_leaves_normal_messages_alone(store: TurnStore) -> None:
    env = _transcript_envelope(store, "Hey, what is this demo exactly?")
    assert json.loads(encode_envelope(env)) == env


# ------------------------------------------------------------- fixture replay


def _fixture_envelopes() -> list[dict]:
    with FIXTURE.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def test_fixture_envelopes_match_our_validator() -> None:
    """The shapes we emit and the shapes the cockpit develops against are the same."""
    envelopes = _fixture_envelopes()
    assert len(envelopes) == 72
    for env in envelopes:
        assert_valid_envelope(env)


def test_replaying_the_fixture_rebuilds_the_call() -> None:
    store = TurnStore(models=MODELS)
    for env in _fixture_envelopes():
        store.apply_envelope(env)

    assert [t.turn_id for t in store.turns] == ["t0", "t1", "t2", "t3", "t4", "t5", "t6"]

    # t0 is the agent's greeting: it answers no utterance, so it has no end-of-utterance
    # metric, no STT and no response latency — the cockpit renders a partial row.
    t0 = store.get("t0")
    assert (t0.eou, t0.stt, t0.total_response_latency) == (None, None, None)
    assert t0.user_text == ""
    assert t0.agent_text.startswith("Welcome to Glass Cockpit.")
    assert t0.llm is not None and t0.tts is not None

    # The six answered turns all have a complete waterfall, two degraded by chaos.
    assert [t.turn_id for t in store.completed_turns] == ["t1", "t2", "t3", "t4", "t5", "t6"]
    assert [t.turn_id for t in store.turns if t.degraded] == ["t3", "t4"]
    assert [t.turn_id for t in store.turns if t.barge_in] == ["t4"]

    t1 = store.get("t1")
    assert t1.user_text == "Hey, what is this demo exactly?"
    assert t1.agent_text.startswith("You're seeing my flight recorder.")
    assert t1.total_response_latency == pytest.approx(0.94)

    # Every completed turn's published latency is its own stage sum, and streaming STT
    # contributes only audio duration.
    for turn in store.completed_turns:
        expected = turn.eou["end_of_utterance_delay"] + turn.llm["ttft"] + turn.tts["ttfb"]
        assert turn.total_response_latency == pytest.approx(expected)
        assert turn.stt["duration"] == 0.0


def test_replayed_usage_matches_the_fixtures_own_totals() -> None:
    """The fixture is generated, so replaying its turns must reproduce its usage line.

    tts_characters is excluded: `turn` envelopes carry TTS timings but not the
    character count, so replay cannot derive it.
    """
    envelopes = _fixture_envelopes()
    store = TurnStore(models=MODELS)
    for env in envelopes:
        store.apply_envelope(env)

    final_usage = [e["payload"] for e in envelopes if e["type"] == "usage"][-1]
    replayed = store.usage_payload()

    assert replayed["llm_prompt_tokens"] == final_usage["llm_prompt_tokens"] == 19847
    assert replayed["llm_completion_tokens"] == final_usage["llm_completion_tokens"] == 427
    assert replayed["stt_audio_seconds"] == pytest.approx(final_usage["stt_audio_seconds"])
    assert replayed["stt_audio_seconds"] == pytest.approx(15.9)


def test_store_round_trips_its_own_envelopes() -> None:
    """Envelopes the store emits can rebuild an identical store."""
    source, log, _ = chaos_store()
    log.record(_llm_delay(0.0), request_id="r1")
    emitted = drive_turn(source, "t1", request_id="r1")
    log.record(_llm_delay(0.8), request_id="r2")
    emitted += drive_turn(source, "t2", ttft=1.15, request_id="r2")
    emitted += source.record_state("speaking", "listening", speech_interrupted=True)

    replica = TurnStore(models=MODELS)
    for env in emitted:
        replica.apply_envelope(env)

    assert [t.turn_id for t in replica.turns] == ["t1", "t2"]
    assert replica.get("t2").degraded is True
    assert replica.get("t2").barge_in is True
    assert replica.get("t2").total_response_latency == pytest.approx(
        source.get("t2").total_response_latency
    )
    # tts_characters is not on the wire, so replay reconstructs everything but that.
    replayable = ("llm_prompt_tokens", "llm_completion_tokens", "stt_audio_seconds")
    assert {k: replica.usage_payload()[k] for k in replayable} == {
        k: source.usage_payload()[k] for k in replayable
    }


def test_replaying_a_tool_call_turn_does_not_double_count_usage() -> None:
    """A tool-calling turn republishes a cumulative llm block; replay must not sum them."""
    source = TurnStore(models=MODELS)
    emitted = [
        source.record_llm("t1", ttft=0.3, duration=0.5, prompt_tokens=100, completion_tokens=10),
        source.record_llm("t1", ttft=0.9, duration=1.5, prompt_tokens=200, completion_tokens=20),
    ]
    assert emitted[-1]["payload"]["llm"]["llm_calls"] == 2

    replica = TurnStore(models=MODELS)
    for env in emitted:
        replica.apply_envelope(env)

    assert replica.usage_payload()["llm_prompt_tokens"] == 300
    assert replica.usage_payload()["llm_completion_tokens"] == 30
    assert replica.usage_payload() == source.usage_payload()  # no TTS in this turn


def test_greeting_transcript_attaches_to_the_agent_initiated_turn(store: TurnStore) -> None:
    """Speech the agent opens with has no user turn; its transcript must still land.

    Regression: the live smoke test showed the greeting's transcript dropped because
    ``_current_turn_id`` is only set at end-of-utterance. The turn created by the
    greeting's own LLM metrics is the fallback home.
    """
    store.record_llm(
        "speech_greeting", ttft=1.9, duration=2.8, prompt_tokens=577, completion_tokens=79
    )
    env = store.record_agent_transcript("Welcome to Glass Cockpit.")
    assert env is not None
    assert env["payload"]["turn_id"] == "speech_greeting"
    assert store.get("speech_greeting").agent_text == "Welcome to Glass Cockpit."


def test_spoken_greeting_produces_a_tts_only_turn(store: TurnStore) -> None:
    """``session.say()`` skips the model, so the greeting turn has TTS and nothing else.

    The agent now opens with fixed text rather than a generated reply, which means the
    only metric the turn ever gets is TTS — there is no LLM invocation to create it and
    no end-of-utterance to name it. The schema calls this a partial, agent-initiated
    turn: no ``eou``, no ``stt``, no ``llm``, and never a ``total_response_latency``.
    """
    env = store.record_tts(
        "speech_greeting", ttfb=0.18, duration=1.9, audio_duration=3.4, characters_count=214
    )

    assert env is not None
    assert env["speech_id"] == "speech_greeting"
    payload = env["payload"]
    assert payload["tts"]["ttfb"] == 0.18
    assert "total_response_latency" not in payload
    assert not {"eou", "stt", "llm"} & payload.keys()

    turn = store.get("speech_greeting")
    assert turn is not None
    assert (turn.eou, turn.stt, turn.llm) == (None, None, None)
    assert turn.total_response_latency is None
    # A turn with no measurable critical path is not a latency sample.
    assert store.completed_turns == []


def test_spoken_greeting_transcript_attaches_without_any_llm_metrics(store: TurnStore) -> None:
    """The transcript's fallback home used to be the turn the greeting's own *LLM*
    metrics created. Under ``say()`` there are none, so TTS has to be enough."""
    store.record_tts(
        "speech_greeting", ttfb=0.18, duration=1.9, audio_duration=3.4, characters_count=214
    )
    env = store.record_agent_transcript("Welcome to Glass Cockpit.")

    assert env is not None
    assert env["payload"] == {
        "role": "agent",
        "text": "Welcome to Glass Cockpit.",
        "final": True,
        "turn_id": "speech_greeting",
    }


def test_spoken_greeting_bills_tts_but_no_llm_tokens(store: TurnStore) -> None:
    """The saving is real, not just perceived: no completion is paid for."""
    store.record_tts(
        "speech_greeting", ttfb=0.18, duration=1.9, audio_duration=3.4, characters_count=214
    )
    usage = store.record_usage()["payload"]

    assert usage["tts_characters"] == 214
    assert usage["llm_prompt_tokens"] == 0
    assert usage["llm_completion_tokens"] == 0
    assert usage["est_cost_usd"] > 0


def test_an_agent_initiated_turn_still_reports_that_chaos_degraded_it() -> None:
    """The greeting has no eou, so it never gets totals — but it can still be degraded.

    Regression: `degraded` was only ever published alongside `total_response_latency`,
    so a turn that can never have totals could never report degradation. Chaos slowing
    the greeting's voice by a second left the cockpit painting it clean, which is
    exactly the lie the flag exists to prevent.
    """
    store, _, tts_log = chaos_store()
    tts_log.record(AppliedChaos(delay=0.6), request_id="s1")

    env = store.record_tts(
        "greeting",
        ttfb=0.8,
        duration=1.0,
        audio_duration=2.0,
        characters_count=30,
        request_id="s1",
    )

    assert_valid_envelope(env)
    assert "total_response_latency" not in env["payload"], "no eou means no totals, ever"
    assert env["payload"]["degraded"] is True
    assert store.get("greeting").degraded is True


def test_a_clean_partial_turn_says_nothing_about_degradation() -> None:
    """`degraded` is only worth wire bytes once it is actually true."""
    store, _, tts_log = chaos_store()
    tts_log.record(AppliedChaos(), request_id="s1")

    env = store.record_tts(
        "greeting",
        ttfb=0.2,
        duration=1.0,
        audio_duration=2.0,
        characters_count=30,
        request_id="s1",
    )

    assert set(env["payload"]) == {"turn_id", "tts"}


def test_a_late_degraded_segment_on_a_partial_turn_still_corrects_it() -> None:
    store, _, tts_log = chaos_store()
    tts_log.record(AppliedChaos(), request_id="s1")
    tts_log.record(AppliedChaos(delay=0.4), request_id="s2")

    store.record_tts(
        "greeting",
        ttfb=0.2,
        duration=1.0,
        audio_duration=2.0,
        characters_count=30,
        request_id="s1",
    )
    correction = store.record_tts(
        "greeting",
        ttfb=0.9,
        duration=1.0,
        audio_duration=2.0,
        characters_count=30,
        request_id="s2",
    )

    assert correction is not None
    # Never a bare envelope: the only reason to emit one here is the flag itself.
    assert set(correction["payload"]) == {"turn_id", "degraded"}
    assert correction["payload"]["degraded"] is True


# --------------------------------------------------- cost across a chaos model swap


def test_slow_model_tokens_are_priced_at_the_slow_models_rate() -> None:
    """Chaos swaps to a model five times the price; the running cost must say so.

    Regression: usage kept one flat token total and priced all of it at the configured
    model's rate, so switching the agent onto `gpt-4.1` — the very thing the visitor
    turned on to watch — quietly understated what it cost by 5x.
    """
    store, llm_log, _ = chaos_store()
    llm_log.record(AppliedChaos(model="openai/gpt-4.1", slow_model=True), request_id="slow")

    store.record_llm(
        "t1",
        ttft=0.9,
        duration=2.0,
        prompt_tokens=1_000_000,
        completion_tokens=0,
        request_id="slow",
    )

    expected = pricing.LLM_PRICES["openai/gpt-4.1"].prompt
    assert store.estimated_cost_usd() == pytest.approx(expected, abs=1e-4)
    # The default rate would have been a fifth of that.
    assert store.estimated_cost_usd() > pricing.LLM_PRICES[MODELS.llm].prompt * 4


def test_a_call_that_straddles_a_swap_prices_each_half_separately() -> None:
    store, llm_log, _ = chaos_store()
    llm_log.record(AppliedChaos(model=MODELS.llm), request_id="cheap")
    llm_log.record(AppliedChaos(model="openai/gpt-4.1", slow_model=True), request_id="dear")

    store.record_llm(
        "t1",
        ttft=0.3,
        duration=1.0,
        prompt_tokens=1_000_000,
        completion_tokens=0,
        request_id="cheap",
    )
    store.record_llm(
        "t2",
        ttft=0.9,
        duration=2.0,
        prompt_tokens=1_000_000,
        completion_tokens=0,
        request_id="dear",
    )

    expected = pricing.LLM_PRICES[MODELS.llm].prompt + pricing.LLM_PRICES["openai/gpt-4.1"].prompt
    assert store.estimated_cost_usd() == pytest.approx(expected, abs=1e-4)
    # The flat totals on the wire are unchanged — only the pricing knows the difference.
    assert store.usage_payload()["llm_prompt_tokens"] == 2_000_000


def test_replaying_a_swapped_call_reprices_it_the_same_way() -> None:
    """A debrief must cost what the live call cost, swap and all."""
    source, llm_log, _ = chaos_store()
    llm_log.record(AppliedChaos(model="openai/gpt-4.1", slow_model=True), request_id="dear")
    emitted = [
        source.record_llm(
            "t1",
            ttft=0.9,
            duration=2.0,
            prompt_tokens=1_000_000,
            completion_tokens=0,
            request_id="dear",
        )
    ]

    replica = TurnStore(models=MODELS)
    for env in emitted:
        replica.apply_envelope(env)

    assert replica.estimated_cost_usd() == pytest.approx(source.estimated_cost_usd(), abs=1e-4)


# ------------------------------------------------- deliberate parsing tolerances


def test_an_unknown_schema_version_is_tolerated_not_rejected() -> None:
    """Deliberate: `type` is the discriminator, `v` is not a gate.

    Rejecting an unrecognised `v` would make a future cockpit's perfectly valid
    llm_delay_ms a silent no-op against today's agent. Per-field validation already
    drops anything it does not understand, so a newer sender degrades to the fields
    both sides share — which is the behaviour that keeps a mixed fleet working. The
    ack always states the version this agent actually speaks.
    """
    raw = json.dumps({"v": 99, "type": "chaos", "payload": {"llm_delay_ms": 800}}).encode()
    assert parse_control_message(raw) == ChaosCommand(llm_delay_ms=800)


def test_a_fractional_token_ceiling_truncates_rather_than_rejecting() -> None:
    """Deliberate, and consistent with how fractional delays are handled.

    `800.7 ms` truncates to 800 rather than being thrown away, so `30.9` tokens
    truncates to 30. A fraction below the floor lands on the floor, exactly as a
    negative delay lands on zero — the clamp is the policy for out-of-range input,
    whichever end it falls off.
    """
    assert parse_control_message(_packet({"max_completion_tokens": 30.9})) == ChaosCommand(
        max_completion_tokens=30
    )
    assert parse_control_message(_packet({"max_completion_tokens": 0.9})) == ChaosCommand(
        max_completion_tokens=MIN_COMPLETION_TOKENS
    )

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

import pricing
from chaos import MAX_DELAY_MS, AppliedDelayLog, ChaosController, parse_control_message
from telemetry import (
    MAX_PACKET_BYTES,
    SCHEMA_VERSION,
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
            assert payload["llm"]["llm_calls"] >= 1
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


def test_degraded_follows_the_delay_actually_applied() -> None:
    log = AppliedDelayLog()
    store = TurnStore(models=MODELS, applied_delay=log.take)

    log.record(0.0, request_id="r1")
    assert drive_turn(store, "t1", request_id="r1")[-1]["payload"]["degraded"] is False

    log.record(0.8, request_id="r2")
    degraded = drive_turn(store, "t2", ttft=1.15, request_id="r2")
    assert degraded[-1]["payload"]["degraded"] is True
    assert store.get("t2").total_response_latency == pytest.approx(0.41 + 1.15 + 0.19)

    log.record(0.0, request_id="r3")
    assert drive_turn(store, "t3", request_id="r3")[-1]["payload"]["degraded"] is False


def test_toggling_chaos_after_the_completion_ran_does_not_mark_the_turn() -> None:
    """Regression: degraded was read off the live toggle when metrics arrived.

    A visitor flipping the switch while the agent was already speaking painted the
    in-flight turn red even though its completion had run at full speed — and the
    reverse, flipping it off, painted a genuinely delayed turn clean.
    """
    log = AppliedDelayLog()
    store = TurnStore(models=MODELS, applied_delay=log.take)

    log.record(0.0, request_id="clean")  # this completion ran with chaos off
    store.record_eou("t1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    store.record_llm(
        "t1", ttft=0.3, duration=1.0, prompt_tokens=10, completion_tokens=5, request_id="clean"
    )
    # ...and only now does the visitor switch chaos on, mid-turn.
    env = store.record_tts("t1", ttfb=0.2, duration=1.0, audio_duration=2.0, characters_count=30)
    assert env["payload"]["degraded"] is False

    log.record(0.5, request_id="slow")  # this one really was delayed
    store.record_eou("t2", end_of_utterance_delay=0.4, transcription_delay=0.1)
    store.record_llm(
        "t2", ttft=0.9, duration=1.0, prompt_tokens=10, completion_tokens=5, request_id="slow"
    )
    # ...and the visitor switches chaos off again before this turn finishes.
    env = store.record_tts("t2", ttfb=0.2, duration=1.0, audio_duration=2.0, characters_count=30)
    assert env["payload"]["degraded"] is True


def test_a_degraded_step_anywhere_in_the_chain_marks_the_turn() -> None:
    log = AppliedDelayLog()
    store = TurnStore(models=MODELS, applied_delay=log.take)

    log.record(0.0, request_id="a")
    log.record(0.8, request_id="b")
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


def test_applied_delay_log_matches_on_request_id_and_falls_back_to_fifo() -> None:
    log = AppliedDelayLog()
    log.record(0.5, request_id="first")
    log.record(0.0, request_id="second")

    # Metrics can be claimed out of order when the ids are known.
    assert log.take("second") == pytest.approx(0.0)
    assert log.take("first") == pytest.approx(0.5)
    assert log.take("first") == pytest.approx(0.0), "an empty log means no delay applied"

    # A provider that reports no request id still gets the oldest unclaimed entry.
    log.record(0.3)
    log.record(0.9)
    assert log.take("") == pytest.approx(0.3)
    assert log.take(None) == pytest.approx(0.9)


def test_applied_delay_log_is_bounded() -> None:
    log = AppliedDelayLog(capacity=2)
    for i in range(5):
        log.record(float(i))
    assert [log.take(), log.take(), log.take()] == [3.0, 4.0, 0.0]


def test_chaos_controller_clamps_and_reports() -> None:
    chaos = ChaosController()
    assert chaos.envelope_payload() == {"llm_delay_ms": 0, "active": False}

    chaos.set_delay_ms(800)
    assert chaos.delay_seconds == pytest.approx(0.8)
    assert chaos.envelope_payload() == {"llm_delay_ms": 800, "active": True}

    chaos.set_delay_ms(-50)
    assert chaos.delay_ms == 0
    chaos.set_delay_ms(999_999)
    assert chaos.delay_ms == MAX_DELAY_MS


@pytest.mark.parametrize(
    "message",
    [
        {"v": 1, "type": "chaos", "payload": {"llm_delay_ms": 800}},
        {"v": 1, "type": "chaos", "payload": {"llm_delay_ms": 0}},
    ],
)
def test_parse_control_message_accepts_chaos(message: dict) -> None:
    assert (
        parse_control_message(json.dumps(message).encode()) == (message["payload"]["llm_delay_ms"])
    )


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
    ],
)
def test_parse_control_message_rejects_junk(raw: bytes) -> None:
    """The control channel is public: no payload may raise out of the data handler."""
    assert parse_control_message(raw) is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":800.7}}', 800),
        (b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":-5}}', -5),
        (b'{"v":1,"type":"chaos","payload":{"llm_delay_ms":1' + b"0" * 400 + b"}}", None),
    ],
)
def test_parse_control_message_normalises_odd_but_numeric_values(
    raw: bytes, expected: int | None
) -> None:
    """Out-of-range values survive parsing; the controller is what clamps them."""
    parsed = parse_control_message(raw)
    if expected is not None:
        assert parsed == expected
    else:
        # A 400-digit integer is finite, so it parses — and then clamps.
        assert parsed is not None and parsed > MAX_DELAY_MS

    chaos = ChaosController()
    chaos.set_delay_ms(parsed)
    assert 0 <= chaos.delay_ms <= MAX_DELAY_MS


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
                llm_model=MODELS.llm,
                prompt_tokens=usage["llm_prompt_tokens"],
                completion_tokens=usage["llm_completion_tokens"],
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
            llm_model="someone/unreleased-model",
            prompt_tokens=1_000_000,
            completion_tokens=0,
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
    log = AppliedDelayLog()
    store = TurnStore(models=MODELS, applied_delay=log.take)
    log.record(0.8, request_id="r1")
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
    log = AppliedDelayLog()
    source = TurnStore(models=MODELS, applied_delay=log.take)
    log.record(0.0, request_id="r1")
    emitted = drive_turn(source, "t1", request_id="r1")
    log.record(0.8, request_id="r2")
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

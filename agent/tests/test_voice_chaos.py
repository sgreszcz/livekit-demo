"""Tests for arming chaos BY VOICE — the `set_chaos` function tool.

A caller on a SIP trunk has no dashboard, so the tool is the only way they can reach
chaos mode at all. That makes two things load-bearing and both are asserted here: the
tool goes through the *same* :class:`ChaosController` and the *same* ack builder as the
browser's control channel, so the two paths cannot disagree about state; and what it
hands back is a sentence the model can read aloud, not a serialised state object.

No network, no credentials, no room: the publisher is constructed against ``None``,
which makes it record envelopes instead of transmitting them.
"""

from __future__ import annotations

import json

import pytest
from livekit.agents import APIConnectOptions, llm
from livekit.agents.llm.utils import build_legacy_openai_schema

import agent
from chaos import (
    VOICE_INJECTIONS,
    ChaosController,
    DelayedLLM,
    plan_voice_chaos,
)
from telemetry import PipelineModels, TelemetryPublisher, TurnStore, encode_envelope

MODELS = PipelineModels(stt="deepgram/nova-3", llm="openai/gpt-4.1-mini", tts="cartesia/sonic-3")
CONN_OPTIONS = APIConnectOptions(max_retry=0, retry_interval=0.0, timeout=5.0)


# --------------------------------------------------------------------------- fixtures


class _Harness:
    """One call's worth of wiring: controller, publisher, broadcaster, store, agent."""

    def __init__(self, chooser=None) -> None:
        self.chaos = ChaosController()
        self.publisher = TelemetryPublisher(None)
        self.broadcaster = agent.ChaosBroadcaster(self.chaos, self.publisher)
        self.store = TurnStore(
            models=MODELS,
            applied_llm_chaos=self.chaos.llm_applied.take,
            applied_tts_chaos=self.chaos.tts_applied.take,
        )
        kwargs = {"chooser": chooser} if chooser is not None else {}
        self.guide = agent.GlassCockpitAgent(self.store, self.broadcaster, **kwargs)

    @property
    def state(self) -> dict:
        return self.chaos.envelope_payload()

    @property
    def acks(self) -> list[dict]:
        return [env for env in self.publisher.messages if env["type"] == "chaos"]


@pytest.fixture
def call() -> _Harness:
    return _Harness()


class FakeLLM(llm.LLM):
    """An in-process model that answers instantly and records how it was called.

    Deliberately local rather than shared with ``test_chaos_llm``: the only thing this
    module needs from a model is the kwargs the wrapper forwarded, and a test file that
    imports another test file breaks the moment either is renamed.
    """

    def __init__(self) -> None:
        super().__init__()
        self.chunk_id = "req-1"
        self.chat_kwargs: list[dict] = []

    @property
    def model(self) -> str:
        return "fake/instant"

    @property
    def provider(self) -> str:
        return "fake"

    def chat(self, *, chat_ctx, tools=None, conn_options=CONN_OPTIONS, **kwargs) -> llm.LLMStream:
        self.chat_kwargs.append(kwargs)
        return _FakeStream(self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options)


class _FakeStream(llm.LLMStream):
    def __init__(self, fake: FakeLLM, *, chat_ctx, tools, conn_options) -> None:
        self._chunk_id = fake.chunk_id
        super().__init__(fake, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)

    async def _run(self) -> None:
        self._event_ch.send_nowait(
            llm.ChatChunk(id=self._chunk_id, delta=llm.ChoiceDelta(role="assistant", content="hi"))
        )


async def _drain(stream: llm.LLMStream) -> None:
    async for _ in stream:
        pass
    await stream.aclose()


def _chat_ctx() -> llm.ChatContext:
    ctx = llm.ChatContext.empty()
    ctx.add_message(role="user", content="hello")
    return ctx


# ------------------------------------------------------------------- what it applies


@pytest.mark.parametrize(
    ("injection", "intensity", "expected"),
    [
        ("latency", "mild", {"llm_delay_ms": 800}),
        ("latency", "severe", {"llm_delay_ms": 1500}),
        ("voice_delay", "mild", {"tts_delay_ms": 300}),
        ("voice_delay", "severe", {"tts_delay_ms": 600}),
        ("slow_model", "mild", {"slow_model": True}),
        ("slow_model", "severe", {"slow_model": True}),
        ("token_starvation", "mild", {"max_completion_tokens": 30}),
        ("token_starvation", "severe", {"max_completion_tokens": 15}),
    ],
)
@pytest.mark.asyncio
async def test_each_injection_reaches_the_controller(
    call: _Harness, injection: str, intensity: str, expected: dict
) -> None:
    """Every enum value moves the real controller, and only its own field."""
    await call.guide.set_chaos(None, injection, intensity)

    clean = {
        "llm_delay_ms": 0,
        "tts_delay_ms": 0,
        "slow_model": False,
        "max_completion_tokens": None,
    }
    assert call.state == {**clean, **expected, "active": True}


@pytest.mark.parametrize("injection", [*VOICE_INJECTIONS, "random", "off"])
@pytest.mark.asyncio
async def test_confirmation_is_spoken_english(call: _Harness, injection: str) -> None:
    """The return value is read aloud verbatim, so it must contain nothing unspeakable.

    No JSON and no bare figures: every number in the mapping is written out in words,
    because "800" reaching text-to-speech is a coin flip between "eight hundred" and
    "eight zero zero". A digit anywhere in the reply is the bug this catches.
    """
    reply = await call.guide.set_chaos(None, injection)

    assert not any(char.isdigit() for char in reply)
    assert not any(char in reply for char in '{}[]"_')
    assert reply.endswith(".")
    assert len(reply.split()) >= 8


@pytest.mark.asyncio
async def test_off_clears_every_field(call: _Harness) -> None:
    """`off` is a full reset — all four injections, not just the last one armed."""
    call.chaos.set_llm_delay_ms(900)
    call.chaos.set_tts_delay_ms(400)
    call.chaos.set_slow_model(True)
    call.chaos.set_max_completion_tokens(20)

    await call.guide.set_chaos(None, "off")

    assert call.state == {
        "llm_delay_ms": 0,
        "tts_delay_ms": 0,
        "slow_model": False,
        "max_completion_tokens": None,
        "active": False,
    }


@pytest.mark.asyncio
async def test_off_is_safe_when_nothing_is_armed(call: _Harness) -> None:
    """A caller can ask to stop something they never started; it still acks."""
    reply = await call.guide.set_chaos(None, "off")

    assert call.state["active"] is False
    assert reply
    assert len(call.acks) == 1


@pytest.mark.asyncio
async def test_each_call_replaces_the_whole_state(call: _Harness) -> None:
    """Injections do not stack: the model cannot see the state, so it cannot layer.

    Three requests in a row must leave the call in the state the third one describes,
    not in a compound one that none of the three confirmations was true about.
    """
    await call.guide.set_chaos(None, "latency", "severe")
    await call.guide.set_chaos(None, "slow_model")
    await call.guide.set_chaos(None, "token_starvation", "mild")

    assert call.state == {
        "llm_delay_ms": 0,
        "tts_delay_ms": 0,
        "slow_model": False,
        "max_completion_tokens": 30,
        "active": True,
    }


@pytest.mark.asyncio
async def test_repeating_the_same_request_is_idempotent(call: _Harness) -> None:
    first = await call.guide.set_chaos(None, "latency")
    second = await call.guide.set_chaos(None, "latency")

    assert first == second
    assert call.state["llm_delay_ms"] == 800
    assert len(call.acks) == 2


# -------------------------------------------------------------------------- random


@pytest.mark.asyncio
async def test_random_picks_exactly_one_injection() -> None:
    """`random` arms one of the four and nothing else, whichever one it lands on.

    The chooser is injected rather than seeding the global RNG: a seeded global is
    shared with anything else the process does, and the property under test is "one
    injection, chosen from this exact set", not "this particular one".
    """
    for expected in VOICE_INJECTIONS:
        seen: list[tuple] = []

        def chooser(options, _pick=expected, _seen=seen):
            _seen.append(tuple(options))
            return _pick

        call = _Harness(chooser=chooser)
        await call.guide.set_chaos(None, "random")

        assert seen == [VOICE_INJECTIONS]
        armed = [
            field
            for field, value in call.state.items()
            if field != "active" and value not in (0, False, None)
        ]
        assert len(armed) == 1


@pytest.mark.asyncio
async def test_random_is_deterministic_under_an_injected_chooser() -> None:
    """Same chooser, same request, same state and same words — every time."""
    replies = set()
    states = []
    for _ in range(3):
        call = _Harness(chooser=lambda options: options[1])
        replies.add(await call.guide.set_chaos(None, "random", "severe"))
        states.append(call.state)

    assert len(replies) == 1
    assert states[0] == states[1] == states[2]
    # options[1] is "voice_delay"; severe is 600 ms.
    assert states[0]["tts_delay_ms"] == 600


@pytest.mark.asyncio
async def test_random_says_it_was_random() -> None:
    """The visitor is told a choice was made for them, not just what it was."""
    call = _Harness(chooser=lambda options: "slow_model")
    reply = await call.guide.set_chaos(None, "random")

    assert reply.startswith("I picked one at random.")
    assert "heavier language model" in reply


def test_plan_refuses_an_injection_outside_the_enum() -> None:
    """Guessing would be worse than refusing — the nearest guess to junk is `off`."""
    with pytest.raises(ValueError, match="unknown chaos injection"):
        plan_voice_chaos("nonsense")


def test_plan_falls_back_to_mild_for_an_unknown_intensity() -> None:
    """The SDK validates the enum, so this only guards a direct caller — mildly."""
    assert plan_voice_chaos("latency", "catastrophic").command.llm_delay_ms == 800


# ------------------------------------------------------------------ the ack envelope


def _normalised(env: dict) -> bytes:
    """An envelope with its timestamp pinned, so two paths can be compared as bytes."""
    return encode_envelope({**env, "ts": 1723000000.0})


@pytest.mark.asyncio
async def test_ack_is_identical_to_the_data_channel_path(call: _Harness) -> None:
    """Voice and browser must produce the same ack for the same resulting state.

    Not "the same shape" by inspection — the same bytes, from the same builder. The
    browser command is written the way the cockpit's panel writes it (v1.3, full state)
    and the tool is asked for the equivalent; if either path ever grew its own envelope
    literal, the dashboards would start disagreeing about what the agent is doing.
    """
    packet = json.dumps(
        {
            "v": 1,
            "type": "chaos",
            "payload": {
                "llm_delay_ms": 800,
                "tts_delay_ms": 0,
                "slow_model": False,
                "max_completion_tokens": None,
            },
        }
    ).encode()
    browser_ack = agent.apply_control_packet(packet, call.broadcaster)

    voice = _Harness()
    await voice.guide.set_chaos(None, "latency", "mild")
    voice_ack = voice.acks[-1]

    assert browser_ack is not None
    assert _normalised(browser_ack) == _normalised(voice_ack)
    assert browser_ack["type"] == "chaos"
    assert browser_ack["payload"]["llm_delay_ms"] == 800


@pytest.mark.asyncio
async def test_the_tool_publishes_its_ack(call: _Harness) -> None:
    """Every cockpit and the dashboard learn about a voice change immediately."""
    await call.guide.set_chaos(None, "token_starvation", "severe")

    assert len(call.acks) == 1
    assert call.acks[0]["payload"] == {
        "llm_delay_ms": 0,
        "tts_delay_ms": 0,
        "slow_model": False,
        "max_completion_tokens": 15,
        "active": True,
    }


def test_tool_schema_offers_the_model_two_enums() -> None:
    """What the model actually sees. Four numeric knobs is what this replaced."""
    call = _Harness()
    schema = build_legacy_openai_schema(call.guide.set_chaos)
    params = schema["function"]["parameters"]

    assert schema["function"]["name"] == "set_chaos"
    assert params["properties"]["injection"]["enum"] == [
        "latency",
        "voice_delay",
        "slow_model",
        "token_starvation",
        "random",
        "off",
    ]
    assert params["properties"]["intensity"]["enum"] == ["mild", "severe"]
    assert params["properties"]["intensity"]["default"] == "mild"
    assert params["required"] == ["injection"]
    # RunContext is injected by the SDK, never asked of the model.
    assert "ctx" not in params["properties"]


# ------------------------------------------------------------------- attribution


@pytest.mark.asyncio
async def test_the_turn_that_arms_chaos_is_itself_degraded() -> None:
    """A turn armed mid-turn by its own tool call is degraded — and should be.

    Arming by voice is a TOOL-CALLING turn: the model runs once to emit the tool call,
    the tool changes the pipeline, and the model runs again to speak the confirmation.
    The second invocation genuinely runs under the injection — here, clamped to thirty
    completion tokens — so the caller hears the degradation on the very answer that
    announces it.

    Attributing that turn as clean would therefore be a lie of exactly the kind the
    per-invocation attribution exists to prevent: the dashboard would print
    "degraded: false" against the turn the visitor is at that moment listening to
    degrade. The tool's spoken confirmation makes the same promise ("the dashboard will
    flag this turn as degraded"), so this test is what keeps that sentence true.

    ``token_starvation`` is the injection under test because it is the one with no
    sleep in it: the attribution question is identical for all four, and asserting it
    does not need the suite to spend eight hundred real milliseconds proving it.
    """
    call = _Harness()
    fake = FakeLLM()
    delayed = DelayedLLM(fake, call.chaos)

    call.store.record_eou("turn-1", end_of_utterance_delay=0.4, transcription_delay=0.1)

    # Invocation one: the model decides to call the tool. Chaos is still off.
    fake.chunk_id = "req-1"
    await _drain(delayed.chat(chat_ctx=_chat_ctx()))
    call.store.record_llm(
        "turn-1", ttft=0.2, duration=0.3, prompt_tokens=10, completion_tokens=4, request_id="req-1"
    )
    assert call.store.get("turn-1").degraded is False

    # The tool call itself, in the middle of that same turn.
    await call.guide.set_chaos(None, "token_starvation", "mild")

    # Invocation two: the spoken confirmation, now running under the clamp.
    fake.chunk_id = "req-2"
    await _drain(delayed.chat(chat_ctx=_chat_ctx()))
    call.store.record_llm(
        "turn-1", ttft=0.2, duration=0.3, prompt_tokens=20, completion_tokens=8, request_id="req-2"
    )

    turn = call.store.get("turn-1")
    assert turn.degraded is True
    assert len(turn.llm_chain) == 2
    assert turn.llm["llm_calls"] == 2
    # The clamp did not merely get recorded — it reached the second request.
    assert "max_completion_tokens" not in (fake.chat_kwargs[0].get("extra_kwargs") or {})
    assert fake.chat_kwargs[1]["extra_kwargs"]["max_completion_tokens"] == 30


@pytest.mark.asyncio
async def test_a_later_turn_is_clean_once_chaos_is_turned_off_by_voice() -> None:
    """The mirror image: `off` mid-turn leaves the NEXT turn unflagged."""
    call = _Harness()
    fake = FakeLLM()
    delayed = DelayedLLM(fake, call.chaos)

    await call.guide.set_chaos(None, "token_starvation", "severe")
    call.store.record_eou("turn-1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    fake.chunk_id = "req-1"
    await _drain(delayed.chat(chat_ctx=_chat_ctx()))
    call.store.record_llm(
        "turn-1", ttft=0.2, duration=0.3, prompt_tokens=10, completion_tokens=4, request_id="req-1"
    )
    assert call.store.get("turn-1").degraded is True

    await call.guide.set_chaos(None, "off")
    call.store.record_eou("turn-2", end_of_utterance_delay=0.4, transcription_delay=0.1)
    fake.chunk_id = "req-2"
    await _drain(delayed.chat(chat_ctx=_chat_ctx()))
    call.store.record_llm(
        "turn-2", ttft=0.2, duration=0.3, prompt_tokens=10, completion_tokens=4, request_id="req-2"
    )

    assert call.store.get("turn-2").degraded is False


# --------------------------------------------------------------------- the persona


def test_instructions_teach_the_offer_and_the_tool() -> None:
    """The tool is useless if the persona never mentions it or arms it unasked."""
    text = agent.INSTRUCTIONS

    assert "set_chaos" in text
    assert "Never arm it unprompted." in text
    assert "at random" in text
    assert "degraded" in text


def test_greeting_is_unchanged() -> None:
    """On the critical path of the one number this demo exists to show."""
    assert agent.GREETING == (
        "Welcome to Glass Cockpit. You're talking to a live LiveKit voice agent, and every "
        "measurement of this call — including this sentence — is streaming to the dashboard. "
        "Ask me anything, or ask how the call quality is."
    )

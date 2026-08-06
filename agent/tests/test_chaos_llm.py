"""Tests for the chaos LLM wrapper, against a fake in-process model.

The wrapper's whole value is that the injected delay shows up in the *measured*
time-to-first-token rather than being reported cosmetically, so that is what these
tests assert. No network and no credentials are involved.
"""

from __future__ import annotations

import asyncio

import pytest
from livekit.agents import APIConnectOptions, llm

from chaos import ChaosController, DelayedLLM
from telemetry import PipelineModels, TurnStore

CONN_OPTIONS = APIConnectOptions(max_retry=0, retry_interval=0.0, timeout=5.0)


class FakeLLMStream(llm.LLMStream):
    def __init__(self, fake_llm: FakeLLM, *, chat_ctx, tools, conn_options) -> None:
        super().__init__(fake_llm, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)

    async def _run(self) -> None:
        for token in ("Hello", " there"):
            self._event_ch.send_nowait(
                llm.ChatChunk(id="fake-1", delta=llm.ChoiceDelta(role="assistant", content=token))
            )
        self._event_ch.send_nowait(
            llm.ChatChunk(
                id="fake-1",
                usage=llm.CompletionUsage(prompt_tokens=10, completion_tokens=2, total_tokens=12),
            )
        )


class FakeLLM(llm.LLM):
    """Responds instantly, and records how it was called."""

    def __init__(self) -> None:
        super().__init__()
        self.calls = 0
        self.closed = False

    @property
    def model(self) -> str:
        return "fake/instant"

    @property
    def provider(self) -> str:
        return "fake"

    def chat(self, *, chat_ctx, tools=None, conn_options=CONN_OPTIONS, **kwargs) -> llm.LLMStream:
        self.calls += 1
        return FakeLLMStream(self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options)

    async def aclose(self) -> None:
        self.closed = True


async def _collect(stream: llm.LLMStream) -> tuple[str, float]:
    """Drain a stream, returning its text and the wall time to the first chunk."""
    started = asyncio.get_running_loop().time()
    ttft = None
    text = ""
    async for chunk in stream:
        if ttft is None:
            ttft = asyncio.get_running_loop().time() - started
        if chunk.delta and chunk.delta.content:
            text += chunk.delta.content
    await stream.aclose()
    return text, ttft or 0.0


@pytest.fixture
def chat_ctx() -> llm.ChatContext:
    ctx = llm.ChatContext.empty()
    ctx.add_message(role="user", content="hello")
    return ctx


def test_delayed_llm_reports_wrapped_model_identity() -> None:
    delayed = DelayedLLM(FakeLLM(), ChaosController())
    assert delayed.model == "fake/instant"
    assert delayed.provider == "fake"


@pytest.mark.asyncio
async def test_passes_through_when_chaos_is_off(chat_ctx: llm.ChatContext) -> None:
    inner = FakeLLM()
    delayed = DelayedLLM(inner, ChaosController())

    text, ttft = await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    assert text == "Hello there"
    assert inner.calls == 1
    assert ttft < 0.1


@pytest.mark.asyncio
async def test_injected_delay_lands_in_time_to_first_token(chat_ctx: llm.ChatContext) -> None:
    inner = FakeLLM()
    chaos = ChaosController(300)
    delayed = DelayedLLM(inner, chaos)

    text, ttft = await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    assert text == "Hello there"
    assert ttft >= 0.3, "the sleep must precede the first chunk, not run alongside it"


@pytest.mark.asyncio
async def test_delay_is_changeable_between_calls(chat_ctx: llm.ChatContext) -> None:
    """The browser can retune chaos mid-call without a model swap."""
    inner = FakeLLM()
    chaos = ChaosController()
    delayed = DelayedLLM(inner, chaos)

    _, fast = await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    chaos.set_delay_ms(250)
    _, slow = await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    chaos.set_delay_ms(0)
    _, fast_again = await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    assert fast < 0.1
    assert slow >= 0.25
    assert fast_again < 0.1
    assert inner.calls == 3


@pytest.mark.asyncio
async def test_metrics_ttft_includes_the_injected_delay(chat_ctx: llm.ChatContext) -> None:
    """The SDK's own metrics — what the cockpit renders — must show the degradation."""
    delayed = DelayedLLM(FakeLLM(), ChaosController(300))
    collected: list[object] = []
    delayed.on("metrics_collected", collected.append)

    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    await asyncio.sleep(0.05)  # let the stream's metrics task publish

    assert collected, "the wrapper must emit LLMMetrics like any other LLM"
    metrics = collected[0]
    assert metrics.ttft >= 0.3
    assert metrics.completion_tokens == 2


@pytest.mark.asyncio
async def test_applied_delay_is_logged_against_the_completions_request_id(
    chat_ctx: llm.ChatContext,
) -> None:
    chaos = ChaosController(120)
    delayed = DelayedLLM(FakeLLM(), chaos)

    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    assert chaos.applied.take("fake-1") == pytest.approx(0.12)


@pytest.mark.asyncio
async def test_turn_degradation_follows_the_completion_not_the_live_toggle(
    chat_ctx: llm.ChatContext,
) -> None:
    """End to end: a turn is degraded only if chaos delayed *its* completion.

    Regression for the attribution race — the visitor toggling chaos on while the
    agent was already answering used to repaint the in-flight turn as degraded.
    """
    chaos = ChaosController()
    store = TurnStore(
        models=PipelineModels(stt="deepgram/nova-3", llm="fake/instant", tts="cartesia/sonic-3"),
        applied_delay=chaos.applied.take,
    )
    delayed = DelayedLLM(FakeLLM(), chaos)
    metrics: list[object] = []
    delayed.on("metrics_collected", metrics.append)

    # The completion runs with chaos off...
    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    await asyncio.sleep(0.05)
    # ...and the visitor flips the switch before the metrics are folded into the turn.
    chaos.set_delay_ms(800)

    assert metrics, "the wrapper must emit LLMMetrics like any other LLM"
    m = metrics[0]
    store.record_eou("t1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    store.record_llm(
        "t1",
        ttft=m.ttft,
        duration=m.duration,
        prompt_tokens=m.prompt_tokens,
        completion_tokens=m.completion_tokens,
        request_id=m.request_id,
    )
    env = store.record_tts("t1", ttfb=0.2, duration=1.0, audio_duration=2.0, characters_count=30)

    assert chaos.active is True
    assert env["payload"]["degraded"] is False
    assert store.get("t1").degraded is False


@pytest.mark.asyncio
async def test_aclose_closes_the_wrapped_model() -> None:
    inner = FakeLLM()
    await DelayedLLM(inner, ChaosController()).aclose()
    assert inner.closed is True

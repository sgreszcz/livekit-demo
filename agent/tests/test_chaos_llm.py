"""Tests for the chaos LLM wrapper, against a fake in-process model.

The wrapper's whole value is that the injected delay shows up in the *measured*
time-to-first-token rather than being reported cosmetically, so that is what these
tests assert. No network and no credentials are involved.
"""

from __future__ import annotations

import asyncio

import pytest
from livekit.agents import APIConnectionError, APIConnectOptions, APIError, llm
from livekit.agents.utils import is_given

from chaos import AppliedChaosLog, ChaosController, DelayedLLM
from telemetry import AppliedChaos, PipelineModels, TurnStore

CONN_OPTIONS = APIConnectOptions(max_retry=0, retry_interval=0.0, timeout=5.0)


class FakeLLMStream(llm.LLMStream):
    def __init__(self, fake_llm: FakeLLM, *, chat_ctx, tools, conn_options) -> None:
        self._chunk_id = fake_llm.chunk_id
        self._tokens = fake_llm.tokens
        super().__init__(fake_llm, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)

    async def _run(self) -> None:
        for token in self._tokens:
            self._event_ch.send_nowait(
                llm.ChatChunk(
                    id=self._chunk_id, delta=llm.ChoiceDelta(role="assistant", content=token)
                )
            )
        self._event_ch.send_nowait(
            llm.ChatChunk(
                id=self._chunk_id,
                usage=llm.CompletionUsage(
                    prompt_tokens=10, completion_tokens=len(self._tokens), total_tokens=12
                ),
            )
        )


class FakeLLM(llm.LLM):
    """Responds instantly, and records how it was called."""

    def __init__(
        self,
        model: str = "fake/instant",
        *,
        chunk_id: str = "fake-1",
        tokens: tuple[str, ...] = ("Hello", " there"),
    ) -> None:
        super().__init__()
        self._model = model
        self.chunk_id = chunk_id
        self.tokens = tokens
        self.calls = 0
        self.closed = False
        self.prewarmed = 0
        self.chat_kwargs: list[dict] = []
        """Every call's kwargs, so per-invocation generation params can be asserted."""

    @property
    def model(self) -> str:
        return self._model

    @property
    def provider(self) -> str:
        return "fake"

    def prewarm(self, *, loop=None) -> None:
        # Overridden rather than counted via `_prewarm_impl`, because the base
        # `prewarm()` no-ops entirely unless a subclass provides that hook.
        self.prewarmed += 1

    def chat(self, *, chat_ctx, tools=None, conn_options=CONN_OPTIONS, **kwargs) -> llm.LLMStream:
        self.calls += 1
        self.chat_kwargs.append(kwargs)
        return FakeLLMStream(self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options)

    async def aclose(self) -> None:
        self.closed = True


def slow_fake() -> FakeLLM:
    """A stand-in for the heavier model: a different identity and a different id."""
    return FakeLLM("fake/slow", chunk_id="fake-slow-1")


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
    chaos.set_llm_delay_ms(250)
    _, slow = await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    chaos.set_llm_delay_ms(0)
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

    applied = chaos.llm_applied.take("fake-1")
    assert applied.delay == pytest.approx(0.12)
    assert applied.model == "fake/instant"
    assert applied.degraded is True


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
        applied_llm_chaos=chaos.llm_applied.take,
    )
    delayed = DelayedLLM(FakeLLM(), chaos)
    metrics: list[object] = []
    delayed.on("metrics_collected", metrics.append)

    # The completion runs with chaos off...
    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    await asyncio.sleep(0.05)
    # ...and the visitor flips the switch before the metrics are folded into the turn.
    chaos.set_llm_delay_ms(800)

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


# ------------------------------------------------------------------ slow model


@pytest.mark.asyncio
async def test_slow_model_is_chosen_per_invocation(chat_ctx: llm.ChatContext) -> None:
    """The swap is a choice between two warm instances, not a mutation of one."""
    default, slow = FakeLLM(), slow_fake()
    chaos = ChaosController()
    delayed = DelayedLLM(default, chaos, slow=slow)

    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    assert (default.calls, slow.calls) == (1, 0)

    chaos.set_slow_model(True)
    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    assert (default.calls, slow.calls) == (1, 1)

    chaos.set_slow_model(False)
    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    assert (default.calls, slow.calls) == (2, 1)


@pytest.mark.asyncio
async def test_the_wrapper_still_names_the_configured_model(chat_ctx: llm.ChatContext) -> None:
    """`model` is the pipeline's identity, which call_meta reports; it does not flip."""
    chaos = ChaosController(slow_model=True)
    delayed = DelayedLLM(FakeLLM(), chaos, slow=slow_fake())

    assert delayed.model == "fake/instant"

    # The per-invocation truth lives in the applied record instead.
    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    assert chaos.llm_applied.take("fake-slow-1").model == "fake/slow"


@pytest.mark.asyncio
async def test_without_a_slow_instance_the_toggle_is_inert(chat_ctx: llm.ChatContext) -> None:
    """A worker started without a slow model must degrade to a no-op, not an error."""
    default = FakeLLM()
    chaos = ChaosController(slow_model=True)
    delayed = DelayedLLM(default, chaos)  # no slow= given

    text, _ = await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    assert text == "Hello there"
    assert default.calls == 1
    applied = chaos.llm_applied.take("fake-1")
    assert applied.slow_model is False, "nothing was swapped, so nothing may be claimed"
    assert applied.degraded is False


@pytest.mark.asyncio
async def test_the_turn_envelope_reports_the_model_that_actually_ran(
    chat_ctx: llm.ChatContext,
) -> None:
    """End to end: SDK metrics in, and the cockpit is told which model produced them."""
    chaos = ChaosController(slow_model=True)
    store = TurnStore(
        models=PipelineModels(stt="deepgram/nova-3", llm="fake/instant", tts="cartesia/sonic-3"),
        applied_llm_chaos=chaos.llm_applied.take,
    )
    delayed = DelayedLLM(FakeLLM(), chaos, slow=slow_fake())
    metrics: list[object] = []
    delayed.on("metrics_collected", metrics.append)

    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))
    await asyncio.sleep(0.05)

    assert metrics
    m = metrics[0]
    env = store.record_llm(
        "t1",
        ttft=m.ttft,
        duration=m.duration,
        prompt_tokens=m.prompt_tokens,
        completion_tokens=m.completion_tokens,
        request_id=m.request_id,
    )

    assert env["payload"]["llm"]["model"] == "fake/slow"
    assert store.get("t1").degraded is True, "a heavier model is a degradation on its own"


@pytest.mark.asyncio
async def test_aclose_closes_the_slow_model_too() -> None:
    default, slow = FakeLLM(), slow_fake()
    await DelayedLLM(default, ChaosController(), slow=slow).aclose()
    assert (default.closed, slow.closed) == (True, True)


# ------------------------------------------------------------------ token clamp


@pytest.mark.asyncio
async def test_token_clamp_is_forwarded_as_a_generation_param(
    chat_ctx: llm.ChatContext,
) -> None:
    """Verified against livekit-agents 1.6.8: inference.LLM.chat merges extra_kwargs
    into the dict it splats onto the provider's chat.completions.create, and
    max_completion_tokens is a declared member of its ChatCompletionOptions."""
    inner = FakeLLM()
    chaos = ChaosController(max_completion_tokens=30)
    delayed = DelayedLLM(inner, chaos)

    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    assert inner.chat_kwargs[0]["extra_kwargs"] == {"max_completion_tokens": 30}


@pytest.mark.asyncio
async def test_no_clamp_sends_no_generation_param(chat_ctx: llm.ChatContext) -> None:
    """Off must mean absent, not `max_completion_tokens: None` — the provider would
    read an explicit null differently from an omitted field."""
    inner = FakeLLM()
    delayed = DelayedLLM(inner, ChaosController())

    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    assert not is_given(inner.chat_kwargs[0]["extra_kwargs"])


@pytest.mark.asyncio
async def test_the_clamp_rides_alongside_the_callers_own_extra_kwargs(
    chat_ctx: llm.ChatContext,
) -> None:
    """Chaos adds a knob; it must not eat the ones the framework already set."""
    inner = FakeLLM()
    delayed = DelayedLLM(inner, ChaosController(max_completion_tokens=30))

    await _collect(
        delayed.chat(
            chat_ctx=chat_ctx, conn_options=CONN_OPTIONS, extra_kwargs={"temperature": 0.2}
        )
    )

    assert inner.chat_kwargs[0]["extra_kwargs"] == {
        "temperature": 0.2,
        "max_completion_tokens": 30,
    }


@pytest.mark.asyncio
async def test_the_clamp_is_frozen_per_invocation(chat_ctx: llm.ChatContext) -> None:
    """A toggle moving mid-stream cannot rewrite what an in-flight call was sent."""
    inner = FakeLLM()
    chaos = ChaosController()
    delayed = DelayedLLM(inner, chaos)

    stream = delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS)
    chaos.set_max_completion_tokens(30)  # the visitor flips it after chat() was called
    await _collect(stream)

    assert not is_given(inner.chat_kwargs[0]["extra_kwargs"])
    applied = chaos.llm_applied.take("fake-1")
    assert applied.max_completion_tokens is None
    assert applied.degraded is False


@pytest.mark.asyncio
async def test_a_clamped_invocation_is_recorded_as_degraded(chat_ctx: llm.ChatContext) -> None:
    chaos = ChaosController(max_completion_tokens=30)
    delayed = DelayedLLM(FakeLLM(), chaos)

    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    applied = chaos.llm_applied.take("fake-1")
    assert applied.max_completion_tokens == 30
    assert applied.delay == pytest.approx(0.0)
    assert applied.degraded is True, "a truncated answer is a degradation with no delay"


@pytest.mark.asyncio
async def test_the_delay_is_frozen_per_invocation(chat_ctx: llm.ChatContext) -> None:
    """Same freeze as the clamp: chat() decides, the stream obeys.

    The stream's task is scheduled some time after chat() returns, so reading the
    toggle inside `_run` would let a slider moved in that window retune a completion
    the metrics clock had already started timing.
    """
    inner = FakeLLM()
    chaos = ChaosController()
    delayed = DelayedLLM(inner, chaos)

    stream = delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS)
    chaos.set_llm_delay_ms(400)  # the visitor flips it after chat() was called
    _, ttft = await _collect(stream)

    assert ttft < 0.1, "this completion was decided before the toggle moved"
    assert chaos.llm_applied.take("fake-1").delay == pytest.approx(0.0)


@pytest.mark.asyncio
async def test_prewarm_reaches_both_models() -> None:
    """`LLM.prewarm` no-ops on a wrapper that inherits it, leaving both clients cold.

    The session prewarms the LLM it was given, which is this wrapper. If the call
    stopped here, the first reply of every call would pay for DNS and TLS — on a demo
    whose whole subject is time-to-first-token.
    """
    default, slow = FakeLLM(), slow_fake()

    DelayedLLM(default, ChaosController(), slow=slow).prewarm()

    assert (default.prewarmed, slow.prewarmed) == (1, 1)


@pytest.mark.asyncio
async def test_prewarm_without_a_slow_model_is_harmless() -> None:
    default = FakeLLM()
    DelayedLLM(default, ChaosController()).prewarm()
    assert default.prewarmed == 1


# ------------------------------------------------------- attribution under failure


class FailingLLM(FakeLLM):
    """Streams one chunk, then dies the way an overloaded provider does."""

    def chat(self, *, chat_ctx, tools=None, conn_options=CONN_OPTIONS, **kwargs) -> llm.LLMStream:
        self.calls += 1
        self.chat_kwargs.append(kwargs)
        return FailingLLMStream(
            self, chat_ctx=chat_ctx, tools=tools or [], conn_options=CONN_OPTIONS
        )


class FailingLLMStream(FakeLLMStream):
    async def _run(self) -> None:
        self._event_ch.send_nowait(
            llm.ChatChunk(id="fake-1", delta=llm.ChoiceDelta(role="assistant", content="Hel"))
        )
        raise APIConnectionError("provider went away")


@pytest.mark.asyncio
async def test_a_failed_completion_withdraws_its_attribution_record(
    chat_ctx: llm.ChatContext,
) -> None:
    """Otherwise the next clean turn inherits this one's chaos and is painted red.

    The SDK reports no metrics for an errored attempt, so the record filed on the first
    chunk would never be claimed by its own metric — it would sit in the log until some
    later completion's lookup fell through to the FIFO fallback and took it.
    """
    chaos = ChaosController(800)
    delayed = DelayedLLM(FailingLLM(), chaos)

    with pytest.raises(APIError):
        await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    # Nothing is left behind for the next turn to trip over.
    assert chaos.llm_applied.take().degraded is False
    assert chaos.llm_applied.take("fake-1").degraded is False


@pytest.mark.asyncio
async def test_a_cancelled_completion_keeps_its_record(chat_ctx: llm.ChatContext) -> None:
    """A barge-in still reports metrics, so its record must still be there to claim.

    Discarding on cancellation would be the mirror-image bug: the turn really was
    delayed, the metric really does arrive, and the cockpit would show it clean.
    """
    chaos = ChaosController(50)
    delayed = DelayedLLM(FakeLLM(), chaos)

    await _collect(delayed.chat(chat_ctx=chat_ctx, conn_options=CONN_OPTIONS))

    assert chaos.llm_applied.take("fake-1").delay == pytest.approx(0.05)


def test_discarding_an_unknown_request_id_is_a_no_op() -> None:
    log = AppliedChaosLog()
    log.record(AppliedChaos(delay=0.5), request_id="keep")

    log.discard("never-recorded")

    assert log.take("keep").delay == pytest.approx(0.5)

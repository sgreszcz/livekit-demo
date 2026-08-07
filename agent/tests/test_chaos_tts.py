"""Tests for the chaos TTS wrapper, against a fake in-process voice.

The wrapper's whole value is the same as :mod:`test_chaos_llm`'s: the injected delay
has to show up in the *measured* time-to-first-byte the cockpit renders, not in a
cosmetic number alongside it. So the assertions are made against the ``TTSMetrics`` the
SDK itself emits, and against the audio actually arriving at the far end.

No network and no credentials are involved.
"""

from __future__ import annotations

import asyncio

import pytest
from livekit.agents import APIConnectionError, APIConnectOptions, APIError, tts

from chaos import ChaosController, DelayedTTS
from telemetry import PipelineModels, TurnStore

CONN_OPTIONS = APIConnectOptions(max_retry=0, retry_interval=0.0, timeout=5.0)

SAMPLE_RATE = 24_000
NUM_CHANNELS = 1
# 200 ms of silence: one frame's worth at the emitter's default frame size, so the
# fake voice produces audio without the test caring how the emitter re-chunks it.
AUDIO_SECONDS = 0.2
SILENCE = b"\x00\x00" * int(SAMPLE_RATE * AUDIO_SECONDS)


class FakeSynthesizeStream(tts.SynthesizeStream):
    """Answers instantly with a fixed block of silence, and records the text it got.

    ``buffer_seconds`` models what LiveKit Inference really does: tokens are collected
    into whole sentences and the metrics clock is only started immediately before the
    text goes to the provider. The gap between the first token arriving and that moment
    belongs to the language model, not to speech synthesis.
    """

    def __init__(self, *, fake_tts: FakeTTS, conn_options: APIConnectOptions) -> None:
        self._fake = fake_tts
        super().__init__(tts=fake_tts, conn_options=conn_options)

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        output_emitter.initialize(
            request_id=self._fake.request_id,
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
            mime_type="audio/pcm",
            stream=True,
        )
        output_emitter.start_segment(segment_id="fake-segment-1")

        async for data in self._input_ch:
            if isinstance(data, str):
                if not self._fake.pushed_text and self._fake.buffer_seconds:
                    # Sentence tokenisation: the provider has not been told anything yet.
                    await asyncio.sleep(self._fake.buffer_seconds)
                self._fake.pushed_text += data
                # A real plugin marks started when it hands text to the provider.
                self._mark_started()

        output_emitter.push(SILENCE)
        output_emitter.end_segment()


class FakeTTS(tts.TTS):
    """A streaming voice that returns silence immediately."""

    def __init__(self, *, request_id: str = "fake-tts-1", buffer_seconds: float = 0.0) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=True, aligned_transcript=False),
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
        )
        self.request_id = request_id
        self.buffer_seconds = buffer_seconds
        self.pushed_text = ""
        self.streams = 0
        self.closed = False
        self.prewarmed = False
        self.expressive: bool | None = None

    @property
    def model(self) -> str:
        return "fake/voice"

    @property
    def provider(self) -> str:
        return "fake"

    def _set_expressive(self, enabled: bool) -> None:
        super()._set_expressive(enabled)
        self.expressive = enabled

    def prewarm(self) -> None:
        self.prewarmed = True

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = CONN_OPTIONS
    ) -> tts.ChunkedStream:
        return self._synthesize_with_stream(text, conn_options=conn_options)

    def stream(self, *, conn_options: APIConnectOptions = CONN_OPTIONS) -> tts.SynthesizeStream:
        self.streams += 1
        return FakeSynthesizeStream(fake_tts=self, conn_options=conn_options)

    async def aclose(self) -> None:
        self.closed = True


async def _synthesize(stream: tts.SynthesizeStream, text: str = "Hello there") -> tuple[int, float]:
    """Drive one synthesis, returning the bytes of audio and the wall time to the first.

    The clock starts at ``push_text``, which is when the pipeline first has something
    to say — the same instant the SDK's own ttfb clock is anchored.
    """
    started = asyncio.get_running_loop().time()
    stream.push_text(text)
    stream.end_input()

    audio_bytes = 0
    ttfb: float | None = None
    async for audio in stream:
        if ttfb is None:
            ttfb = asyncio.get_running_loop().time() - started
        audio_bytes += len(audio.frame.data.tobytes())
    await stream.aclose()
    return audio_bytes, ttfb or 0.0


async def _metrics_for(delayed: DelayedTTS, **kwargs) -> object:
    """Run one synthesis and return the TTSMetrics the wrapper emitted for it."""
    collected: list[object] = []
    delayed.on("metrics_collected", collected.append)
    await _synthesize(delayed.stream(conn_options=CONN_OPTIONS), **kwargs)
    assert collected, "the wrapper must emit TTSMetrics like any other TTS"
    return collected[0]


# ------------------------------------------------------------------- identity


def test_delayed_tts_reports_the_wrapped_voices_identity() -> None:
    inner = FakeTTS()
    delayed = DelayedTTS(inner, ChaosController())

    assert delayed.model == "fake/voice"
    assert delayed.provider == "fake"
    assert delayed.sample_rate == inner.sample_rate
    assert delayed.num_channels == inner.num_channels
    assert delayed.capabilities.streaming is True


def test_capabilities_track_the_wrapped_voice() -> None:
    """The instance is shared, not copied: plugins mutate it in `update_options`."""
    inner = FakeTTS()
    delayed = DelayedTTS(inner, ChaosController())

    inner.capabilities.aligned_transcript = True

    assert delayed.capabilities.aligned_transcript is True


def test_markup_and_expressive_reach_the_wrapped_voice() -> None:
    inner = FakeTTS()
    delayed = DelayedTTS(inner, ChaosController())

    assert delayed.markup is inner.markup, "the default Markup would declare no dialect"

    delayed._set_expressive(True)
    assert inner.expressive is True


def test_prewarm_reaches_the_wrapped_voice() -> None:
    inner = FakeTTS()
    DelayedTTS(inner, ChaosController()).prewarm()
    assert inner.prewarmed is True


@pytest.mark.asyncio
async def test_aclose_closes_the_wrapped_voice() -> None:
    inner = FakeTTS()
    await DelayedTTS(inner, ChaosController()).aclose()
    assert inner.closed is True


# ----------------------------------------------------------------- passthrough


@pytest.mark.asyncio
async def test_passes_audio_and_text_through_when_chaos_is_off() -> None:
    inner = FakeTTS()
    delayed = DelayedTTS(inner, ChaosController())

    audio_bytes, ttfb = await _synthesize(delayed.stream(conn_options=CONN_OPTIONS))

    assert inner.streams == 1
    assert inner.pushed_text == "Hello there", "the wrapper must not swallow or alter text"
    assert audio_bytes == len(SILENCE), "every byte the voice produced must come out"
    assert ttfb < 0.1


@pytest.mark.asyncio
async def test_synthesize_routes_through_the_delayed_stream() -> None:
    """The non-streaming API is delayed too, so the injection cannot be sidestepped."""
    inner = FakeTTS()
    delayed = DelayedTTS(inner, ChaosController(tts_delay_ms=250))

    started = asyncio.get_running_loop().time()
    frame = await delayed.synthesize("Hello there", conn_options=CONN_OPTIONS).collect()
    elapsed = asyncio.get_running_loop().time() - started

    assert elapsed >= 0.25
    assert frame.samples_per_channel > 0


# ----------------------------------------------------------- injected latency


@pytest.mark.asyncio
async def test_injected_delay_lands_before_the_first_audio_byte() -> None:
    inner = FakeTTS()
    delayed = DelayedTTS(inner, ChaosController(tts_delay_ms=300))

    audio_bytes, ttfb = await _synthesize(delayed.stream(conn_options=CONN_OPTIONS))

    assert ttfb >= 0.3, "the sleep must precede the first frame, not run alongside it"
    assert audio_bytes == len(SILENCE), "delaying speech must not truncate it"


@pytest.mark.asyncio
async def test_the_delay_is_measured_as_time_to_first_byte() -> None:
    """The SDK's own metrics — what the cockpit renders — must show the degradation.

    This is the assertion the whole wrapper exists for. ``ttfb`` is measured from
    ``_mark_started()`` to the first audio frame, so a wrapper that slept *before*
    marking started would sleep honestly and still report a fast synthesis.
    """
    delayed = DelayedTTS(FakeTTS(), ChaosController(tts_delay_ms=300))

    metrics = await _metrics_for(delayed)

    assert metrics.ttfb >= 0.3
    assert metrics.duration >= 0.3
    assert metrics.audio_duration == pytest.approx(AUDIO_SECONDS, abs=0.02)
    assert metrics.characters_count == len("Hello there")


@pytest.mark.asyncio
async def test_an_undelayed_synthesis_measures_fast() -> None:
    metrics = await _metrics_for(DelayedTTS(FakeTTS(), ChaosController()))
    assert metrics.ttfb < 0.1


@pytest.mark.asyncio
async def test_the_delay_is_changeable_between_syntheses() -> None:
    """The browser can retune chaos mid-call without restarting the session."""
    inner = FakeTTS()
    chaos = ChaosController()
    delayed = DelayedTTS(inner, chaos)

    _, fast = await _synthesize(delayed.stream(conn_options=CONN_OPTIONS))
    chaos.set_tts_delay_ms(250)
    _, slow = await _synthesize(delayed.stream(conn_options=CONN_OPTIONS))
    chaos.set_tts_delay_ms(0)
    _, fast_again = await _synthesize(delayed.stream(conn_options=CONN_OPTIONS))

    assert fast < 0.1
    assert slow >= 0.25
    assert fast_again < 0.1
    assert inner.streams == 3


@pytest.mark.asyncio
async def test_the_delay_does_not_start_until_there_is_something_to_say() -> None:
    """A stream is opened when the turn starts; text arrives only as the LLM writes it.

    Sleeping at construction would bill the model's thinking time to synthesis and
    inflate ttfb on every turn, chaos or not.
    """
    delayed = DelayedTTS(FakeTTS(), ChaosController(tts_delay_ms=300))
    stream = delayed.stream(conn_options=CONN_OPTIONS)

    # The pipeline is still waiting on the LLM here; nothing has been pushed.
    await asyncio.sleep(0.35)

    started = asyncio.get_running_loop().time()
    _, _ = await _synthesize(stream)
    elapsed = asyncio.get_running_loop().time() - started

    assert elapsed >= 0.3, "the delay must start at the first token, not at construction"


# ------------------------------------------------------------------ attribution


@pytest.mark.asyncio
async def test_applied_delay_is_logged_against_the_syntheses_request_id() -> None:
    chaos = ChaosController(tts_delay_ms=120)
    delayed = DelayedTTS(FakeTTS(), chaos)

    metrics = await _metrics_for(delayed)

    applied = chaos.tts_applied.take(metrics.request_id)
    assert applied.delay == pytest.approx(0.12, abs=0.001)
    assert applied.degraded is True


@pytest.mark.asyncio
async def test_an_undelayed_synthesis_is_still_recorded() -> None:
    """A clean record per synthesis keeps the log's FIFO fallback in step."""
    chaos = ChaosController()
    delayed = DelayedTTS(FakeTTS(), chaos)

    metrics = await _metrics_for(delayed)

    applied = chaos.tts_applied.take(metrics.request_id)
    assert applied.delay == pytest.approx(0.0)
    assert applied.degraded is False


@pytest.mark.asyncio
async def test_a_synthesis_with_no_text_records_nothing() -> None:
    """No text means no synthesis and no metric, so a record would desynchronise the log."""
    chaos = ChaosController(tts_delay_ms=300)
    delayed = DelayedTTS(FakeTTS(), chaos)

    stream = delayed.stream(conn_options=CONN_OPTIONS)
    stream.end_input()  # the turn was interrupted before a single token arrived
    async for _ in stream:
        pass
    await stream.aclose()

    assert chaos.tts_applied.take().degraded is False


@pytest.mark.asyncio
async def test_a_tts_delay_degrades_the_turn_end_to_end() -> None:
    """SDK metrics in, cockpit envelope out: a slowed voice paints the turn red."""
    chaos = ChaosController(tts_delay_ms=250)
    store = TurnStore(
        models=PipelineModels(stt="deepgram/nova-3", llm="openai/gpt-4.1-mini", tts="fake/voice"),
        applied_tts_chaos=chaos.tts_applied.take,
    )
    delayed = DelayedTTS(FakeTTS(), chaos)

    metrics = await _metrics_for(delayed)

    store.record_eou("t1", end_of_utterance_delay=0.4, transcription_delay=0.1)
    store.record_llm("t1", ttft=0.3, duration=1.0, prompt_tokens=10, completion_tokens=5)
    env = store.record_tts(
        "t1",
        ttfb=metrics.ttfb,
        duration=metrics.duration,
        audio_duration=metrics.audio_duration,
        characters_count=metrics.characters_count,
        request_id=metrics.request_id,
    )

    assert env["payload"]["degraded"] is True
    assert store.get("t1").degraded is True
    # The injected quarter-second is inside the reported critical path, not beside it.
    assert env["payload"]["total_response_latency"] >= 0.4 + 0.3 + 0.25


# --------------------------------------------------- the anchor the ttfb is measured from


async def _unwrapped_ttfb(inner: FakeTTS) -> float:
    """What the voice reports for itself, with no wrapper in the way."""
    collected: list[object] = []
    inner.on("metrics_collected", collected.append)
    await _synthesize(inner.stream(conn_options=CONN_OPTIONS))
    return collected[0].ttfb


@pytest.mark.asyncio
async def test_wrapping_does_not_inflate_ttfb_when_chaos_is_off() -> None:
    """Regression, and the reason the wrapper adopts the provider's own anchor.

    LiveKit Inference buffers tokens into whole sentences and starts its metrics clock
    only just before it sends them. A wrapper that called `_mark_started()` when the
    first token reached *it* would charge that tokenizer wait — here 300 ms, in a real
    call however long the model takes to finish a sentence — to speech synthesis on
    every single turn, chaos or no chaos. The waterfall would show a slow voice that
    was never slow.
    """
    baseline = await _unwrapped_ttfb(FakeTTS(buffer_seconds=0.3))

    delayed = DelayedTTS(FakeTTS(buffer_seconds=0.3), ChaosController())
    metrics = await _metrics_for(delayed)

    assert baseline < 0.1, "the voice itself does not count its own buffering"
    assert metrics.ttfb < 0.1, "and neither may the wrapper"
    assert metrics.ttfb == pytest.approx(baseline, abs=0.05)


@pytest.mark.asyncio
async def test_a_buffering_voice_still_reports_the_injected_delay_on_top() -> None:
    """The delay is added to the provider's real ttfb, not to our view of it."""
    delayed = DelayedTTS(FakeTTS(buffer_seconds=0.3), ChaosController(tts_delay_ms=250))

    metrics = await _metrics_for(delayed)

    assert metrics.ttfb >= 0.25, "the injected quarter-second must be in there"
    assert metrics.ttfb < 0.45, "but the 300 ms of tokenisation must not be"


# ------------------------------------------------------ attribution under failure


class FailingTTS(FakeTTS):
    """A voice that accepts text and then dies without ever making a sound."""

    def stream(self, *, conn_options: APIConnectOptions = CONN_OPTIONS) -> tts.SynthesizeStream:
        self.streams += 1
        return FailingSynthesizeStream(fake_tts=self, conn_options=conn_options)


class FailingSynthesizeStream(FakeSynthesizeStream):
    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        output_emitter.initialize(
            request_id=self._fake.request_id,
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
            mime_type="audio/pcm",
            stream=True,
        )
        async for data in self._input_ch:
            if isinstance(data, str):
                raise APIConnectionError("the voice went away")


@pytest.mark.asyncio
async def test_a_synthesis_that_never_made_a_sound_records_nothing() -> None:
    """The record is filed on the first frame, so a failure before audio leaves none.

    A record filed when the sleep ended would outlive the synthesis that earned it and
    be handed to the next turn by the FIFO fallback, painting a clean turn degraded.
    """
    chaos = ChaosController(tts_delay_ms=200)
    delayed = DelayedTTS(FailingTTS(), chaos)

    stream = delayed.stream(conn_options=CONN_OPTIONS)
    stream.push_text("Hello there")
    stream.end_input()
    with pytest.raises(APIError):
        async for _ in stream:
            pass
    await stream.aclose()

    assert chaos.tts_applied.take().degraded is False, "nothing may be left for the next turn"

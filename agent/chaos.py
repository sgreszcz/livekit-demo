"""Chaos mode: runtime-adjustable degradation injected into the live pipeline.

The point of the demo is that the cockpit shows *real* degradation, not a fake number.
Every injection here happens inside the stream the SDK is already timing, so it lands in
the metrics the cockpit renders and every downstream stage shifts with it, exactly as a
slow region or an overloaded provider would look.

Four injections, all driven from the browser over the ``cockpit-control`` topic:

* ``llm_delay_ms`` — :class:`DelayedLLM` sleeps before opening the upstream completion,
  inside its own :class:`~livekit.agents.llm.LLMStream`, so the delay is measured as
  time-to-first-token.
* ``tts_delay_ms`` — :class:`DelayedTTS` sleeps after the first text token reaches the
  stream and before it is handed to the provider, then anchors the SDK's ttfb clock on
  the provider's own start instant less that sleep, so the delay is measured as
  time-to-first-byte without the tokenizer's wait being measured along with it.
* ``slow_model`` — :class:`DelayedLLM` holds two wrapped models and picks per
  invocation. No ``update_options`` churn, no session restart: the choice is frozen
  when ``chat()`` is called, so a toggle mid-turn cannot rewrite an invocation already
  in flight.
* ``max_completion_tokens`` — clamped per invocation through the ``extra_kwargs`` the
  wrapper already forwards, which LiveKit Inference merges into the arguments it splats
  onto the provider's ``chat.completions.create``. Answers cut off mid-thought; that IS
  the demo.

The state lives in a :class:`ChaosController` shared with the control-channel handler.
What was *actually* applied is recorded per invocation in an :class:`AppliedChaosLog`,
so :class:`~telemetry.TurnStore` can mark a turn degraded on the evidence of its own
invocations rather than on where the toggle happens to be sitting when a metric lands.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import random
from collections import deque
from collections.abc import Callable, Sequence
from typing import Any, Literal

from livekit.agents import (
    DEFAULT_API_CONNECT_OPTIONS,
    NOT_GIVEN,
    APIConnectOptions,
    APIError,
    NotGivenOr,
    llm,
    tts,
    utils,
)
from livekit.agents.types import USERDATA_TIMED_TRANSCRIPT
from livekit.agents.utils import aio, is_given

from telemetry import AppliedChaos

__all__ = [
    "APPLIED_CHAOS_HISTORY",
    "DEFAULT_SLOW_LLM_MODEL",
    "MAX_COMPLETION_TOKENS",
    "MAX_DELAY_MS",
    "MIN_COMPLETION_TOKENS",
    "VOICE_INJECTIONS",
    "AppliedChaosLog",
    "ChaosCommand",
    "ChaosController",
    "ChaosIntensity",
    "DelayedLLM",
    "DelayedTTS",
    "VoiceChaosPlan",
    "VoiceInjection",
    "parse_control_message",
    "plan_voice_chaos",
]

logger = logging.getLogger("glass-cockpit.chaos")

# Guard rail: the browser can ask for anything, but a demo that hangs for a minute
# is not a demo.
MAX_DELAY_MS = 10_000

# A clamp of 0 would produce no answer at all, which reads as a broken agent rather
# than a starved one; the upper bound is past any answer this agent gives, so setting
# it is indistinguishable from off.
MIN_COMPLETION_TOKENS = 1
MAX_COMPLETION_TOKENS = 4096

# Deliberately heavier than the default `openai/gpt-4.1-mini`: same provider and same
# API shape, several times the latency. Overridable via COCKPIT_SLOW_LLM_MODEL, which
# agent.py reads (after load_dotenv) and passes in.
DEFAULT_SLOW_LLM_MODEL = "openai/gpt-4.1"

# Applied records are consumed within a turn or two of being recorded; the cap only
# stops a leak if some invocation never reports metrics.
APPLIED_CHAOS_HISTORY = 32


class AppliedChaosLog:
    """What chaos *actually* injected, per invocation, so turns can be attributed.

    The toggle can move mid-turn, so asking it "are you on?" when a metric arrives
    answers the wrong question — a turn is degraded if chaos was applied to one of its
    own invocations. The injectors record one entry per invocation and
    :class:`~telemetry.TurnStore` consumes one per metric.

    Entries are matched on the provider's request id, which the metric carries too. The
    FIFO fallback covers a provider that returns no id: LLM completions and TTS segments
    in a voice pipeline start and finish one at a time, so the oldest unclaimed entry is
    the right one.
    """

    def __init__(self, capacity: int = APPLIED_CHAOS_HISTORY) -> None:
        self._entries: deque[tuple[str, AppliedChaos]] = deque(maxlen=capacity)

    def record(self, applied: AppliedChaos, *, request_id: str = "") -> None:
        self._entries.append((request_id, applied))

    def take(self, request_id: str | None = None) -> AppliedChaos:
        """Claim what was applied to ``request_id``; a clean record if nothing was."""
        if request_id:
            for index, (recorded_id, applied) in enumerate(self._entries):
                if recorded_id == request_id:
                    del self._entries[index]
                    return applied
        if not self._entries:
            return AppliedChaos()
        return self._entries.popleft()[1]

    def discard(self, request_id: str) -> None:
        """Drop a record whose invocation died before it could report metrics.

        The SDK suppresses metrics for a stream that failed, so the entry would never
        be claimed by its own metric — and the FIFO fallback would eventually hand it
        to an unrelated invocation, reporting a later turn as degraded on the strength
        of an earlier turn's chaos. Withdrawing it keeps the queues in step.
        """
        for index, (recorded_id, _) in enumerate(self._entries):
            if recorded_id == request_id:
                del self._entries[index]
                return


@dataclasses.dataclass(frozen=True)
class ChaosCommand:
    """A validated chaos request from the browser.

    Every field is optional and a missing one means *unchanged*, so ``NOT_GIVEN`` is
    the default rather than a zero value — the schema distinguishes "don't touch the
    token clamp" from ``"max_completion_tokens": null``, which turns it off. Values
    that survive parsing are already in range; :class:`ChaosController` clamps again
    because it is also constructed directly, from code the browser never touches.
    """

    llm_delay_ms: NotGivenOr[int] = NOT_GIVEN
    tts_delay_ms: NotGivenOr[int] = NOT_GIVEN
    slow_model: NotGivenOr[bool] = NOT_GIVEN
    max_completion_tokens: NotGivenOr[int | None] = NOT_GIVEN

    @property
    def is_empty(self) -> bool:
        """True if the command asks for nothing at all."""
        return not any(is_given(getattr(self, field.name)) for field in dataclasses.fields(self))


class ChaosController:
    """Mutable, shared injection state for the call."""

    def __init__(
        self,
        llm_delay_ms: int = 0,
        *,
        tts_delay_ms: int = 0,
        slow_model: bool = False,
        max_completion_tokens: int | None = None,
    ) -> None:
        self._llm_delay_ms = 0
        self._tts_delay_ms = 0
        self._slow_model = False
        self._max_completion_tokens: int | None = None
        # One log per stage: an LLM metric must never claim a TTS record, and the FIFO
        # fallback only holds if each queue describes a single kind of invocation.
        self.llm_applied = AppliedChaosLog()
        self.tts_applied = AppliedChaosLog()

        self.set_llm_delay_ms(llm_delay_ms)
        self.set_tts_delay_ms(tts_delay_ms)
        self.set_slow_model(slow_model)
        self.set_max_completion_tokens(max_completion_tokens)

    # ------------------------------------------------------------------ accessors

    @property
    def llm_delay_ms(self) -> int:
        return self._llm_delay_ms

    @property
    def llm_delay_seconds(self) -> float:
        return self._llm_delay_ms / 1000.0

    @property
    def tts_delay_ms(self) -> int:
        return self._tts_delay_ms

    @property
    def tts_delay_seconds(self) -> float:
        return self._tts_delay_ms / 1000.0

    @property
    def slow_model(self) -> bool:
        return self._slow_model

    @property
    def max_completion_tokens(self) -> int | None:
        return self._max_completion_tokens

    @property
    def active(self) -> bool:
        """True if any injection is enabled — what the cockpit lights up on."""
        return (
            self._llm_delay_ms > 0
            or self._tts_delay_ms > 0
            or self._slow_model
            or self._max_completion_tokens is not None
        )

    # -------------------------------------------------------------------- setters

    def set_llm_delay_ms(self, delay_ms: int) -> None:
        self._llm_delay_ms = _clamp_delay(delay_ms)

    def set_tts_delay_ms(self, delay_ms: int) -> None:
        self._tts_delay_ms = _clamp_delay(delay_ms)

    def set_slow_model(self, enabled: bool) -> None:
        self._slow_model = bool(enabled)

    def set_max_completion_tokens(self, max_tokens: int | None) -> None:
        self._max_completion_tokens = None if max_tokens is None else _clamp_tokens(max_tokens)

    def apply(self, command: ChaosCommand) -> None:
        """Apply the fields the browser actually sent, leaving the rest alone."""
        if is_given(command.llm_delay_ms):
            self.set_llm_delay_ms(command.llm_delay_ms)
        if is_given(command.tts_delay_ms):
            self.set_tts_delay_ms(command.tts_delay_ms)
        if is_given(command.slow_model):
            self.set_slow_model(command.slow_model)
        if is_given(command.max_completion_tokens):
            self.set_max_completion_tokens(command.max_completion_tokens)

    def envelope_payload(self) -> dict[str, Any]:
        """The full v1.3 ack: every field of the current state, not just what changed."""
        return {
            "llm_delay_ms": self._llm_delay_ms,
            "tts_delay_ms": self._tts_delay_ms,
            "slow_model": self._slow_model,
            "max_completion_tokens": self._max_completion_tokens,
            "active": self.active,
        }


def _clamp_delay(delay_ms: Any) -> int:
    return max(0, min(int(delay_ms), MAX_DELAY_MS))


def _clamp_tokens(max_tokens: Any) -> int:
    return max(MIN_COMPLETION_TOKENS, min(int(max_tokens), MAX_COMPLETION_TOKENS))


# ------------------------------------------------------------------ control channel


def _parse_delay(value: Any, field: str) -> NotGivenOr[int]:
    """A delay must be a finite, non-boolean number; it is then clamped into range."""
    # bool is an int subclass, and JSON's `true` is not a duration.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        logger.warning("chaos command carried a non-numeric %s: %r", field, value)
        return NOT_GIVEN
    try:
        # NaN raises ValueError, ±inf raises OverflowError; huge ints survive and clamp.
        return _clamp_delay(value)
    except (ValueError, OverflowError):
        logger.warning("chaos command carried a non-finite %s: %r", field, value)
        return NOT_GIVEN


def _parse_flag(value: Any, field: str) -> NotGivenOr[bool]:
    """Strict: 1, "true" and "yes" are not booleans, and guessing would be worse."""
    if not isinstance(value, bool):
        logger.warning("chaos command carried a non-boolean %s: %r", field, value)
        return NOT_GIVEN
    return value


def _parse_tokens(value: Any, field: str) -> NotGivenOr[int | None]:
    """``null`` explicitly turns the clamp off; anything else must be a finite number.

    ``NOT_GIVEN`` here means *rejected*, which is why it can be told apart from the
    perfectly valid ``None`` this returns for ``null``.
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        logger.warning("chaos command carried a non-numeric %s: %r", field, value)
        return NOT_GIVEN
    try:
        return _clamp_tokens(value)
    except (ValueError, OverflowError):
        logger.warning("chaos command carried a non-finite %s: %r", field, value)
        return NOT_GIVEN


def parse_control_message(data: bytes) -> ChaosCommand | None:
    """Parse a ``cockpit-control`` packet into a validated :class:`ChaosCommand`.

    The packet comes straight off a public data channel, so nothing about its shape is
    trusted: no input raises, and anything that isn't a well-formed chaos command
    returns ``None``.

    Validation is *per field*. A garbage ``slow_model`` is dropped with a warning and
    the rest of the command still applies — discarding a valid ``llm_delay_ms`` because
    some other field was malformed would make one bad control widget disable the whole
    panel. A command left with nothing valid in it (including a well-formed but empty
    payload) returns ``None``, so junk and no-ops never generate an ack.
    """
    try:
        message = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        logger.warning("control packet was not valid JSON")
        return None

    if not isinstance(message, dict) or message.get("type") != "chaos":
        return None

    payload = message.get("payload")
    if not isinstance(payload, dict):
        logger.warning("chaos command had a non-object payload: %r", payload)
        return None

    def field(name: str, parse: Any) -> Any:
        return parse(payload[name], name) if name in payload else NOT_GIVEN

    command = ChaosCommand(
        llm_delay_ms=field("llm_delay_ms", _parse_delay),
        tts_delay_ms=field("tts_delay_ms", _parse_delay),
        slow_model=field("slow_model", _parse_flag),
        max_completion_tokens=field("max_completion_tokens", _parse_tokens),
    )
    return None if command.is_empty else command


# -------------------------------------------------------------------- voice control

# The second way to reach the same controller: the caller asks out loud and the model
# calls `GlassCockpitAgent.set_chaos`. A caller on a SIP trunk has no dashboard at all,
# so without this the demo's best moment is unreachable from a phone.
#
# The vocabulary is deliberately not the wire schema. The control channel takes four
# independent numeric knobs because a browser panel has four widgets; a language model
# choosing between four numbers and their units gets them wrong. What it is reliable at
# is picking one value from a short enum, so that is all this asks of it — the numbers
# live here, where they can be tuned and tested.

VoiceInjection = Literal[
    "latency", "voice_delay", "slow_model", "token_starvation", "random", "off"
]
ChaosIntensity = Literal["mild", "severe"]

#: The concrete injections, and the set ``random`` picks from.
VOICE_INJECTIONS: tuple[str, ...] = ("latency", "voice_delay", "slow_model", "token_starvation")

# Tuned to be *audible*, not merely measurable. A caller who asked for this over a phone
# has no waterfall in front of them, so a degradation they cannot hear is a degradation
# that did not happen — every value here is above the threshold where a listener says
# "that got worse" unprompted.
_LLM_DELAY_MS: dict[str, int] = {"mild": 800, "severe": 1500}
_TTS_DELAY_MS: dict[str, int] = {"mild": 300, "severe": 600}
_MAX_TOKENS: dict[str, int] = {"mild": 30, "severe": 15}

# Every plan sets all four fields, so a spoken request always defines the WHOLE state
# rather than layering onto whatever is already armed. Two reasons. The model cannot see
# the current state, so an additive tool would let a caller who asked for three things
# in a row end up somewhere none of them describe — and stacking severe latency, the
# heavy model and a fifteen-token clamp makes the agent too broken to ask it to stop.
# The ack carries the full state, so the browser panel follows the change either way.
_OFF = ChaosCommand(llm_delay_ms=0, tts_delay_ms=0, slow_model=False, max_completion_tokens=None)

# What the model says back. Written to be SPOKEN: numbers expanded into words, the
# injection named in terms a listener understands rather than a field name, and always
# the two things the persona must not be left to improvise — that the change lands on
# this very answer, and that the dashboard will flag the turn.
_SPOKEN: dict[tuple[str, str], str] = {
    ("latency", "mild"): (
        "I've put eight hundred milliseconds of artificial latency in front of my language "
        "model. You'll hear it on this very answer, and the dashboard will flag this turn "
        "as degraded."
    ),
    ("latency", "severe"): (
        "I've put a second and a half of artificial latency in front of my language model. "
        "You'll hear it on this very answer, and the dashboard will flag this turn as "
        "degraded."
    ),
    ("voice_delay", "mild"): (
        "I've put three hundred milliseconds of artificial delay in front of my speech "
        "synthesis. You'll hear the extra pause before I start talking, and the dashboard "
        "will flag this turn as degraded."
    ),
    ("voice_delay", "severe"): (
        "I've put six hundred milliseconds of artificial delay in front of my speech "
        "synthesis. You'll hear the extra pause before I start talking, and the dashboard "
        "will flag this turn as degraded."
    ),
    # One switch, no intensity: there is a heavier model or there isn't.
    ("slow_model", "mild"): (
        "I've swapped myself onto a deliberately heavier language model. It takes noticeably "
        "longer to think, and the dashboard will flag this turn as degraded."
    ),
    ("token_starvation", "mild"): (
        "I've clamped myself to thirty tokens per answer. I'm going to get cut off "
        "mid-sentence — that's the point, not a fault — and the dashboard will flag this "
        "turn as degraded."
    ),
    ("token_starvation", "severe"): (
        "I've clamped myself to fifteen tokens per answer. I'm going to get cut off "
        "mid-sentence — that's the point, not a fault — and the dashboard will flag this "
        "turn as degraded."
    ),
    ("off", "mild"): (
        "Chaos is off. No artificial latency, no heavier model, no token clamp — I'm back "
        "to normal, and the dashboard will stop flagging turns as degraded."
    ),
}
_SPOKEN[("slow_model", "severe")] = _SPOKEN[("slow_model", "mild")]
_SPOKEN[("off", "severe")] = _SPOKEN[("off", "mild")]

_RANDOM_PREFIX = "I picked one at random. "


@dataclasses.dataclass(frozen=True)
class VoiceChaosPlan:
    """A spoken chaos request, resolved into what to apply and what to say."""

    injection: str
    """The CONCRETE injection — never ``"random"``, which is resolved here."""
    intensity: str
    command: ChaosCommand
    """Full state: every field is given, so applying it defines all four knobs."""
    spoken: str
    """The confirmation, ready to be read aloud. Never JSON, never bare numbers."""
    chosen_at_random: bool = False


def plan_voice_chaos(
    injection: str,
    intensity: str = "mild",
    *,
    chooser: Callable[[Sequence[str]], str] = random.choice,
) -> VoiceChaosPlan:
    """Resolve a spoken chaos request. Pure: no controller, no publisher, no SDK.

    ``chooser`` is the seam that makes ``"random"`` testable — it defaults to
    :func:`random.choice` and is injected in tests, so nothing here needs a seeded
    global RNG that a parallel test could disturb.

    Raises ``ValueError`` for an injection outside the enum. That cannot arrive through
    the tool — the SDK validates the argument against the ``Literal`` before the tool
    body runs, and hands the model a ``ToolError`` to self-correct from — so this is the
    belt for a direct caller. Guessing would be worse than refusing: the nearest guess
    to an unrecognised word is ``"off"``, which would silently disarm a caller's chaos.
    """
    level = intensity if intensity in ("mild", "severe") else "mild"
    at_random = injection == "random"
    chosen = chooser(VOICE_INJECTIONS) if at_random else injection
    if chosen not in VOICE_INJECTIONS and chosen != "off":
        raise ValueError(f"unknown chaos injection: {injection!r}")

    if chosen == "latency":
        command = dataclasses.replace(_OFF, llm_delay_ms=_LLM_DELAY_MS[level])
    elif chosen == "voice_delay":
        command = dataclasses.replace(_OFF, tts_delay_ms=_TTS_DELAY_MS[level])
    elif chosen == "slow_model":
        command = dataclasses.replace(_OFF, slow_model=True)
    elif chosen == "token_starvation":
        command = dataclasses.replace(_OFF, max_completion_tokens=_MAX_TOKENS[level])
    else:
        command = _OFF

    spoken = _SPOKEN[(chosen, level)]
    return VoiceChaosPlan(
        injection=chosen,
        intensity=level,
        command=command,
        spoken=_RANDOM_PREFIX + spoken if at_random else spoken,
        chosen_at_random=at_random,
    )


# --------------------------------------------------------------------------- LLM


class DelayedLLM(llm.LLM):
    """Wraps an LLM so each completion can be delayed, slowed and starved.

    ``slow`` is a second, deliberately heavier model constructed up front. Choosing
    between the two per invocation costs nothing at call time and keeps both providers
    warm, where ``Agent.update_options`` would mutate shared session state mid-call and
    leave in-flight speech reporting a model it did not use.
    """

    def __init__(
        self, wrapped: llm.LLM, chaos: ChaosController, *, slow: llm.LLM | None = None
    ) -> None:
        super().__init__()
        self._wrapped = wrapped
        self._slow = slow
        self._chaos = chaos

    @property
    def model(self) -> str:
        """The configured default, which is what ``call_meta`` describes.

        Deliberately not the slow model even while it is selected: this is the
        pipeline's identity, and what any individual turn *ran* is reported per
        invocation in that turn's ``llm.model``.
        """
        return self._wrapped.model

    @property
    def provider(self) -> str:
        return self._wrapped.provider

    def prewarm(self, *, loop: asyncio.AbstractEventLoop | None = None) -> None:
        """Warm both models' connections, not the wrapper's (it has none).

        ``LLM.prewarm`` no-ops unless the class overrides ``_prewarm_impl``, so a
        wrapper that inherits it silently swallows the session's prewarm call and
        neither inner client resolves DNS or opens TLS ahead of the first reply — the
        exact cost the demo's first turn is measured on. Delegating instead of
        implementing ``_prewarm_impl`` lets each inner keep its own idempotent task.
        """
        self._wrapped.prewarm(loop=loop)
        if self._slow is not None:
            # The slow model is warmed too: a chaos swap mid-call must show the
            # model's own latency, not a cold connection's.
            self._slow.prewarm(loop=loop)

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: NotGivenOr[bool] = NOT_GIVEN,
        tool_choice: NotGivenOr[llm.ToolChoice] = NOT_GIVEN,
        extra_kwargs: NotGivenOr[dict[str, Any]] = NOT_GIVEN,
    ) -> llm.LLMStream:
        # Every chaos decision is frozen here, at the top of the invocation, and the
        # stream is handed the result rather than the live toggle. A visitor moving a
        # slider while this completion streams must not be able to rewrite what it did:
        # the record the turn store later claims has to describe the request that was
        # actually sent. All four decisions are read at this one point so none of them
        # can disagree about which invocation they belong to.
        use_slow = self._chaos.slow_model and self._slow is not None
        target = self._slow if use_slow else self._wrapped
        assert target is not None
        max_tokens = self._chaos.max_completion_tokens
        delay = self._chaos.llm_delay_seconds

        extra: dict[str, Any] = dict(extra_kwargs) if is_given(extra_kwargs) else {}
        if max_tokens is not None:
            # max_completion_tokens is a declared member of LiveKit Inference's
            # ChatCompletionOptions and reaches the provider's chat.completions.create.
            # Not *verbatim*, though: inference.LLM.chat applies per-call extras first
            # and then overwrites them with the ones its constructor was given, so a
            # wrapped model built with a persistent max_completion_tokens would win
            # over this clamp while telemetry still reported the clamp as applied.
            # agent.py constructs both models without constructor extras, which is what
            # keeps that from happening.
            extra["max_completion_tokens"] = max_tokens

        return _DelayedLLMStream(
            self,
            wrapped=target,
            chaos=self._chaos,
            applied=AppliedChaos(
                delay=delay,
                model=target.model,
                slow_model=use_slow,
                max_completion_tokens=max_tokens,
            ),
            chat_ctx=chat_ctx,
            tools=tools or [],
            # Retries stay with the inner stream, which owns the upstream request;
            # retrying at both layers would multiply the attempts.
            conn_options=dataclasses.replace(conn_options, max_retry=0),
            inner_conn_options=conn_options,
            chat_kwargs={
                "parallel_tool_calls": parallel_tool_calls,
                "tool_choice": tool_choice,
                "extra_kwargs": extra if extra else NOT_GIVEN,
            },
        )

    async def aclose(self) -> None:
        # super() first: the base class documents that an override must call it, so an
        # in-flight prewarm task is cancelled rather than left running past shutdown.
        await super().aclose()
        await self._wrapped.aclose()
        if self._slow is not None:
            await self._slow.aclose()


class _DelayedLLMStream(llm.LLMStream):
    """Sleeps, then proxies the wrapped model's chunks.

    The base class starts its metrics clock when the stream is constructed, so the
    sleep is measured as part of time-to-first-token — which is the whole point. What
    was applied is logged against the request id the first chunk carries, so the turn
    store can tell a genuinely degraded turn from one that merely overlapped a toggle.
    The base class only reports metrics for a stream that produced a chunk, so logging
    on the first chunk keeps one entry per metric.
    """

    def __init__(
        self,
        delayed_llm: DelayedLLM,
        *,
        wrapped: llm.LLM,
        chaos: ChaosController,
        applied: AppliedChaos,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        conn_options: APIConnectOptions,
        inner_conn_options: APIConnectOptions,
        chat_kwargs: dict[str, Any],
    ) -> None:
        self._wrapped = wrapped
        self._chaos = chaos
        self._applied = applied
        self._inner_conn_options = inner_conn_options
        self._chat_kwargs = chat_kwargs
        super().__init__(delayed_llm, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)

    async def _run(self) -> None:
        # The delay was decided in chat(), not read here: this task is scheduled some
        # time after the stream was constructed, and the toggle can move in between.
        delay = self._applied.delay
        if delay > 0:
            logger.info("chaos: delaying completion by %d ms", round(delay * 1000))
            await asyncio.sleep(delay)

        stream = self._wrapped.chat(
            chat_ctx=self._chat_ctx,
            tools=self._tools,
            conn_options=self._inner_conn_options,
            **self._chat_kwargs,
        )
        recorded_id: str | None = None
        try:
            async for chunk in stream:
                if recorded_id is None:
                    recorded_id = chunk.id or ""
                    self._chaos.llm_applied.record(self._applied, request_id=recorded_id)
                self._event_ch.send_nowait(chunk)
        except APIError:
            # The only way a completion that produced chunks reports no metrics: the
            # base class flags the attempt as errored and the monitor returns early.
            # Cancellation is deliberately not caught — a cancelled stream that got as
            # far as a chunk still reports metrics, so its record is still claimed.
            if recorded_id is not None:
                self._chaos.llm_applied.discard(recorded_id)
            raise
        finally:
            await stream.aclose()


# --------------------------------------------------------------------------- TTS


class DelayedTTS(tts.TTS):
    """Wraps a TTS so each synthesis can be delayed inside the measured ttfb window.

    The LLM wrapper only has to sleep before opening a request. Speech synthesis is
    driven by a text channel the pipeline pushes into, so this wrapper is a real
    :class:`~livekit.agents.tts.SynthesizeStream`: it owns the SDK's metrics clock,
    forwards text into an inner stream, and re-emits the inner stream's audio through
    its own :class:`~livekit.agents.tts.AudioEmitter`. That is the same shape the SDK's
    own ``FallbackAdapter`` uses to front one TTS with another.

    Owning the outer stream is what makes the delay honest: metrics are emitted on this
    object, which is the one the session subscribes to, and the ttfb anchor is taken
    from the inner provider's own start instant less the delay injected in front of it
    (see ``_anchor_started_time``). The inner stream's own metrics go nowhere, exactly
    as with :class:`DelayedLLM`.

    One caveat, verified against livekit-agents 1.6.8: expressive TTS markup is gated on
    ``isinstance(activity.tts, inference.TTS)`` in ``agent_activity.py``, so a wrapper
    cannot pass it. It costs nothing here — ``AgentSession._expressive`` defaults to
    ``False`` and this agent never enables it — but enabling expressive later means
    unwrapping, not just flipping the flag.
    """

    def __init__(self, wrapped: tts.TTS, chaos: ChaosController) -> None:
        super().__init__(
            # The instance, not a copy: `update_options` mutates aligned_transcript on
            # it, and the pipeline reads capabilities off the wrapper.
            capabilities=wrapped.capabilities,
            sample_rate=wrapped.sample_rate,
            num_channels=wrapped.num_channels,
        )
        self._wrapped = wrapped
        self._chaos = chaos

    @property
    def model(self) -> str:
        return self._wrapped.model

    @property
    def provider(self) -> str:
        return self._wrapped.provider

    @property
    def markup(self) -> tts.TTS.Markup:
        """Delegate the markup dialect; the default would silently declare none."""
        return self._wrapped.markup

    def _set_expressive(self, enabled: bool) -> None:
        super()._set_expressive(enabled)
        self._wrapped._set_expressive(enabled)

    def prewarm(self) -> None:
        self._wrapped.prewarm()

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> tts.ChunkedStream:
        # Routed through the streaming path so the delay applies identically however
        # the caller asks for audio.
        return self._synthesize_with_stream(text, conn_options=conn_options)

    def stream(
        self, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> tts.SynthesizeStream:
        return _DelayedSynthesizeStream(
            self,
            wrapped=self._wrapped,
            chaos=self._chaos,
            # Retries stay with the inner stream, which owns the upstream request.
            conn_options=dataclasses.replace(conn_options, max_retry=0),
            inner_conn_options=conn_options,
        )

    async def aclose(self) -> None:
        await self._wrapped.aclose()


class _DelayedSynthesizeStream(tts.SynthesizeStream):
    """Holds the first text token back, then proxies the wrapped voice's audio."""

    def __init__(
        self,
        delayed_tts: DelayedTTS,
        *,
        wrapped: tts.TTS,
        chaos: ChaosController,
        conn_options: APIConnectOptions,
        inner_conn_options: APIConnectOptions,
    ) -> None:
        self._wrapped = wrapped
        self._chaos = chaos
        self._inner_conn_options = inner_conn_options
        super().__init__(tts=delayed_tts, conn_options=conn_options)

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        request_id = utils.shortuuid()
        output_emitter.initialize(
            request_id=request_id,
            sample_rate=self._wrapped.sample_rate,
            num_channels=self._wrapped.num_channels,
            mime_type="audio/pcm",
            stream=True,
        )
        output_emitter.start_segment(segment_id=utils.shortuuid())

        inner = self._wrapped.stream(conn_options=self._inner_conn_options)
        injected = 0.0

        async def _forward_input() -> None:
            """Pump our text channel into the inner stream, sleeping on the first token.

            The toggle is read at the first token, not at construction: the stream is
            opened as soon as the turn begins and text only arrives as the LLM produces
            it, so reading it earlier would let a turn whose model was still thinking
            when the visitor moved the slider speak at full speed anyway. First token is
            where a synthesis genuinely begins — the analogue of ``chat()`` on the LLM
            side. Once read, that value is what gets both slept and recorded.
            """
            nonlocal injected
            started = False
            try:
                async for data in self._input_ch:
                    if isinstance(data, str):
                        if not started:
                            started = True
                            injected = self._chaos.tts_delay_seconds
                            if injected > 0:
                                logger.info(
                                    "chaos: delaying synthesis by %d ms",
                                    round(injected * 1000),
                                )
                                await asyncio.sleep(injected)
                        inner.push_text(data)
                    elif isinstance(data, self._FlushSentinel):
                        inner.flush()
            finally:
                inner.end_input()

        def _anchor_started_time() -> None:
            """Adopt the provider's own start instant, less whatever we injected.

            ``ttfb`` is measured from ``_started_time`` to the first audio frame, and
            getting that anchor right is the difference between a truthful waterfall
            and a flattering one. Calling ``_mark_started()`` when the first token
            reaches *us* would be wrong even with chaos off: LiveKit Inference buffers
            tokens into whole sentences and only marks started immediately before
            ``ws.send_str`` (``inference/tts.py``), so anchoring on our own first token
            would bill that tokenizer wait — hundreds of milliseconds while the model
            finishes a sentence — to speech synthesis on *every* turn.

            So the inner stream's anchor is adopted instead, exactly as the SDK's own
            ``FallbackAdapter`` does, and the injected delay is subtracted from it. With
            chaos off this reports precisely what the unwrapped voice would; with chaos
            on it reports that plus the delay, which is the honest number.
            """
            if not self._started_time and inner._started_time:
                self._started_time = inner._started_time - injected

        input_task = asyncio.create_task(_forward_input(), name="chaos-tts-forward")
        recorded = False
        try:
            async with inner:
                async for audio in inner:
                    _anchor_started_time()
                    if not recorded:
                        # Recorded on the first frame, not when the sleep ends: a
                        # synthesis abandoned before it made a sound reports no
                        # metrics, so an entry filed earlier would sit in the log
                        # waiting to be mis-claimed by the next turn.
                        recorded = True
                        self._chaos.tts_applied.record(
                            AppliedChaos(delay=injected), request_id=request_id
                        )
                    if texts := audio.frame.userdata.get(USERDATA_TIMED_TRANSCRIPT):
                        output_emitter.push_timed_transcript(texts)
                    output_emitter.push(audio.frame.data.tobytes())
        except APIError:
            # Same as the LLM wrapper: an errored attempt is the one case where audio
            # was produced and metrics still never arrive.
            if recorded:
                self._chaos.tts_applied.discard(request_id)
            raise
        finally:
            _anchor_started_time()
            await aio.cancel_and_wait(input_task)

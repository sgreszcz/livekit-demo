"""Chaos mode: runtime-adjustable latency injection in front of the LLM.

The point of the demo is that the cockpit shows *real* degradation, not a fake number.
:class:`DelayedLLM` wraps the LiveKit Inference LLM and sleeps before opening the
upstream request, inside the stream the SDK is already timing. The injected delay
therefore lands in the reported ``ttft``, and every downstream stage shifts with it,
exactly as a slow region or an overloaded provider would look.

The delay lives in a :class:`ChaosController` shared with the control-channel handler,
so the browser can change it mid-call without swapping models or restarting the session.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
from collections import deque
from typing import Any

from livekit.agents import (
    DEFAULT_API_CONNECT_OPTIONS,
    NOT_GIVEN,
    APIConnectOptions,
    NotGivenOr,
    llm,
)

__all__ = ["AppliedDelayLog", "ChaosController", "DelayedLLM", "parse_control_message"]

logger = logging.getLogger("glass-cockpit.chaos")

# Guard rail: the browser can ask for anything, but a demo that hangs for a minute
# is not a demo.
MAX_DELAY_MS = 10_000

# Applied delays are consumed within a turn or two of being recorded; the cap only
# stops a leak if some completion never reports metrics.
APPLIED_DELAY_HISTORY = 32


class AppliedDelayLog:
    """What chaos *actually* injected, per completion, so turns can be attributed.

    The toggle can move mid-turn, so asking it "are you on?" when a metric arrives
    answers the wrong question — a turn is degraded if a delay was applied to one of
    its own LLM invocations. :class:`DelayedLLM` records one entry per invocation and
    :class:`~telemetry.TurnStore` consumes one per ``LLMMetrics``.

    Entries are matched on the provider's request id, which the metric carries too. The
    FIFO fallback covers a provider that returns no id: LLM invocations in a voice
    pipeline start and finish one at a time, so the oldest unclaimed entry is the
    right one.
    """

    def __init__(self, capacity: int = APPLIED_DELAY_HISTORY) -> None:
        self._entries: deque[tuple[str, float]] = deque(maxlen=capacity)

    def record(self, delay: float, *, request_id: str = "") -> None:
        self._entries.append((request_id, delay))

    def take(self, request_id: str | None = None) -> float:
        """Claim the delay applied to ``request_id``; 0.0 if nothing was recorded."""
        if request_id:
            for index, (recorded_id, delay) in enumerate(self._entries):
                if recorded_id == request_id:
                    del self._entries[index]
                    return delay
        if not self._entries:
            return 0.0
        return self._entries.popleft()[1]


class ChaosController:
    """Mutable, shared injected-latency setting for the call."""

    def __init__(self, delay_ms: int = 0) -> None:
        self._delay_ms = 0
        self.applied = AppliedDelayLog()
        self.set_delay_ms(delay_ms)

    @property
    def delay_ms(self) -> int:
        return self._delay_ms

    @property
    def delay_seconds(self) -> float:
        return self._delay_ms / 1000.0

    @property
    def active(self) -> bool:
        return self._delay_ms > 0

    def set_delay_ms(self, delay_ms: int) -> None:
        self._delay_ms = max(0, min(int(delay_ms), MAX_DELAY_MS))

    def envelope_payload(self) -> dict[str, Any]:
        return {"llm_delay_ms": self._delay_ms, "active": self.active}


def parse_control_message(data: bytes) -> int | None:
    """Extract the requested LLM delay from a ``cockpit-control`` packet.

    The packet comes straight off a public data channel, so nothing about its shape is
    trusted: anything that isn't a well-formed chaos command returns ``None``, and no
    input raises. The value is still clamped by :meth:`ChaosController.set_delay_ms`.
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

    delay = payload.get("llm_delay_ms")
    # bool is an int subclass, and JSON's `true` is not a duration.
    if isinstance(delay, bool) or not isinstance(delay, (int, float)):
        logger.warning("chaos command carried a non-numeric llm_delay_ms: %r", delay)
        return None

    try:
        # NaN raises ValueError, ±inf raises OverflowError; huge ints survive and clamp.
        return int(delay)
    except (ValueError, OverflowError):
        logger.warning("chaos command carried a non-finite llm_delay_ms: %r", delay)
        return None


class DelayedLLM(llm.LLM):
    """Wraps an LLM so each completion can be delayed by the chaos controller."""

    def __init__(self, wrapped: llm.LLM, chaos: ChaosController) -> None:
        super().__init__()
        self._wrapped = wrapped
        self._chaos = chaos

    @property
    def model(self) -> str:
        return self._wrapped.model

    @property
    def provider(self) -> str:
        return self._wrapped.provider

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
        return _DelayedLLMStream(
            self,
            wrapped=self._wrapped,
            chaos=self._chaos,
            chat_ctx=chat_ctx,
            tools=tools or [],
            # Retries stay with the inner stream, which owns the upstream request;
            # retrying at both layers would multiply the attempts.
            conn_options=dataclasses.replace(conn_options, max_retry=0),
            inner_conn_options=conn_options,
            chat_kwargs={
                "parallel_tool_calls": parallel_tool_calls,
                "tool_choice": tool_choice,
                "extra_kwargs": extra_kwargs,
            },
        )

    async def aclose(self) -> None:
        await self._wrapped.aclose()


class _DelayedLLMStream(llm.LLMStream):
    """Sleeps, then proxies the wrapped model's chunks.

    The base class starts its metrics clock when the stream is constructed, so the
    sleep is measured as part of time-to-first-token — which is the whole point. The
    delay applied is logged against the request id the first chunk carries, so the
    turn store can tell a genuinely degraded turn from one that merely overlapped a
    toggle. The base class only reports metrics for a stream that produced a chunk, so
    logging on the first chunk keeps one entry per metric.
    """

    def __init__(
        self,
        delayed_llm: DelayedLLM,
        *,
        wrapped: llm.LLM,
        chaos: ChaosController,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        conn_options: APIConnectOptions,
        inner_conn_options: APIConnectOptions,
        chat_kwargs: dict[str, Any],
    ) -> None:
        self._wrapped = wrapped
        self._chaos = chaos
        self._inner_conn_options = inner_conn_options
        self._chat_kwargs = chat_kwargs
        super().__init__(delayed_llm, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)

    async def _run(self) -> None:
        delay = self._chaos.delay_seconds
        if delay > 0:
            logger.info("chaos: delaying completion by %d ms", self._chaos.delay_ms)
            await asyncio.sleep(delay)

        stream = self._wrapped.chat(
            chat_ctx=self._chat_ctx,
            tools=self._tools,
            conn_options=self._inner_conn_options,
            **self._chat_kwargs,
        )
        recorded = False
        try:
            async for chunk in stream:
                if not recorded:
                    self._chaos.applied.record(delay, request_id=chunk.id or "")
                    recorded = True
                self._event_ch.send_nowait(chunk)
        finally:
            await stream.aclose()

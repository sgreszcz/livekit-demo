"""Telemetry bus for the Glass Cockpit agent.

Everything the cockpit SPA renders comes from here. Three pieces:

* :func:`envelope` — builds the v1 wire envelope defined in ``docs/TELEMETRY-SCHEMA.md``.
* :class:`TurnStore` — in-memory state for the call. Merges the partial metrics the
  LiveKit SDK emits at different times into per-turn waterfalls, tracks running usage,
  detects barge-ins, and answers the agent's own ``get_call_metrics`` tool.
* :class:`TelemetryPublisher` — serialises envelopes onto the room data channel in
  emission order and keeps a transcript of the call for the end-of-session debrief.

The store is deliberately free of SDK and network types: it takes plain numbers, so it
can be unit-tested offline and replayed against ``docs/fixtures/sample-call.jsonl``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import pricing

__all__ = [
    "CONTROL_TOPIC",
    "SCHEMA_VERSION",
    "TELEMETRY_TOPIC",
    "LLMInvocation",
    "PipelineModels",
    "TelemetryPublisher",
    "Turn",
    "TurnStore",
    "envelope",
    "post_debrief",
]

logger = logging.getLogger("glass-cockpit.telemetry")

SCHEMA_VERSION = 1
TELEMETRY_TOPIC = "cockpit"
CONTROL_TOPIC = "cockpit-control"

# LiveKit data packets are capped at 15 KiB; only transcripts can realistically
# approach that, and they get truncated rather than dropped.
MAX_PACKET_BYTES = 15 * 1024
TRUNCATION_MARKER = "…[truncated]"

EnvelopeType = Literal["turn", "transcript", "state", "interruption", "usage", "chaos", "call_meta"]

# The SDK's AgentState includes "idle", which the wire schema does not model; the
# cockpit treats an idle agent as listening.
_STATE_ALIASES = {"idle": "listening"}


def envelope(
    type: EnvelopeType,
    payload: dict[str, Any],
    *,
    ts: float,
    speech_id: str | None = None,
) -> dict[str, Any]:
    """Build a v1 telemetry envelope."""
    env: dict[str, Any] = {"v": SCHEMA_VERSION, "type": type, "ts": ts}
    if speech_id is not None:
        env["speech_id"] = speech_id
    env["payload"] = payload
    return env


@dataclass(frozen=True)
class PipelineModels:
    """The model ids the worker was configured with, echoed into telemetry."""

    stt: str
    llm: str
    tts: str


@dataclass(frozen=True)
class LLMInvocation:
    """One completion request. A turn that calls a tool makes more than one."""

    ttft: float
    duration: float
    prompt_tokens: int
    completion_tokens: int
    applied_delay: float = 0.0
    """Chaos latency actually injected in front of *this* request, in seconds."""


@dataclass
class Turn:
    """One user→agent exchange, keyed by the SDK's speech id."""

    turn_id: str
    eou: dict[str, float] | None = None
    stt: dict[str, Any] | None = None
    llm: dict[str, Any] | None = None
    tts: dict[str, Any] | None = None
    llm_chain: list[LLMInvocation] = field(default_factory=list)
    total_response_latency: float | None = None
    degraded: bool = False
    barge_in: bool = False
    user_text: str = ""
    agent_text: str = ""

    @property
    def response_latency(self) -> float | None:
        """The perceived critical path, or ``None`` until all three stages are in."""
        if self.eou is None or self.llm is None or self.tts is None:
            return None
        return _r(self.eou["end_of_utterance_delay"] + self.llm["ttft"] + self.tts["ttfb"])


class TurnStore:
    """Merges the SDK's out-of-order metrics into the cockpit's per-turn view.

    The SDK reports each pipeline stage on its own schedule and only tags LLM, TTS and
    EOU metrics with a ``speech_id``. STT metrics and the caller's transcript carry none,
    and both describe the utterance *before* turn detection has named the turn it
    triggers — so they are buffered and flushed by :meth:`record_eou`, which supplies
    the id. Agent transcripts arrive mid-turn and attach to the turn in flight.

    For ``eou`` and ``tts`` the first metric of a turn wins. ``llm`` is different: a
    turn that calls a tool runs the model more than once, and the wire contract reports
    the *chain* — summed tokens and duration, with ``ttft`` the perceived first token
    (every earlier invocation ran to completion before the last one started). Each new
    invocation therefore re-emits the turn, and the total response latency along with it
    if the chain grew after the totals were first published. ``stt`` accumulates the same
    way, because one utterance can produce several metrics.
    """

    def __init__(
        self,
        *,
        models: PipelineModels,
        applied_delay: Callable[[str | None], float] = lambda _request_id: 0.0,
    ) -> None:
        self._models = models
        self._applied_delay = applied_delay
        self._turns: dict[str, Turn] = {}
        self._current_turn_id: str | None = None
        self._last_turn_id: str | None = None
        # FIFO buffers: one utterance can produce several final transcripts and several
        # STT metrics, and all of them arrive before the turn they belong to has an id.
        self._pending_user_text: list[str] = []
        self._pending_stt: list[tuple[float, float]] = []
        self._prompt_tokens = 0
        self._completion_tokens = 0
        self._stt_audio_seconds = 0.0
        self._tts_characters = 0

    # ---------------------------------------------------------------- accessors

    @property
    def turns(self) -> list[Turn]:
        return list(self._turns.values())

    @property
    def current_turn_id(self) -> str | None:
        return self._current_turn_id

    def get(self, turn_id: str) -> Turn | None:
        return self._turns.get(turn_id)

    @property
    def completed_turns(self) -> list[Turn]:
        return [t for t in self._turns.values() if t.total_response_latency is not None]

    # ------------------------------------------------------------ metric intake

    def record_eou(
        self,
        turn_id: str,
        *,
        end_of_utterance_delay: float,
        transcription_delay: float,
    ) -> list[dict[str, Any]]:
        """Ingest EOUMetrics — the first event that names a new turn.

        Everything the SDK reported about the caller's utterance arrived before this
        point without a speech id, so the buffered transcript and STT metrics are
        flushed here, now that there is a turn to attach them to.
        """
        self._current_turn_id = turn_id
        ts = _ts()
        turn = self._touch(turn_id)
        envelopes: list[dict[str, Any] | None] = []

        if self._pending_user_text:
            turn.user_text = " ".join(self._pending_user_text)
            self._pending_user_text.clear()
            envelopes.append(
                envelope(
                    "transcript",
                    {
                        "role": "user",
                        "text": turn.user_text,
                        "final": True,
                        "turn_id": turn_id,
                    },
                    ts=ts,
                    speech_id=turn_id,
                )
            )

        envelopes.append(
            self._merge(
                turn_id,
                "eou",
                {
                    "end_of_utterance_delay": _r(end_of_utterance_delay),
                    "transcription_delay": _r(transcription_delay),
                },
                ts=ts,
            )
        )

        if self._pending_stt:
            for duration, audio_duration in self._pending_stt:
                self._add_stt(turn, duration, audio_duration)
            self._pending_stt.clear()
            envelopes.append(self._turn_envelope(turn, {"stt": turn.stt}, ts=ts))

        return [e for e in envelopes if e is not None]

    def record_llm(
        self,
        turn_id: str,
        *,
        ttft: float,
        duration: float,
        prompt_tokens: int,
        completion_tokens: int,
        request_id: str | None = None,
        ts: float | None = None,
    ) -> dict[str, Any]:
        """Ingest LLMMetrics, appending to the turn's chain of invocations.

        ``request_id`` identifies the completion this metric describes, and is how the
        chaos delay *actually* injected in front of it is recovered — polling the
        current toggle state here would mis-attribute any turn that straddles a toggle.
        """
        self._prompt_tokens += prompt_tokens
        self._completion_tokens += completion_tokens

        turn = self._touch(turn_id)
        applied_delay = self._applied_delay(request_id)
        turn.llm_chain.append(
            LLMInvocation(
                ttft=ttft,
                duration=duration,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                applied_delay=applied_delay,
            )
        )
        if applied_delay > 0:
            turn.degraded = True
        turn.llm = self._llm_block(turn.llm_chain)
        return self._turn_envelope(turn, {"llm": turn.llm}, ts=ts if ts is not None else _ts())

    def _llm_block(self, chain: list[LLMInvocation]) -> dict[str, Any]:
        """Collapse a turn's invocations into the single ``llm`` block on the wire.

        Everything but ``ttft`` is a plain sum. ``ttft`` is what the caller perceives:
        each invocation before the last had to finish (tool call included in the reply
        only afterwards), so their full durations precede the last one's first token.
        """
        duration = sum(call.duration for call in chain)
        completion_tokens = sum(call.completion_tokens for call in chain)
        return {
            "ttft": _r(sum(call.duration for call in chain[:-1]) + chain[-1].ttft),
            "duration": _r(duration),
            "prompt_tokens": sum(call.prompt_tokens for call in chain),
            "completion_tokens": completion_tokens,
            "tokens_per_second": _r(completion_tokens / duration if duration else 0.0, 1),
            "llm_calls": len(chain),
            "model": self._models.llm,
        }

    def record_tts(
        self,
        turn_id: str,
        *,
        ttfb: float,
        duration: float,
        audio_duration: float,
        characters_count: int,
        ts: float | None = None,
    ) -> dict[str, Any] | None:
        """Ingest TTSMetrics. Fires once per synthesised segment."""
        self._tts_characters += characters_count
        return self._merge(
            turn_id,
            "tts",
            {
                "ttfb": _r(ttfb),
                "duration": _r(duration),
                "audio_duration": _r(audio_duration),
                "model": self._models.tts,
            },
            ts=ts if ts is not None else _ts(),
        )

    def record_stt(self, *, duration: float, audio_duration: float) -> None:
        """Ingest STTMetrics, which the SDK emits without a speech id.

        The metric describes the caller's utterance and lands before turn detection
        names the turn that utterance triggers, so it is buffered until the next
        :meth:`record_eou`. One utterance can produce several metrics — the plugin
        reports usage per final recognition — so they queue up and are summed into a
        single ``stt`` block instead of overwriting each other.

        Anything arriving after a flush belongs to the caller's *next* utterance: the
        inference plugin sends its usage event ahead of the final transcript it
        accompanies (``livekit/agents/inference/stt.py``), so there is no window in
        which a straggler for the turn just named could be mistaken for one. Usage
        totals update immediately — billing does not care which turn the audio is
        drawn on.
        """
        self._stt_audio_seconds += audio_duration
        self._pending_stt.append((duration, audio_duration))

    def _add_stt(self, turn: Turn, duration: float, audio_duration: float) -> None:
        """Fold one STT metric into a turn's ``stt`` block.

        Durations add up because one utterance can be recognised in several requests.
        Streaming STT reports ``duration`` 0.0, so the sum stays 0.0 there too.
        """
        if turn.stt is None:
            turn.stt = {"duration": 0.0, "audio_duration": 0.0, "model": self._models.stt}
        turn.stt["duration"] = _r(turn.stt["duration"] + duration)
        turn.stt["audio_duration"] = _r(turn.stt["audio_duration"] + audio_duration)

    def _touch(self, turn_id: str) -> Turn:
        """Fetch or create a turn, and remember it as the most recent one seen."""
        turn = self._turns.get(turn_id)
        if turn is None:
            turn = Turn(turn_id=turn_id)
            self._turns[turn_id] = turn
        self._last_turn_id = turn_id
        return turn

    def _merge(
        self, turn_id: str, stage: str, data: dict[str, Any], *, ts: float
    ) -> dict[str, Any] | None:
        """Record a write-once stage (``eou``, ``tts``); repeats are dropped."""
        turn = self._touch(turn_id)
        if getattr(turn, stage) is not None:
            return None
        setattr(turn, stage, data)
        return self._turn_envelope(turn, {stage: data}, ts=ts)

    def _turn_envelope(self, turn: Turn, fields: dict[str, Any], *, ts: float) -> dict[str, Any]:
        """Publish a partial turn update, with the totals whenever they move.

        A late LLM invocation lengthens the chain's effective ``ttft`` after the totals
        were first sent, so the corrected value is re-published and the frontend's
        last-write-wins merge picks it up.
        """
        payload: dict[str, Any] = {"turn_id": turn.turn_id, **fields}
        latency = turn.response_latency
        if latency is not None and latency != turn.total_response_latency:
            turn.total_response_latency = latency
            payload["total_response_latency"] = latency
            payload["degraded"] = turn.degraded
        return envelope("turn", payload, ts=ts, speech_id=turn.turn_id)

    # -------------------------------------------------------------- transcripts

    def record_user_transcript(self, text: str) -> None:
        """Buffer the caller's final transcript until a turn id exists.

        ``user_input_transcribed`` fires before turn detection completes, so there is
        no speech id yet; :meth:`record_eou` publishes these against the turn it names.
        One utterance can produce several finals — the caller pausing mid-sentence is
        enough — so they queue up and are joined in order rather than overwriting each
        other. Interim transcripts are dropped for the same reason — see the README.
        """
        text = text.strip()
        if text:
            self._pending_user_text.append(text)

    def record_agent_transcript(self, text: str) -> dict[str, Any] | None:
        """Publish what the agent said, attributed to the turn in flight.

        Speech the agent initiates (the greeting) has no user turn, so
        ``_current_turn_id`` is still unset; the turn its own LLM/TTS metrics
        created moments earlier is the right home, hence the fallback.
        """
        turn_id = self._current_turn_id or self._last_turn_id
        if turn_id is None:
            return None
        self._touch(turn_id).agent_text = text
        return envelope(
            "transcript",
            {"role": "agent", "text": text, "final": True, "turn_id": turn_id},
            ts=_ts(),
            speech_id=turn_id,
        )

    # ------------------------------------------------------- state & disruption

    def record_state(
        self, prev: str, new: str, *, speech_interrupted: bool = False
    ) -> list[dict[str, Any]]:
        """Translate an agent state change into envelopes.

        A move out of ``speaking`` while the active speech handle is flagged
        interrupted is a barge-in, and is reported before the state change itself.
        """
        envelopes: list[dict[str, Any]] = []
        ts = _ts()
        if (
            prev == "speaking"
            and new in ("listening", "thinking", "idle")
            and speech_interrupted
            and self._current_turn_id is not None
        ):
            turn_id = self._current_turn_id
            self._touch(turn_id).barge_in = True
            envelopes.append(
                envelope(
                    "interruption",
                    {"kind": "barge_in", "turn_id": turn_id},
                    ts=ts,
                    speech_id=turn_id,
                )
            )
        envelopes.append(
            envelope(
                "state",
                {"state": _state(new), "prev": _state(prev)},
                ts=ts,
            )
        )
        return envelopes

    def record_false_interruption(self) -> dict[str, Any] | None:
        """The SDK decided a detected interruption was noise, not a real barge-in."""
        if self._current_turn_id is None:
            return None
        return envelope(
            "interruption",
            {"kind": "false_interruption", "turn_id": self._current_turn_id},
            ts=_ts(),
            speech_id=self._current_turn_id,
        )

    # -------------------------------------------------------------------- usage

    def usage_payload(self) -> dict[str, Any]:
        return {
            "llm_prompt_tokens": self._prompt_tokens,
            "llm_completion_tokens": self._completion_tokens,
            "stt_audio_seconds": _r(self._stt_audio_seconds),
            "tts_characters": self._tts_characters,
            "est_cost_usd": self.estimated_cost_usd(),
        }

    def record_usage(self) -> dict[str, Any]:
        return envelope("usage", self.usage_payload(), ts=_ts())

    def estimated_cost_usd(self) -> float:
        return pricing.estimate_cost_usd(
            llm_model=self._models.llm,
            prompt_tokens=self._prompt_tokens,
            completion_tokens=self._completion_tokens,
            stt_model=self._models.stt,
            stt_audio_seconds=self._stt_audio_seconds,
            tts_model=self._models.tts,
            tts_characters=self._tts_characters,
        )

    def call_meta(
        self, *, call_id: str, room: str, started_at: float, entry: str
    ) -> dict[str, Any]:
        return envelope(
            "call_meta",
            {
                "call_id": call_id,
                "room": room,
                "started_at": started_at,
                "pipeline": {
                    "stt": self._models.stt,
                    "llm": self._models.llm,
                    "tts": self._models.tts,
                },
                "entry": entry,
            },
            ts=started_at,
        )

    # ------------------------------------------------------------------- replay

    def apply_envelope(self, env: dict[str, Any]) -> None:
        """Rebuild store state from envelopes this class emitted.

        Lets a recorded call (``docs/fixtures/sample-call.jsonl``) drive the store
        without a live session.

        ``llm`` and ``stt`` blocks are cumulative for their turn and get re-published
        as they grow, so usage takes the *difference* against what that turn last
        reported; adding them up would double-count every tool-calling turn.
        """
        kind, payload = env.get("type"), env.get("payload", {})
        if kind == "turn":
            turn_id = payload["turn_id"]
            turn = self._turns.setdefault(turn_id, Turn(turn_id=turn_id))
            self._current_turn_id = turn_id
            if "llm" in payload:
                previous = turn.llm or {}
                self._prompt_tokens += payload["llm"].get("prompt_tokens", 0) - previous.get(
                    "prompt_tokens", 0
                )
                self._completion_tokens += payload["llm"].get(
                    "completion_tokens", 0
                ) - previous.get("completion_tokens", 0)
            if "stt" in payload:
                previous = turn.stt or {}
                self._stt_audio_seconds += payload["stt"].get("audio_duration", 0.0) - previous.get(
                    "audio_duration", 0.0
                )
            for stage in ("eou", "stt", "llm", "tts"):
                if stage in payload:
                    setattr(turn, stage, payload[stage])
            if "total_response_latency" in payload:
                turn.total_response_latency = payload["total_response_latency"]
            if "degraded" in payload:
                turn.degraded = payload["degraded"]
        elif kind == "transcript":
            turn_id = payload["turn_id"]
            turn = self._turns.setdefault(turn_id, Turn(turn_id=turn_id))
            if payload["role"] == "user":
                turn.user_text = payload["text"]
            else:
                turn.agent_text = payload["text"]
        elif kind == "interruption" and payload.get("kind") == "barge_in":
            turn_id = payload["turn_id"]
            self._turns.setdefault(turn_id, Turn(turn_id=turn_id)).barge_in = True

    # ------------------------------------------------- the agent's own read-out

    def summary(self) -> str:
        """Natural-language telemetry read-out for the ``get_call_metrics`` tool."""
        done = self.completed_turns
        if not done:
            return (
                "I haven't finished a full turn yet, so there's no waterfall to read "
                "out. Ask me again after your next question."
            )

        last = done[-1]
        assert last.eou is not None and last.llm is not None and last.tts is not None
        waterfall = (
            f"Last turn: {_ms(last.total_response_latency)} end to end — "
            f"{_ms(last.eou['end_of_utterance_delay'])} of turn detection, "
            f"{_ms(last.llm['ttft'])} to my first token, "
            f"{_ms(last.tts['ttfb'])} to my first audio."
        )
        lines = [waterfall]
        if last.degraded:
            lines.append("That turn ran with chaos mode injecting extra model latency.")

        avg = sum(t.total_response_latency or 0.0 for t in done) / len(done)
        lines.append(
            f"Across {len(done)} completed turn{'s' if len(done) != 1 else ''} "
            f"the average is {_ms(avg)}."
        )

        barge_ins = sum(1 for t in self._turns.values() if t.barge_in)
        if barge_ins:
            lines.append(f"You've interrupted me {barge_ins} time{'s' if barge_ins != 1 else ''}.")

        lines.append(
            f"Running cost is about {self.estimated_cost_usd():.4f} US dollars, "
            f"{self._prompt_tokens} prompt and {self._completion_tokens} completion tokens "
            f"so far — an estimate, not a bill."
        )
        return " ".join(lines)


class TelemetryPublisher:
    """Serialises envelopes onto the room data channel, in order, and records them.

    Publishing is async but the SDK's event callbacks are synchronous, so envelopes go
    through a queue drained by one task. That keeps the wire order identical to the
    emission order, which the cockpit relies on when merging partial turns.
    """

    def __init__(self, room: Any | None) -> None:
        self._room = room
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._drain_task: asyncio.Task[None] | None = None
        self._messages: list[dict[str, Any]] = []

    @property
    def messages(self) -> list[dict[str, Any]]:
        """Every envelope emitted this call, in order — the debrief payload."""
        return self._messages

    def start(self) -> None:
        if self._drain_task is None:
            self._drain_task = asyncio.create_task(self._drain(), name="cockpit-telemetry")

    def emit(self, env: dict[str, Any] | None) -> None:
        """Queue an envelope. Accepts ``None`` so callers can forward optional results."""
        if env is None:
            return
        self._messages.append(env)
        self._queue.put_nowait(env)

    def emit_all(self, envelopes: list[dict[str, Any]]) -> None:
        for env in envelopes:
            self.emit(env)

    async def aclose(self) -> None:
        """Flush anything still queued, then stop the drain task."""
        if self._drain_task is None:
            return
        await self._queue.join()
        self._drain_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._drain_task
        self._drain_task = None

    async def _drain(self) -> None:
        while True:
            env = await self._queue.get()
            try:
                await self._publish(env)
            except Exception:
                logger.exception("failed to publish telemetry envelope type=%s", env.get("type"))
            finally:
                self._queue.task_done()

    async def _publish(self, env: dict[str, Any]) -> None:
        if self._room is None:
            logger.debug("cockpit %s %s", env["type"], env["payload"])
            return
        await self._room.local_participant.publish_data(
            encode_envelope(env), reliable=True, topic=TELEMETRY_TOPIC
        )


def encode_envelope(env: dict[str, Any]) -> bytes:
    """Serialise an envelope, trimming transcript text to fit the packet limit."""
    data = _dumps(env)
    if len(data) <= MAX_PACKET_BYTES:
        return data

    text = env.get("payload", {}).get("text")
    if not isinstance(text, str):
        logger.warning(
            "telemetry envelope type=%s is %d bytes and cannot be trimmed",
            env.get("type"),
            len(data),
        )
        return data

    trimmed = dict(env, payload=dict(env["payload"]))
    while len(data) > MAX_PACKET_BYTES and text:
        overflow = len(data) - MAX_PACKET_BYTES
        text = text[: max(0, len(text) - overflow - len(TRUNCATION_MARKER))]
        trimmed["payload"]["text"] = text + TRUNCATION_MARKER
        data = _dumps(trimmed)
    return data


async def post_debrief(
    *,
    url: str | None,
    token: str | None,
    call_id: str,
    meta: dict[str, Any],
    messages: list[dict[str, Any]],
    ended_at: float,
) -> str | None:
    """POST the call recording to the debrief endpoint; return its share URL.

    A missing or unreachable endpoint is not fatal — the demo still works without a
    shareable replay, so failures are logged and swallowed.
    """
    if not url:
        logger.info("DEBRIEF_URL unset; skipping debrief upload (%d envelopes)", len(messages))
        return None

    import httpx

    body = {"call_id": call_id, "meta": meta, "ended_at": ended_at, "messages": messages}
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=body, headers=headers)
            response.raise_for_status()
            share_url = response.json().get("url")
    except Exception as exc:  # noqa: BLE001 - the call already ended; nothing here is worth raising for
        logger.warning("debrief upload failed: %s", exc)
        return None

    logger.info("debrief stored: %s", share_url)
    return share_url


def _dumps(env: dict[str, Any]) -> bytes:
    return json.dumps(env, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _state(state: str) -> str:
    return _STATE_ALIASES.get(state, state)


def _r(value: float, digits: int = 3) -> float:
    """Round away float noise; the schema carries SDK-native seconds."""
    return round(float(value), digits)


def _ms(seconds: float | None) -> str:
    return "unknown" if seconds is None else f"{round(seconds * 1000)} milliseconds"


def _ts() -> float:
    return time.time()

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
import ipaddress
import json
import logging
import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit

import pricing

__all__ = [
    "CALL_SUMMARY_MARKER",
    "CHECKPOINT_SECONDS",
    "CHECKPOINT_TIMEOUT",
    "CONTROL_TOPIC",
    "FINAL_TIMEOUT",
    "OBSERVER_IDENTITY_PREFIX",
    "MIN_PHONE_DIGITS",
    "MIN_SEPARATED_DIGITS",
    "PHONE_RUN",
    "REDACTED",
    "SCHEMA_VERSION",
    "SIP_ROOM_PREFIX",
    "TELEMETRY_TOPIC",
    "AppliedChaos",
    "DebriefUploader",
    "LLMInvocation",
    "PipelineModels",
    "TelemetryPublisher",
    "Turn",
    "TurnStore",
    "classify_entry_room",
    "envelope",
    "is_observer",
    "log_call_summary",
    "percentile_ms",
    "post_debrief",
    "redact_room_name",
]

logger = logging.getLogger("glass-cockpit.telemetry")

SCHEMA_VERSION = 1
TELEMETRY_TOPIC = "cockpit"
CONTROL_TOPIC = "cockpit-control"

# ------------------------------------------------------------------ room names
#
# The room name is the one identifier in this system that carries PII. A browser
# call gets `cockpit-<random>`, which means nothing on its own. A phone call does
# not: LiveKit's SIP dispatch names the room after the trunk and the *caller's
# number* — `sip-cockpit-_+447700900123_5xzppVvwo6Px` — so anything that stores or
# republishes a raw room name publishes a stranger's phone number. A debrief is
# fetched by anyone holding its share link, and `call_meta` goes out on the data
# channel to every participant including read-only observers; both are publication.
#
# The regex and the replacement mirror `redactRoomName` in `worker/src/rooms.ts`
# byte for byte, deliberately: both sides redact, and they must agree on the result
# or the same call would be stored under two different names.
#
# NOTE: this only covers what *this repo* emits. LiveKit's own log lines (the ones
# `lk agent logs` streams) carry the raw room name in their `room` field, and that
# is outside this repo's control — see agent/OBSERVABILITY.md.

# A run of digits long enough to be a phone number, with the optional `+` that makes
# it E.164. Seven rather than six: the shortest numbers anyone dials are seven digits,
# and every extra required digit makes a false positive on a random base62 room suffix
# less likely. A false positive costs a mangled cosmetic string and nothing else.
PHONE_RUN = re.compile(r"\+?\d[\d\s().-]{5,}\d")
"""Digit runs long enough to be a phone number, separators allowed between them.

Mirrors ``PHONE_RUN`` in ``worker/src/rooms.ts`` — the two sides redact identically
or the agent uploads something the Worker would have stripped. Separators are
permitted because a rule matching only unbroken digits is evaded by the way people
actually write numbers (``+44-7700-900123``), and the room-name grammar allows
``-`` and ``_``; the separators are then removed and the DIGITS counted, so a
hyphenated base62 id carrying a couple of digits is not mistaken for a number.
"""

MIN_PHONE_DIGITS = 7
"""An unbroken run this long is a phone number. Nothing else in a room name is."""

MIN_SEPARATED_DIGITS = 9
"""When separators are involved, more digits are required.

Allowing separators is what catches ``+44-7700-900123``, but it also matches
``2026-08-07`` — eight digits, and a date. Real dialable numbers are longer (E.164
runs to fifteen, a UK mobile is eleven), so nine separates them from dates and
version strings while still catching every way a person writes a number.
"""

#: What a redacted number is replaced with. Recognisable, and never itself a number.
REDACTED = "+REDACTED"

#: Room-name prefix LiveKit's SIP dispatch uses. Authoritative for entry classification.
SIP_ROOM_PREFIX = "sip-cockpit-"


def redact_room_name(name: str) -> str:
    """Strip caller numbers from a room name, keeping its shape.

    ``sip-cockpit-_+447700900123_5xzppVvwo6Px`` → ``sip-cockpit-_+REDACTED_5xzppVvwo6Px``.
    The ``sip-cockpit-`` prefix survives (entry classification reads it) and so does the
    random suffix (it is what makes one call distinguishable from another), while the
    only field a person could be identified by is gone. Idempotent, so it is safe to
    apply again to a name that has already been through it.
    """
    def _replace(match: re.Match[str]) -> str:
        text = match.group(0)
        digits = re.sub(r"\D", "", text)
        # "+" is punctuation a number legitimately starts with, not a separator.
        needed = MIN_SEPARATED_DIGITS if re.search(r"[^\d+]", text) else MIN_PHONE_DIGITS
        return REDACTED if len(digits) >= needed else text

    return PHONE_RUN.sub(_replace, name)


def classify_entry_room(room_name: str) -> str:
    """Classify how the caller reached us from the ROOM NAME alone.

    The room name is known the instant ``ctx.connect()`` returns, which is the whole
    point: the previous implementation classified by awaiting the caller participant,
    an await with no timeout that never resolves if the caller hangs up mid-connect —
    and everything registered after it, the shutdown callback included, never happened.
    A synchronous classification cannot fail, cannot block, and cannot lose a call.

    This mirrors ``classifyEntry`` in ``worker/src/active.ts``, which already treats the
    prefix as authoritative for the same purpose. Unlike the worker's version there is no
    ``null`` case: this agent only ever runs in a room it was dispatched into, and a name
    that matches no known prefix (a console session, a hand-made room) is a browser-shaped
    call as far as telemetry is concerned.
    """
    return "sip" if room_name.startswith(SIP_ROOM_PREFIX) else "browser"


# A cockpit opened by someone who is not the caller joins the room under this identity
# prefix. Observers are read-only: they never drive turn detection, never decide the
# call's entry classification, and are the only participants sent the catch-up snapshot.
OBSERVER_IDENTITY_PREFIX = "observer-"

# LiveKit data packets are capped at 15 KiB; only transcripts can realistically
# approach that, and they get truncated rather than dropped.
MAX_PACKET_BYTES = 15 * 1024
TRUNCATION_MARKER = "…[truncated]"

EnvelopeType = Literal["turn", "transcript", "state", "interruption", "usage", "chaos", "call_meta"]

# The SDK's AgentState includes "idle", which the wire schema does not model; the
# cockpit treats an idle agent as listening.
_STATE_ALIASES = {"idle": "listening"}


def is_observer(identity: str | None) -> bool:
    """True for a read-only cockpit that joined to watch someone else's call."""
    return bool(identity) and identity.startswith(OBSERVER_IDENTITY_PREFIX)  # type: ignore[union-attr]


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
class AppliedChaos:
    """What chaos actually did to one pipeline invocation.

    The record a :class:`TurnStore` claims when a metric arrives, so a turn can be
    attributed truthfully: the toggle can move mid-turn, and asking it "are you on?"
    when the metric lands answers the wrong question.

    It lives here rather than in ``chaos.py`` on purpose. It is pure data with no SDK
    types, and the dependency arrow points from the SDK-bound injector *into* the
    offline-testable store — the same direction as ``agent.py``. The store never
    imports the injector.

    ``model``, ``slow_model`` and ``max_completion_tokens`` are LLM-only and stay unset
    for a TTS record, whose only injection is a delay.
    """

    delay: float = 0.0
    """Latency actually injected in front of this invocation, in seconds."""
    model: str | None = None
    """The model this invocation actually ran against; ``None`` means "the default"."""
    slow_model: bool = False
    max_completion_tokens: int | None = None

    @property
    def degraded(self) -> bool:
        """True if chaos touched this invocation at all — any injection counts."""
        return self.delay > 0 or self.slow_model or self.max_completion_tokens is not None


@dataclass(frozen=True)
class LLMInvocation:
    """One completion request. A turn that calls a tool makes more than one."""

    ttft: float
    duration: float
    prompt_tokens: int
    completion_tokens: int
    applied_delay: float = 0.0
    """Chaos latency actually injected in front of *this* request, in seconds."""
    model: str | None = None
    """The model this invocation actually ran against — chaos can swap it per call."""


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
    published_degraded: bool = False
    """The last ``degraded`` value put on the wire, so a late flip can be corrected."""
    barge_in: bool = False
    user_text: str = ""
    agent_text: str = ""

    @property
    def response_latency(self) -> float | None:
        """The perceived critical path, or ``None`` until all three stages are in."""
        if self.eou is None or self.llm is None or self.tts is None:
            return None
        return _r(self.eou["end_of_utterance_delay"] + self.llm["ttft"] + self.tts["ttfb"])


def _no_chaos(_request_id: str | None) -> AppliedChaos:
    """Default attribution for a store running without a chaos controller."""
    return AppliedChaos()


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
        applied_llm_chaos: Callable[[str | None], AppliedChaos] = _no_chaos,
        applied_tts_chaos: Callable[[str | None], AppliedChaos] = _no_chaos,
    ) -> None:
        self._models = models
        self._applied_llm_chaos = applied_llm_chaos
        self._applied_tts_chaos = applied_tts_chaos
        self._turns: dict[str, Turn] = {}
        self._current_turn_id: str | None = None
        self._last_turn_id: str | None = None
        # FIFO buffers: one utterance can produce several final transcripts and several
        # STT metrics, and all of them arrive before the turn they belong to has an id.
        self._pending_user_text: list[str] = []
        self._pending_stt: list[tuple[float, float]] = []
        self._prompt_tokens = 0
        self._completion_tokens = 0
        # The same tokens again, split by the model that actually produced them. The
        # wire's usage totals stay flat (the schema has one number for each), but the
        # cost estimate cannot: chaos can move the call onto a model five times the
        # price mid-conversation, and one blended rate would misprice both halves.
        self._llm_usage: dict[str, list[int]] = {}
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
        chaos *actually* applied in front of it is recovered — polling the current
        toggle state here would mis-attribute any turn that straddles a toggle. The
        record also carries the model this invocation really ran against, which chaos
        can swap per call.
        """
        turn = self._touch(turn_id)
        applied = self._applied_llm_chaos(request_id)
        self._add_llm_tokens(applied.model or self._models.llm, prompt_tokens, completion_tokens)
        turn.llm_chain.append(
            LLMInvocation(
                ttft=ttft,
                duration=duration,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                applied_delay=applied.delay,
                model=applied.model,
            )
        )
        if applied.degraded:
            turn.degraded = True
        turn.llm = self._llm_block(turn.llm_chain)
        return self._turn_envelope(turn, {"llm": turn.llm}, ts=ts if ts is not None else _ts())

    def _add_llm_tokens(self, model: str, prompt_tokens: int, completion_tokens: int) -> None:
        """Fold one invocation's tokens into both the flat totals and the per-model split."""
        self._prompt_tokens += prompt_tokens
        self._completion_tokens += completion_tokens
        bucket = self._llm_usage.setdefault(model, [0, 0])
        bucket[0] += prompt_tokens
        bucket[1] += completion_tokens

    def _llm_block(self, chain: list[LLMInvocation]) -> dict[str, Any]:
        """Collapse a turn's invocations into the single ``llm`` block on the wire.

        Everything but ``ttft`` is a plain sum. ``ttft`` is what the caller perceives:
        each invocation before the last had to finish (tool call included in the reply
        only afterwards), so their full durations precede the last one's first token.

        Summing is lossy — a 1.4 s ``ttft`` reads the same whether one slow call or two
        quick ones produced it — so a multi-invocation turn also carries the per-call
        breakdown in the optional ``chain`` array, in invocation order. It is omitted
        for the single-call case, where it would only repeat ``ttft``/``duration``:
        every turn on a normal call pays for that field otherwise, and consumers of the
        v1 schema must treat it as optional regardless.

        ``model`` reports the model the *last* invocation actually used. Chaos can swap
        the model per invocation, so a chain is not guaranteed to be homogeneous; the
        last one is the one whose tokens the caller is still hearing, and the per-call
        ``chain`` entries stay ``{ttft, duration}`` as the schema specifies.
        """
        duration = sum(call.duration for call in chain)
        completion_tokens = sum(call.completion_tokens for call in chain)
        block: dict[str, Any] = {
            "ttft": _r(sum(call.duration for call in chain[:-1]) + chain[-1].ttft),
            "duration": _r(duration),
            "prompt_tokens": sum(call.prompt_tokens for call in chain),
            "completion_tokens": completion_tokens,
            "tokens_per_second": _r(completion_tokens / duration if duration else 0.0, 1),
            "llm_calls": len(chain),
            "model": chain[-1].model or self._models.llm,
        }
        if len(chain) > 1:
            block["chain"] = [
                {"ttft": _r(call.ttft), "duration": _r(call.duration)} for call in chain
            ]
        return block

    def record_tts(
        self,
        turn_id: str,
        *,
        ttfb: float,
        duration: float,
        audio_duration: float,
        characters_count: int,
        request_id: str | None = None,
        ts: float | None = None,
    ) -> dict[str, Any] | None:
        """Ingest TTSMetrics. Fires once per synthesised segment.

        ``request_id`` recovers the chaos delay actually injected in front of *this*
        synthesis, the same way ``record_llm`` does for a completion. The claim happens
        for every segment, including ones whose ``tts`` block is dropped as a repeat —
        skipping it would leave the log's FIFO fallback one entry out of step for the
        rest of the call.
        """
        self._tts_characters += characters_count
        ts = ts if ts is not None else _ts()
        turn = self._touch(turn_id)
        if self._applied_tts_chaos(request_id).degraded:
            turn.degraded = True

        env = self._merge(
            turn_id,
            "tts",
            {
                "ttfb": _r(ttfb),
                "duration": _r(duration),
                "audio_duration": _r(audio_duration),
                "model": self._models.tts,
            },
            ts=ts,
        )
        if env is None and turn.degraded != turn.published_degraded:
            # A later segment was degraded but its block is a repeat, so nothing would
            # have carried the correction. Publish the flag on its own — never a bare
            # envelope, because the only reason to get here is that the flag moved.
            env = self._turn_envelope(turn, {}, ts=ts)
        return env

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

        ``degraded`` rides along with the totals, and is *also* published whenever it
        changes without them — a second LLM invocation or a later TTS segment can be the
        first thing chaos touched in a turn whose totals already shipped, and an
        agent-initiated turn (the greeting) has no ``eou`` and so never gets totals at
        all. Tying the flag to the totals would leave that turn painted clean however
        badly chaos degraded it, which the schema forbids: a turn is degraded if any
        injection was applied to any of its stages, partial waterfall or not.
        """
        payload: dict[str, Any] = {"turn_id": turn.turn_id, **fields}
        latency = turn.response_latency
        if latency is not None and latency != turn.total_response_latency:
            turn.total_response_latency = latency
            payload["total_response_latency"] = latency
            payload["degraded"] = turn.degraded
            turn.published_degraded = turn.degraded
        elif turn.degraded != turn.published_degraded:
            payload["degraded"] = turn.degraded
            turn.published_degraded = turn.degraded
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
            llm_usage={model: (p, c) for model, (p, c) in self._llm_usage.items()},
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

    # ---------------------------------------------------------- fleet-level summary

    def call_summary(
        self,
        *,
        call_id: str,
        entry: str,
        room: str,
        close_reason: str,
        started_at: float,
        ended_at: float,
    ) -> dict[str, Any]:
        """One flat, JSON-serialisable record describing the whole call.

        This exists because KV is not the only place a call has to leave a trace. The
        debrief upload can fail — a redeploy mid-call, an unreachable Worker, a bad
        token — and when it does, the *only* surviving evidence that a call happened is
        the worker's stdout, which LiveKit Cloud already streams as structured JSON
        (``lk agent logs``). Emitting this as a single line under one greppable marker
        makes fleet latency, cost and failure rates recoverable from logs alone.

        Deliberately flat and deliberately not an envelope: it is not part of the v1
        wire schema, nothing merges it, and a log aggregator wants scalars it can
        aggregate, not a nested waterfall.

        ``room`` is redacted here as well as by the caller. Redaction is idempotent and
        this is the last gate before a room name reaches a log aggregator, so it costs
        one regex pass to make the guarantee unconditional.
        """
        latencies = [
            t.total_response_latency
            for t in self._turns.values()
            if t.total_response_latency is not None
        ]
        return {
            "call_id": call_id,
            "entry": entry,
            "room": redact_room_name(room),
            "close_reason": close_reason,
            "duration_seconds": _r(ended_at - started_at),
            "turns": len(self._turns),
            "turns_completed": len(latencies),
            "latency_p50_ms": percentile_ms(latencies, 50),
            "latency_p95_ms": percentile_ms(latencies, 95),
            "degraded_turns": sum(1 for t in self._turns.values() if t.degraded),
            "barge_ins": sum(1 for t in self._turns.values() if t.barge_in),
            "prompt_tokens": self._prompt_tokens,
            "completion_tokens": self._completion_tokens,
            "stt_seconds": _r(self._stt_audio_seconds),
            "tts_characters": self._tts_characters,
            "est_cost_usd": self.estimated_cost_usd(),
        }

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
                # Attributed to the model the block names, so a replayed call that
                # straddled a chaos swap is priced the way the live call was.
                self._add_llm_tokens(
                    payload["llm"].get("model", self._models.llm),
                    payload["llm"].get("prompt_tokens", 0) - previous.get("prompt_tokens", 0),
                    payload["llm"].get("completion_tokens", 0)
                    - previous.get("completion_tokens", 0),
                )
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
                turn.degraded = turn.published_degraded = payload["degraded"]
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
            lines.append(
                "That turn ran with chaos mode degrading the pipeline — injected "
                "latency, a heavier model, or a clamped answer length."
            )

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


#: The token a log aggregator greps for to find per-call summaries. The line is
#: ``call_summary {"call_id":...}`` — marker, one space, then compact JSON, so
#: ``grep call_summary | cut -d' ' -f2- | jq`` works on raw text and
#: ``select(.message | startswith("call_summary"))`` works on LiveKit's own JSON.
CALL_SUMMARY_MARKER = "call_summary"


def percentile_ms(latencies: list[float], p: float) -> float | None:
    """Nearest-rank percentile of a list of seconds, reported in milliseconds.

    Nearest rank rather than interpolation: ``rank = ceil(p/100 × n)``, 1-indexed and
    clamped into range, so every reported value is a latency some turn actually had.
    On calls of five or ten turns — which is most of them — an interpolated p95 is a
    number that never happened, and "the slowest turn was 2.1 seconds" is a claim an
    operator can act on in a way that "2.03 seconds interpolated" is not.

    Returns ``None`` for an empty list. A call that completed no turns has no p50; zero
    would be a lie that averages beautifully across a fleet.
    """
    if not latencies:
        return None
    ordered = sorted(latencies)
    rank = min(max(math.ceil(p / 100 * len(ordered)), 1), len(ordered))
    return _r(ordered[rank - 1] * 1000, 1)


def log_call_summary(summary: dict[str, Any], *, log: logging.Logger | None = None) -> str:
    """Emit the per-call summary as exactly one parseable log line, and return it.

    Separators are compact and the line is single-line by construction: log shippers
    split on newlines, and a pretty-printed summary would arrive as fifteen unrelated
    records. ``ensure_ascii`` stays on so the line survives a pipe with no locale.
    """
    line = json.dumps(summary, separators=(",", ":"))
    (log or logger).info("%s %s", CALL_SUMMARY_MARKER, line)
    return line


@dataclass(frozen=True)
class _Send:
    """One queued data-channel write.

    An empty ``destinations`` broadcasts to the room, which is what every live envelope
    does. A populated one addresses named participants only — see
    :meth:`TelemetryPublisher.snapshot_to`.
    """

    env: dict[str, Any]
    destinations: tuple[str, ...] = ()


class TelemetryPublisher:
    """Serialises envelopes onto the room data channel, in order, and records them.

    Publishing is async but the SDK's event callbacks are synchronous, so envelopes go
    through a queue drained by one task. That keeps the wire order identical to the
    emission order, which the cockpit relies on when merging partial turns.
    """

    def __init__(self, room: Any | None) -> None:
        self._room = room
        self._queue: asyncio.Queue[_Send] = asyncio.Queue()
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
        self._queue.put_nowait(_Send(env))

    def emit_all(self, envelopes: list[dict[str, Any]]) -> None:
        for env in envelopes:
            self.emit(env)

    def snapshot_to(self, identity: str) -> int:
        """Replay the call so far to one participant, and return how many envelopes.

        A cockpit that joins mid-call has missed every envelope published before it
        arrived — the data channel does not retain them — so it would render an empty
        dashboard until the next turn. Re-publishing the log catches it up.

        The replay is *addressed*, never broadcast: the caller's own cockpit has already
        merged these envelopes, and a second copy of the state and usage streams would
        corrupt its timeline (usage totals are absolute, but state transitions and
        interruptions are events, and it would count them twice).

        Ordering is exact because the copies go through the same queue as live traffic:
        anything emitted after this call is queued behind the replay, so the observer
        sees the call in the order it happened and then joins the live stream. Nothing
        is appended to :attr:`messages` — the debrief records what the call *emitted*,
        not how many times it was transmitted.
        """
        replay = tuple(self._messages)
        for env in replay:
            self._queue.put_nowait(_Send(env, (identity,)))
        logger.info("replaying %d envelopes to observer %s", len(replay), identity)
        return len(replay)

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
            send = await self._queue.get()
            try:
                await self._publish(send)
            except Exception:
                logger.exception(
                    "failed to publish telemetry envelope type=%s", send.env.get("type")
                )
            finally:
                self._queue.task_done()

    async def _publish(self, send: _Send) -> None:
        if self._room is None:
            logger.debug("cockpit %s %s", send.env["type"], send.env["payload"])
            return
        await self._room.local_participant.publish_data(
            encode_envelope(send.env),
            reliable=True,
            topic=TELEMETRY_TOPIC,
            destination_identities=list(send.destinations),
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


# --------------------------------------------------------------- debrief upload
#
# Timing here is not a style choice, it is arithmetic against the SDK.
#
# `livekit.agents.worker.WorkerOptions.shutdown_process_timeout` is 10.0 s, enforced in
# `ipc/supervised_proc.py` by `asyncio.wait_for(self._shutdown_ack_fut, ...)` followed by
# a dump signal and a hard kill. Everything a job does on the way out — including
# `publisher.aclose()` draining the data channel — comes out of that one budget. The
# original 10.0 s client timeout therefore could not fail gracefully: a slow upload was
# killed mid-flight and left no log line at all, which is precisely how the production
# failure went unexplained.
#
# 4.0 s leaves room for the drain and still logs a named warning when it is exceeded.

#: How often an in-progress call posts a checkpoint. A call that dies mid-flight (SIP
#: drop, worker redeploy, OOM) loses at most this much, instead of losing everything.
CHECKPOINT_SECONDS = 15.0

#: Checkpoints are best-effort and run *during* a live call, so they must never sit on
#: the event loop. Three seconds is longer than a healthy Worker round-trip and shorter
#: than anything a caller would notice.
CHECKPOINT_TIMEOUT = 3.0

#: The final upload's client timeout. Must fit inside the 10 s job-shutdown budget
#: alongside `publisher.aclose()` — see the note above.
FINAL_TIMEOUT = 4.0


class _PostFn(Protocol):
    """One debrief HTTP request. Raises on failure; returns the decoded JSON body.

    Injected so the uploader can be tested with no network and no real timers.
    """

    async def __call__(
        self,
        *,
        method: str,
        url: str,
        token: str | None,
        body: dict[str, Any],
        timeout: float,
    ) -> dict[str, Any]: ...


class _MessageLog(Protocol):
    """The slice of :class:`TelemetryPublisher` the uploader reads."""

    @property
    def messages(self) -> list[dict[str, Any]]: ...


async def _http_debrief(
    *,
    method: str,
    url: str,
    token: str | None,
    body: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    """Perform one debrief request. Raises on any failure — the caller decides.

    ``httpx`` stays imported lazily (it is only needed at the end of a call, and the
    import is cached after the first one), and the response is decoded defensively: the
    checkpoint endpoint answers ``{"ok": true}`` with no share URL, and a future Worker
    answering ``204`` with no body must not look like a failure.
    """
    import httpx

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.request(method, url, json=body, headers=headers)
        response.raise_for_status()
        content = response.content
    if not content:
        return {}
    try:
        decoded = json.loads(content)
    except ValueError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _is_loopback_host(hostname: str | None) -> bool:
    """True for a host that never leaves this machine, by address rather than by name.

    ``urlsplit().hostname`` already strips IPv6 brackets and lowercases, so parsing the
    address covers every spelling of loopback (``127.0.0.1``, ``127.0.0.2``, ``::1``,
    ``0:0:0:0:0:0:0:1``) that a string set would have to enumerate — and got wrong once:
    a bracketed ``[::1]`` entry in the old set could never match anything.
    """
    if not hostname:
        return False
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def checked_debrief_url(url: str | None) -> str | None:
    """The debrief endpoint, or ``None`` if it is not somewhere a secret may be sent.

    Every debrief request carries ``DEBRIEF_TOKEN`` as a bearer header, and that token is
    what separates a trusted agent record from an anonymous browser one — a leaked copy
    lets anyone forge fleet metrics. ``DEBRIEF_URL`` is operator-supplied, so a typo, a
    copy-pasted ``http://`` from a doc, or a stale staging value is enough to put it on
    the wire in clear text. Refusing is the right failure: a debrief is a nice-to-have
    (the demo works without a replay link) and the token is not.

    Loopback is exempt because ``wrangler dev`` serves plain HTTP on localhost and there
    is no network for anyone to be on. Anything else must be TLS.
    """
    if not url:
        return None

    # urlsplit raises on malformed input (`https://[::1` → "Invalid IPv6 URL"), and this
    # runs inside a connected entrypoint: an unhandled typo here would abort every call,
    # not just the upload. A URL that cannot be parsed gets the same treatment as one
    # with the wrong scheme — refused, loudly, while the call itself carries on.
    try:
        parsed = urlsplit(url)
        if parsed.scheme == "https":
            return url
        if parsed.scheme == "http" and _is_loopback_host(parsed.hostname):
            return url
        rejected = parsed.scheme or url
    except ValueError:
        rejected = url

    logger.error(
        "DEBRIEF_URL is %r, which would send DEBRIEF_TOKEN in clear text or cannot be "
        "parsed; debrief upload disabled. Use https:// (or http:// on localhost for dev).",
        rejected,
    )
    return None


def _is_timeout(exc: BaseException) -> bool:
    """True for a timeout from either asyncio or httpx.

    Matched by class name rather than by importing ``httpx.TimeoutException`` so this
    stays honest for an injected fake and keeps the httpx import lazy.
    """
    if isinstance(exc, TimeoutError):  # asyncio.TimeoutError is this since 3.11
        return True
    return any(cls.__name__ == "TimeoutException" for cls in type(exc).__mro__)


def _debrief_body(
    *,
    call_id: str,
    meta: dict[str, Any],
    messages: list[dict[str, Any]],
    ended_at: float,
    in_progress: bool,
) -> dict[str, Any]:
    """Build the HTTP debrief body shared by checkpoints and the final upload.

    ``in_progress`` lives here and nowhere else: it is a property of the *upload*, not
    of the call, and ``docs/TELEMETRY-SCHEMA.md`` has no envelope field for it.

    ``messages`` is copied. The list keeps growing while the request is in flight — an
    observer joining, a straggler metric — and serialising a list that mutates under the
    encoder is a ``RuntimeError`` on a path whose entire job is not to raise.
    """
    return {
        "call_id": call_id,
        "meta": meta,
        "ended_at": ended_at,
        "messages": list(messages),
        "in_progress": in_progress,
    }


async def _upload_final(
    post: _PostFn,
    *,
    url: str,
    token: str | None,
    body: dict[str, Any],
    timeout: float,
) -> tuple[bool, str | None]:
    """Run the final POST, swallowing every failure. Returns ``(succeeded, share_url)``.

    The success flag is separate from the URL because they are different questions: a
    Worker that stored the call but answered without a ``url`` field still means "do not
    retry", while a timeout means "the shutdown path should try again".
    """
    try:
        data = await post(method="POST", url=url, token=token, body=body, timeout=timeout)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - the call already ended; nothing here is worth raising for
        if _is_timeout(exc):
            logger.warning(
                "debrief upload exceeded FINAL_TIMEOUT of %.1fs and was abandoned; "
                "the job-shutdown budget is %.1fs total",
                timeout,
                10.0,
            )
        else:
            logger.warning("debrief upload failed: %s", exc)
        return False, None
    share_url = data.get("url")
    logger.info("debrief stored: %s", share_url)
    return True, share_url


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

    Kept as a standalone entry point (the one-shot upload, no checkpoints, no
    once-only bookkeeping) even though :class:`DebriefUploader` is what the agent runs.
    """
    endpoint = checked_debrief_url(url)
    if not endpoint:
        # Either unset, or refused for its scheme — `checked_debrief_url` has already
        # said which, at error level, so this line stays about the envelopes.
        logger.info("no debrief endpoint; skipping debrief upload (%d envelopes)", len(messages))
        return None

    _, share_url = await _upload_final(
        _http_debrief,
        url=endpoint,
        token=token,
        body=_debrief_body(
            call_id=call_id,
            meta=meta,
            messages=messages,
            ended_at=ended_at,
            in_progress=False,
        ),
        timeout=FINAL_TIMEOUT,
    )
    return share_url


class DebriefUploader:
    """Keeps a durable record of a call, during it and at the end of it.

    Two problems, one owner.

    *Durability.* A debrief posted only at job shutdown is posted only when the ROOM
    closes, and a room stays open while any participant is in it — an observer cockpit,
    an abandoned browser tab. Observed in production: the session closed on a SIP hangup
    and eleven minutes later the job was still alive, holding an unposted debrief, one
    redeploy away from losing the call entirely. Checkpoints every
    :data:`CHECKPOINT_SECONDS` bound that loss to fifteen seconds, and give Grafana a
    view of calls that are still in progress.

    *Exactly-once-ish.* The final body is uploaded once per call. The Worker upserts by
    ``call_id`` so a duplicate would be harmless, but a duplicate POST also mints a
    second share id and costs a second slice of the shutdown budget. The guard is
    therefore "once on SUCCESS": a session-close flush that failed is retried by the
    job-shutdown path, which is the belt to its braces.

    Everything is injectable — ``post``, ``sleep``, ``clock`` — so the whole class is
    testable with no network and no real timers.
    """

    def __init__(
        self,
        *,
        url: str | None,
        token: str | None,
        call_id: str,
        meta: dict[str, Any],
        publisher: _MessageLog,
        post: _PostFn | None = None,
        sleep: Callable[[float], Any] | None = None,
        clock: Callable[[], float] | None = None,
        interval: float = CHECKPOINT_SECONDS,
        checkpoint_timeout: float = CHECKPOINT_TIMEOUT,
        final_timeout: float = FINAL_TIMEOUT,
    ) -> None:
        # Rejected here rather than at each request: an endpoint that cannot be given
        # the bearer token is indistinguishable from no endpoint at all, and every
        # `if not self._url` guard below already means "no debrief this call".
        self._url = checked_debrief_url(url)
        self._token = token
        self._call_id = call_id
        self._meta = meta
        self._publisher = publisher
        self._post: _PostFn = post or _http_debrief
        self._sleep = sleep or asyncio.sleep
        self._clock = clock or time.time
        self._interval = interval
        self._checkpoint_timeout = checkpoint_timeout
        self._final_timeout = final_timeout
        self._task: asyncio.Task[None] | None = None
        # -1, not 0: the first tick must always fire, even on a call that has somehow
        # emitted nothing, because the point of the first checkpoint is to tell the
        # Worker this call EXISTS.
        self._checkpointed = -1
        self._final_lock = asyncio.Lock()
        self._final_done = False
        self._share_url: str | None = None
        self.checkpoints = 0
        """How many checkpoints were actually uploaded. Read by tests and logging."""

    @property
    def final_uploaded(self) -> bool:
        """True once the final body has been stored; the retry guard reads this."""
        return self._final_done

    @property
    def share_url(self) -> str | None:
        return self._share_url

    # ---------------------------------------------------------------- lifecycle

    def start(self) -> None:
        """Begin posting checkpoints. Idempotent, and a no-op without an endpoint."""
        if self._task is not None:
            return
        if not self._url:
            logger.info("DEBRIEF_URL unset; in-call checkpoints disabled")
            return
        self._task = asyncio.create_task(self._loop(), name="cockpit-debrief-checkpoint")

    async def aclose(self) -> None:
        """Stop the checkpoint task and wait for it to be gone.

        Awaited rather than fired and forgotten: :meth:`finalize` calls this first so a
        checkpoint cannot still be in flight when the final POST lands. The Worker keys
        checkpoints by ``call_id`` and deletes them on the final POST, so a checkpoint
        that arrived *after* would resurrect the call as permanently in-progress.
        """
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def _loop(self) -> None:
        # Checkpoint FIRST, then settle into the interval.
        #
        # Sleeping first left every call unrecoverable for its opening fifteen
        # seconds, and short calls are exactly the ones this exists to save: a
        # ten-second call whose final POST times out had no checkpoint to fall
        # back on, and its only remaining hope was the job-shutdown callback —
        # which is deferred indefinitely by precisely the abandoned-room
        # condition that motivated this whole change. The first checkpoint is
        # the cheapest one there is, too: a greeting and a call_meta envelope.
        await self.checkpoint()
        while True:
            await self._sleep(self._interval)
            await self.checkpoint()

    # --------------------------------------------------------------- checkpoints

    async def checkpoint(self) -> bool:
        """PUT the call so far. Returns whether anything was actually uploaded.

        Skipped when the envelope count has not moved: a call sitting silent between
        turns has nothing new to say, and re-uploading the same body every fifteen
        seconds would spend the Worker's write budget on nothing.

        Never raises. A checkpoint is an optimisation; a call must not end because one
        failed, and the failure is deliberately logged at warning rather than error —
        the final upload is still to come and is the one that matters.
        """
        if not self._url:
            return False
        count = len(self._publisher.messages)
        if count == self._checkpointed:
            logger.debug("debrief checkpoint skipped: no new envelopes (%d)", count)
            return False
        try:
            await self._post(
                method="PUT",
                url=self._url,
                token=self._token,
                body=_debrief_body(
                    call_id=self._call_id,
                    meta=self._meta,
                    messages=self._publisher.messages,
                    ended_at=self._clock(),
                    in_progress=True,
                ),
                timeout=self._checkpoint_timeout,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a checkpoint must never break a live call
            logger.warning("debrief checkpoint failed (%d envelopes): %s", count, exc)
            return False
        self._checkpointed = count
        self.checkpoints += 1
        logger.debug("debrief checkpoint stored (%d envelopes)", count)
        return True

    # -------------------------------------------------------------- final upload

    async def finalize(self, *, ended_at: float) -> str | None:
        """Stop checkpointing and POST the finished call. Safe to call more than once.

        ``ended_at`` must be the time the SESSION closed, not the time the job did. They
        can be many minutes apart (an observer holding the room open), and taking the
        job's clock is what once stored a ten-second conversation as a 4376-second call.
        """
        await self.aclose()
        async with self._final_lock:
            if self._final_done:
                logger.debug("final debrief already uploaded for %s", self._call_id)
                return self._share_url
            if not self._url:
                # Unset, or refused for its scheme — `checked_debrief_url` logged which.
                logger.info(
                    "no debrief endpoint; skipping debrief upload (%d envelopes)",
                    len(self._publisher.messages),
                )
                self._final_done = True
                return None
            ok, share_url = await _upload_final(
                self._post,
                url=self._url,
                token=self._token,
                body=_debrief_body(
                    call_id=self._call_id,
                    meta=self._meta,
                    messages=self._publisher.messages,
                    ended_at=ended_at,
                    in_progress=False,
                ),
                timeout=self._final_timeout,
            )
            if not ok:
                # Left un-finalised on purpose: the job-shutdown path calls this again,
                # and the last checkpoint is still in KV meanwhile, so the call is not
                # invisible even if that retry never happens.
                return None
            self._final_done = True
            self._share_url = share_url
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

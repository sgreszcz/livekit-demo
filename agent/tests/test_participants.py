"""Tests for who the agent thinks it is on a call with.

A cockpit opened by an observer is an ordinary STANDARD participant — the same kind as
a browser caller — so identity is the only thing separating them. Getting that wrong is
not cosmetic: the entry classification reported in `call_meta` would describe the wrong
participant, and a SIP call watched by a browser observer would be labelled a browser
call. These tests pin the identity filter down, and cover the greeting text the session
opens with.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from livekit import rtc

import agent
from telemetry import is_observer

STANDARD = rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
SIP = rtc.ParticipantKind.PARTICIPANT_KIND_SIP
AGENT = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
CONNECTOR = rtc.ParticipantKind.PARTICIPANT_KIND_CONNECTOR


class FakeParticipant:
    def __init__(self, identity: str, kind: int = STANDARD) -> None:
        self.identity = identity
        self.kind = kind


class FakeRoom:
    """Just enough of `rtc.Room` for `wait_for_caller`: a registry and an emitter."""

    def __init__(self, participants: list[FakeParticipant] | None = None) -> None:
        self.remote_participants = {p.identity: p for p in participants or []}
        self._handlers: dict[str, list] = {}

    def on(self, event: str, callback) -> None:
        self._handlers.setdefault(event, []).append(callback)

    def off(self, event: str, callback) -> None:
        self._handlers.get(event, []).remove(callback)

    @property
    def handler_count(self) -> int:
        return sum(len(v) for v in self._handlers.values())

    def connect(self, participant: FakeParticipant, event: str = "participant_connected") -> None:
        self.remote_participants[participant.identity] = participant
        for callback in list(self._handlers.get(event, [])):
            callback(participant)


@contextmanager
def caplog_warnings(name: str = "glass-cockpit") -> Iterator[list[str]]:
    """Collect WARNING-and-above messages from the agent's logger."""
    messages: list[str] = []

    class _Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            messages.append(record.getMessage())

    handler = _Collect(level=logging.WARNING)
    log = logging.getLogger(name)
    previous = log.level
    log.setLevel(logging.WARNING)
    log.addHandler(handler)
    try:
        yield messages
    finally:
        log.removeHandler(handler)
        log.setLevel(previous)


# ------------------------------------------------------------------ classification


def test_observer_identities_are_recognised() -> None:
    assert is_observer("observer-7f3a")
    assert not is_observer("caller-7f3a")
    assert not is_observer("sip_+441234")
    assert not is_observer("")
    assert not is_observer(None)
    # A substring match would be a security-ish bug: only the prefix counts.
    assert not is_observer("not-an-observer-1")


@pytest.mark.parametrize(
    ("identity", "kind", "expected"),
    [
        ("caller-1", STANDARD, True),
        ("sip_+441234", SIP, True),
        ("connector-1", CONNECTOR, True),
        ("observer-1", STANDARD, False),
        ("agent-1", AGENT, False),
        # An observer arriving over SIP is still an observer.
        ("observer-1", SIP, False),
    ],
)
def test_is_caller(identity: str, kind: int, expected: bool) -> None:
    assert agent.is_caller(FakeParticipant(identity, kind)) is expected


def test_classify_entry() -> None:
    assert agent.classify_entry(FakeParticipant("sip_+441234", SIP)) == "sip"
    assert agent.classify_entry(FakeParticipant("caller-1", STANDARD)) == "browser"


# -------------------------------------------------------------- waiting for a caller


@pytest.mark.asyncio
async def test_returns_a_caller_already_in_the_room() -> None:
    room = FakeRoom([FakeParticipant("caller-1")])
    participant = await asyncio.wait_for(agent.wait_for_caller(room), timeout=1.0)
    assert participant.identity == "caller-1"
    # Resolved without subscribing, so nothing is left registered on the room.
    assert room.handler_count == 0


@pytest.mark.asyncio
async def test_ignores_an_observer_already_in_the_room() -> None:
    room = FakeRoom([FakeParticipant("observer-1")])
    task = asyncio.create_task(agent.wait_for_caller(room))
    await asyncio.sleep(0)
    assert not task.done()

    room.connect(FakeParticipant("caller-1"))
    participant = await asyncio.wait_for(task, timeout=1.0)
    assert participant.identity == "caller-1"


@pytest.mark.asyncio
async def test_an_observer_joining_first_does_not_resolve_the_wait() -> None:
    """The regression this guard exists for: `wait_for_participant` filters on kind,
    and would have handed back the observer and classified the call against it."""
    room = FakeRoom()
    task = asyncio.create_task(agent.wait_for_caller(room))
    await asyncio.sleep(0)

    room.connect(FakeParticipant("observer-1"))
    room.connect(FakeParticipant("observer-2"))
    await asyncio.sleep(0)
    assert not task.done()

    room.connect(FakeParticipant("sip_+441234", SIP))
    participant = await asyncio.wait_for(task, timeout=1.0)
    assert agent.classify_entry(participant) == "sip"


@pytest.mark.asyncio
async def test_resolves_on_participant_active_too() -> None:
    """Either event can come first depending on participant kind, so both are watched."""
    room = FakeRoom()
    task = asyncio.create_task(agent.wait_for_caller(room))
    await asyncio.sleep(0)

    room.connect(FakeParticipant("caller-1"), event="participant_active")
    participant = await asyncio.wait_for(task, timeout=1.0)
    assert participant.identity == "caller-1"


@pytest.mark.asyncio
async def test_unsubscribes_once_resolved() -> None:
    """A stale handler on a long call would keep firing for every later join."""
    room = FakeRoom()
    task = asyncio.create_task(agent.wait_for_caller(room))
    await asyncio.sleep(0)
    assert room.handler_count == 2

    room.connect(FakeParticipant("caller-1"))
    await asyncio.wait_for(task, timeout=1.0)
    assert room.handler_count == 0

    # A late observer must not blow up on a resolved future.
    room.connect(FakeParticipant("observer-1"))


# ------------------------------------------------------------------------ greeting


def test_greeting_is_fixed_text_needing_no_model() -> None:
    """The whole point of `say()` over `generate_reply()`: nothing to think about."""
    assert isinstance(agent.GREETING, str)
    assert agent.GREETING.startswith("Welcome to Glass Cockpit.")
    assert agent.GREETING.endswith("Ask me anything, or ask how the call quality is.")


def test_greeting_stays_short_enough_to_be_one_breath() -> None:
    """The first thing every caller hears is on the critical path of the one number this
    demo exists to show. An observation notice was tried here and removed: the disclosure
    belongs on the web page, which costs no audio. Guard the length so it does not creep
    back in a word at a time."""
    assert len(agent.GREETING) < 240
    assert "dashboard" in agent.GREETING


def test_instructions_recap_matches_what_the_greeting_actually_said() -> None:
    """The persona is told what it already said. If the two drift, the agent contradicts
    its own opening line the first time a caller asks who can see the dashboard."""
    instructions = " ".join(agent.INSTRUCTIONS.split())
    greeting = " ".join(agent.GREETING.split())
    assert "streaming to the dashboard" in greeting
    assert "streaming to the dashboard" in instructions


def test_instructions_tell_the_persona_to_answer_honestly_if_asked() -> None:
    """The greeting no longer volunteers that the call can be watched, so the honest
    answer has to be available the moment somebody asks for it. This costs nothing at
    runtime — it is prompt text, not spoken words."""
    instructions = " ".join(agent.INSTRUCTIONS.split())
    assert "reachable by anyone with the link" in instructions
    assert "do not volunteer it unprompted" in instructions


# ------------------------------------------------------- entry cross-check (async)


def test_close_reason_reports_the_wire_value() -> None:
    """`CloseReason` is a str Enum, so str() gives `CloseReason.X` — the wrong thing to
    group a fleet by."""
    from livekit.agents import CloseReason

    assert agent._close_reason(CloseReason.PARTICIPANT_DISCONNECTED) == "participant_disconnected"
    assert agent._close_reason(CloseReason.JOB_SHUTDOWN) == "job_shutdown"
    assert agent._close_reason("already_a_string") == "already_a_string"


@pytest.mark.asyncio
async def test_entry_cross_check_never_gates_the_call() -> None:
    """The regression that lost calls: this wait used to be awaited inline, and it has no
    timeout, so a caller who hung up mid-connect meant the shutdown callback registered
    after it was never registered at all. It is a background diagnostic now — it may hang
    forever, and cancelling it must be silent."""
    room = FakeRoom()
    task = asyncio.create_task(agent._warn_on_entry_mismatch(room, "sip"))
    await asyncio.sleep(0)
    assert not task.done()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_entry_cross_check_is_silent_when_the_room_name_was_right() -> None:
    room = FakeRoom([FakeParticipant("sip_+441234", SIP)])
    with caplog_warnings() as warnings:
        await asyncio.wait_for(agent._warn_on_entry_mismatch(room, "sip"), timeout=1.0)
    assert warnings == []


@pytest.mark.asyncio
async def test_entry_cross_check_warns_when_the_room_name_disagrees() -> None:
    """The room-name classification stays authoritative — this only says so out loud, so
    a changed naming convention shows up in the logs instead of silently mislabelling."""
    room = FakeRoom([FakeParticipant("caller-1", STANDARD)])
    with caplog_warnings() as warnings:
        await asyncio.wait_for(agent._warn_on_entry_mismatch(room, "sip"), timeout=1.0)
    assert len(warnings) == 1
    assert "entry mismatch" in warnings[0]


def test_instructions_tell_the_persona_it_has_already_greeted() -> None:
    """Otherwise the model opens its first real reply with a second hello."""
    instructions = " ".join(agent.INSTRUCTIONS.split())
    assert "You have already greeted the visitor." in instructions
    assert "Do not greet them again" in instructions
    # The old prompt asked the model to compose the opener; say() does that now.
    assert "Open the call by greeting" not in instructions

"""Tests for the keep-warm ping: the job this agent exists to refuse.

LiveKit does not answer an inbound SIP call until an agent joins the room, and LiveKit
Cloud stops an idle agent container. Measured on the live demo number that was twelve
seconds of ringing cold against three warm, essentially all of it container boot. The fix
is a scheduled room creation (worker/src/warmup.ts) whose only job is to wake the
container, and the agent's half is to recognise it and cost nothing.

"Cost nothing" is the entire specification, so that is what these tests pin:

  * The dispatch offer is REFUSED, not served — no job process, no metered session.
  * It is refused with ``terminate=True``, so a warm-up is dropped rather than re-offered
    around the fleet. A warm-up that got retried every ten minutes would be a cost bug
    considerably more expensive than the cold starts it was added to prevent.
  * If one lands in the entrypoint anyway, it exits before a single expensive object is
    constructed — and it exits by calling ``ctx.shutdown()``, never by returning. See
    ``test_entrypoint_shuts_down_rather_than_returning`` for why that distinction is the
    most important line in the file.
  * A real call is entirely unaffected by all of the above.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

import pytest

import agent


class FakeRoomInfo:
    """The `.room` of a `models.Room` / `agent.Job` — only the name is ever read."""

    def __init__(self, name: str) -> None:
        self.name = name


class FakeJob:
    def __init__(self, name: str) -> None:
        self.room = FakeRoomInfo(name)
        self.id = "job-under-test"


class FakeJobRequest:
    """Just enough of `JobRequest` to record which way the offer was answered."""

    def __init__(self, name: str) -> None:
        self.room = FakeRoomInfo(name)
        self.accepted = False
        # Every reject, with the `terminate` flag it was given. A list rather than a
        # flag so a double-answer would be visible instead of averaged away.
        self.rejects: list[bool] = []

    async def accept(self, **_kwargs: object) -> None:
        self.accepted = True

    async def reject(self, *, terminate: bool = True) -> None:
        self.rejects.append(terminate)


class Tripwire:
    """Stands in for an expensive constructor and fails the test if anyone calls it.

    The warm-up path is defined by what it does NOT do, and asserting that by inspecting
    the code is how a future edit quietly reintroduces an AgentSession. This makes the
    absence executable.
    """

    def __init__(self, label: str) -> None:
        self.label = label

    def __call__(self, *args: object, **kwargs: object) -> object:
        raise AssertionError(f"warm-up path constructed {self.label}")


class FakeJobContext:
    """Just enough of `JobContext` for the entrypoint's first few lines."""

    def __init__(self, name: str) -> None:
        self.job = FakeJob(name)
        self.room = FakeRoomInfo(name)
        self.connected = False
        self.shutdown_reasons: list[str] = []

    def shutdown(self, reason: str = "user requested") -> None:
        self.shutdown_reasons.append(reason)

    async def connect(self) -> None:
        self.connected = True


@contextmanager
def tripwired(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Make every expensive thing the entrypoint builds explode on construction.

    ``ChaosController`` is first in the entrypoint body, so it is the one that actually
    fires on the normal path; the other two are here so that a reordering of those lines
    cannot silently turn this into a test of nothing.
    """
    monkeypatch.setattr(agent, "ChaosController", Tripwire("a ChaosController"))
    monkeypatch.setattr(agent, "TelemetryPublisher", Tripwire("a TelemetryPublisher"))
    monkeypatch.setattr(agent, "AgentSession", Tripwire("an AgentSession"))
    monkeypatch.setattr(agent, "DebriefUploader", Tripwire("a DebriefUploader"))
    yield


@contextmanager
def caplog_info(name: str = "glass-cockpit") -> Iterator[list[str]]:
    """Collect formatted INFO records from the agent logger."""
    records: list[str] = []

    class Collector(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record.getMessage())

    logger = logging.getLogger(name)
    handler = Collector(level=logging.INFO)
    previous = logger.level
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    try:
        yield records
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous)


# The two room shapes a real call arrives as, and they are the reason the warm-up prefix
# is `warmup-` and not, say, `cockpit-warmup-`: neither of these may ever be mistaken for
# a ping, and a ping may never be mistaken for either.
REAL_CALL_ROOMS = [
    "sip-cockpit-_+447700900123_BXhCPPSrr57t",
    "cockpit-Ab3xQ9zK2mNp7RtY",
]


class TestIsWarmupRoom:
    @pytest.mark.parametrize("name", ["warmup-abc", "warmup-", "warmup-0123456789abcdef"])
    def test_recognises_the_prefix(self, name: str) -> None:
        assert agent.is_warmup_room(name)

    @pytest.mark.parametrize("name", REAL_CALL_ROOMS)
    def test_a_real_call_is_not_a_warm_up(self, name: str) -> None:
        assert not agent.is_warmup_room(name)

    def test_the_prefix_must_lead(self) -> None:
        """A room merely CONTAINING the word is a normal room. Prefix, not substring."""
        assert not agent.is_warmup_room("cockpit-warmup-abc")
        assert not agent.is_warmup_room("sip-cockpit-_+447700900123_warmup")

    def test_the_prefix_is_exported(self) -> None:
        """The worker mints names against this exact string — see worker/src/warmup.ts."""
        assert agent.WARMUP_ROOM_PREFIX == "warmup-"
        assert agent.is_warmup_room(f"{agent.WARMUP_ROOM_PREFIX}whatever")


class TestOnRequest:
    @pytest.mark.asyncio
    async def test_rejects_a_warm_up(self) -> None:
        req = FakeJobRequest("warmup-0123456789abcdef")
        await agent.on_request(req)
        assert req.rejects == [True]
        assert not req.accepted

    @pytest.mark.asyncio
    async def test_rejects_with_terminate_so_it_is_never_re_offered(self) -> None:
        """The anti-retry guarantee, and the reason this is safe to run on a cron.

        ``terminate=True`` is sent as ``availability.terminate``: the SDK documents it as
        "the job will not be assigned to another worker". Without it — which is what the
        worker's own fallback reject uses when a request handler answers nothing — every
        ping would be offered around the fleet in turn.
        """
        req = FakeJobRequest("warmup-deadbeef")
        await agent.on_request(req)
        assert req.rejects == [True], "a warm-up must be terminated, not re-offered"

    @pytest.mark.parametrize("name", REAL_CALL_ROOMS)
    @pytest.mark.asyncio
    async def test_accepts_a_real_call(self, name: str) -> None:
        """Supplying on_request REPLACES the framework's accept-everything default, so
        the accept branch is load-bearing: losing it would drop every inbound call."""
        req = FakeJobRequest(name)
        await agent.on_request(req)
        assert req.accepted
        assert req.rejects == []

    @pytest.mark.asyncio
    async def test_an_unrecognised_room_is_still_accepted(self) -> None:
        """`python agent.py console` and hand-made rooms are not warm-ups. Only the
        warm-up prefix is refused; everything else is served."""
        req = FakeJobRequest("some-other-room")
        await agent.on_request(req)
        assert req.accepted

    @pytest.mark.asyncio
    async def test_logs_one_line_per_ping(self) -> None:
        with caplog_info() as records:
            await agent.on_request(FakeJobRequest("warmup-cafef00d"))
        matching = [line for line in records if "warm-up ping" in line]
        assert len(matching) == 1
        assert "warmup-cafef00d" in matching[0]


class TestEntrypointWarmUp:
    @pytest.mark.asyncio
    async def test_short_circuits_before_constructing_anything(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ctx = FakeJobContext("warmup-0123456789abcdef")
        with tripwired(monkeypatch):
            # Every expensive constructor is a tripwire; returning at all is the assertion.
            await agent.entrypoint(ctx)
        assert not ctx.connected, "a warm-up must never connect to the room"

    @pytest.mark.asyncio
    async def test_entrypoint_shuts_down_rather_than_returning(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The single most important assertion here, and it looks like a formality.

        Returning from the entrypoint without having called ``connect()`` or
        ``shutdown()`` does NOT end the job. The SDK's job process awaits an internal
        shutdown future that only room disconnection, an explicit shutdown, a worker
        drain or a raised exception resolves; a clean return resolves none of them, so
        the process hangs forever holding a worker slot and reporting JS_RUNNING. That is
        a worse and quieter cost bug than the cold start this whole change exists to fix.

        ``shutdown()`` resolves it, the process exits 0, and exit code 0 is what the
        worker maps to JobStatus.SUCCESS. So this asserts the job ends, and ends clean.
        """
        ctx = FakeJobContext("warmup-0123456789abcdef")
        with tripwired(monkeypatch):
            await agent.entrypoint(ctx)
        assert ctx.shutdown_reasons == ["warmup"]

    @pytest.mark.asyncio
    async def test_logs_the_landed_ping(self, monkeypatch: pytest.MonkeyPatch) -> None:
        ctx = FakeJobContext("warmup-cafef00d")
        with tripwired(monkeypatch), caplog_info() as records:
            await agent.entrypoint(ctx)
        assert any("warm-up ping" in line and "warmup-cafef00d" in line for line in records)

    @pytest.mark.parametrize("name", REAL_CALL_ROOMS)
    @pytest.mark.asyncio
    async def test_a_real_call_is_not_short_circuited(
        self, name: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The other half, and the half that would fail silently.

        A guard that matched everything would make this suite's warm-up tests pass and
        the demo answer no calls at all. The tripwire firing is the proof that a real
        room name goes on to build the full pipeline: ``ChaosController`` is the first
        thing the entrypoint constructs, so reaching it means the guard let the call
        through.
        """
        ctx = FakeJobContext(name)
        with tripwired(monkeypatch):
            with pytest.raises(AssertionError, match="constructed a ChaosController"):
                await agent.entrypoint(ctx)
        assert ctx.shutdown_reasons == [], "a real call must never be shut down early"

    @pytest.mark.asyncio
    async def test_the_guard_reads_the_dispatched_job_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`ctx.job.room.name`, not `ctx.room.name`.

        The entrypoint runs before ``connect()``, and the SDK is explicit that some Room
        properties are not populated until it has. The dispatched job carries the name
        unconditionally, and it is the same field ``on_request`` reads — so the two
        guards cannot disagree about what room this is. Pinned by giving the two sources
        different values and checking which one decided.
        """
        ctx = FakeJobContext("cockpit-not-a-warm-up")
        ctx.job.room.name = "warmup-0123456789abcdef"
        with tripwired(monkeypatch):
            await agent.entrypoint(ctx)
        assert ctx.shutdown_reasons == ["warmup"]

"""Tests for the hard call-duration cap.

What the cap protects is money, not manners. Agent session minutes are metered, nothing
else in the system ends a call, and a room outlives the session it was created for — one
was seen still open 998 seconds after the SIP leg hung up. Without a cap the worst case
is unbounded, and the worst case is the one that shows up on the bill.

Two behaviours here are load-bearing and are pinned rather than merely exercised. The
hangup runs even when the session has already closed, because that is the zombie-room
case and it is invisible from the caller's side, so nothing else would notice it being
deleted. And a farewell that raises, or never finishes playing, must not swallow the
hangup with it — a cap that only fires when the TTS is healthy is not a cap.

Nothing here touches a real timer: sleeping is injected and hand-driven, so the countdown
runs in microseconds and the intervals it asked for are asserted directly.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import pytest

from duration import (
    CAP_TASK_NAME,
    ESCALATE_AFTER,
    FAREWELL,
    CallCap,
    spoken_duration,
    warning_text,
)

MAX_SECONDS = 300.0
WARN_SECONDS = 30.0


# ---------------------------------------------------------------------- doubles


class Ticker:
    """A hand-driven replacement for ``asyncio.sleep`` plus a clock that follows it.

    Copied from test_debrief.py and adapted for a countdown that ENDS: ``release`` lets
    the sleep the task is parked in return and hands control back, rather than requiring
    the task to park in another one — at the cap there is no next sleep to park in.
    """

    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start
        self.intervals: list[float] = []
        self._parked = asyncio.Event()
        self._release = asyncio.Event()

    async def sleep(self, seconds: float) -> None:
        self.intervals.append(seconds)
        self._parked.set()
        await self._release.wait()
        self._release.clear()
        self.now += seconds

    def time(self) -> float:
        return self.now

    async def release(self, timeout: float = 1.0) -> None:
        """Wait until the task is parked in a sleep, then let that sleep return."""
        await asyncio.wait_for(self._parked.wait(), timeout)
        self._parked.clear()
        self._release.set()
        await asyncio.sleep(0)

    async def parked(self, timeout: float = 1.0) -> None:
        """Wait until the task is parked in a sleep, WITHOUT releasing it — for the
        tests that cancel a countdown mid-sleep rather than letting it wake."""
        await asyncio.wait_for(self._parked.wait(), timeout)


@dataclass
class Spoken:
    """One utterance the cap asked for."""

    text: str
    allow_interruptions: bool


class FakeHandle:
    """The slice of ``SpeechHandle`` the cap uses: something to wait on."""

    def __init__(self, *, resolves: bool = True) -> None:
        self._resolves = resolves
        self.waited = False

    async def wait_for_playout(self) -> None:
        self.waited = True
        if self._resolves:
            return
        # A synthesis stream that never finishes — the case the farewell timeout exists
        # for. Parked on a future nobody will ever resolve.
        await asyncio.get_running_loop().create_future()


@dataclass
class FakeCall:
    """Records everything the cap does to a call: what it said, and whether it hung up.

    ``events`` is the ordering witness. Occurrence alone would pass against a cap that
    hung up first and said goodbye to a dead room afterwards.
    """

    closed: bool = False
    playout_resolves: bool = True
    #: Raised by the farewell (the uninterruptible utterance), if set.
    farewell_error: BaseException | None = None
    #: Raised by the warning (the interruptible utterance), if set.
    warning_error: BaseException | None = None
    #: Raised by the hangup itself, if set — the deletion API failing outright.
    hangup_error: BaseException | None = None
    spoken: list[Spoken] = field(default_factory=list)
    events: list[str] = field(default_factory=list)
    hangups: int = 0
    escalations: int = 0
    handles: list[FakeHandle] = field(default_factory=list)

    def say(self, text: str, *, allow_interruptions: bool) -> FakeHandle:
        self.spoken.append(Spoken(text, allow_interruptions))
        self.events.append("speak")
        if not allow_interruptions and self.farewell_error is not None:
            raise self.farewell_error
        if allow_interruptions and self.warning_error is not None:
            raise self.warning_error
        handle = FakeHandle(resolves=self.playout_resolves)
        self.handles.append(handle)
        return handle

    async def hangup(self) -> None:
        self.hangups += 1
        self.events.append("hangup")
        if self.hangup_error is not None:
            raise self.hangup_error

    def escalate(self) -> None:
        self.escalations += 1
        self.events.append("escalate")

    def is_closed(self) -> bool:
        return self.closed


def make_cap(
    call: FakeCall,
    ticker: Ticker,
    *,
    max_seconds: float = MAX_SECONDS,
    warn_seconds: float = WARN_SECONDS,
    farewell_timeout: float = 15.0,
    escalate: bool = False,
) -> CallCap:
    return CallCap(
        max_seconds=max_seconds,
        warn_seconds=warn_seconds,
        speak=call.say,
        hangup=call.hangup,
        session_closed=call.is_closed,
        sleep=ticker.sleep,
        farewell_timeout=farewell_timeout,
        escalate=call.escalate if escalate else None,
    )


# ------------------------------------------------------------------- happy path


@pytest.mark.asyncio
async def test_the_cap_warns_then_says_goodbye_then_hangs_up() -> None:
    """The whole contract in one call: two sleeps, two utterances, one hangup, in order."""
    call, ticker = FakeCall(), Ticker()
    cap = make_cap(call, ticker)

    task = cap.start()
    assert task is not None
    assert task.get_name() == CAP_TASK_NAME

    await ticker.release()  # the long leg expires — the warning is spoken
    await ticker.release()  # the warning window expires — farewell, then hangup
    await asyncio.wait_for(task, 1.0)

    assert ticker.intervals == [MAX_SECONDS - WARN_SECONDS, WARN_SECONDS]
    assert call.events == ["speak", "speak", "hangup"]
    warning, farewell = call.spoken
    assert warning.text == warning_text(max_seconds=MAX_SECONDS, warn_seconds=WARN_SECONDS)
    assert warning.allow_interruptions is True
    assert farewell.text == FAREWELL
    # A caller who barges in on the goodbye would start a turn that outlives the cap.
    assert farewell.allow_interruptions is False


@pytest.mark.asyncio
async def test_the_warning_is_not_waited_out() -> None:
    """The warning is spoken INSIDE the remaining window. Waiting for its playout would
    push the cap out by the length of the sentence, every call."""
    call, ticker = FakeCall(), Ticker()
    cap = make_cap(call, ticker)
    task = cap.start()

    await ticker.release()
    # Parked in the second sleep already, with the warning handle never awaited.
    assert [s.allow_interruptions for s in call.spoken] == [True]
    assert call.handles[0].waited is False

    await ticker.release()
    await asyncio.wait_for(task, 1.0)
    assert call.hangups == 1


@pytest.mark.asyncio
async def test_the_spoken_cap_matches_the_configured_one() -> None:
    """The number the caller hears is derived, never a second literal to drift from."""
    call, ticker = FakeCall(), Ticker()
    task = make_cap(call, ticker, max_seconds=120.0, warn_seconds=20.0).start()

    await ticker.release()
    assert "two minutes" in call.spoken[0].text
    assert "20 seconds left" in call.spoken[0].text

    await ticker.release()
    await asyncio.wait_for(task, 1.0)


@pytest.mark.parametrize(
    ("seconds", "expected"),
    [
        (300.0, "five minutes"),
        (60.0, "one minute"),
        (600.0, "ten minutes"),
        (420.0, "7 minutes"),
        # Not a whole number of minutes: seconds, rather than "one point five minutes".
        (90.0, "90 seconds"),
        (45.0, "45 seconds"),
    ],
)
def test_spoken_duration_reads_naturally(seconds: float, expected: str) -> None:
    assert spoken_duration(seconds) == expected


# ---------------------------------------------------------------------- disabled


@pytest.mark.parametrize("max_seconds", [0.0, -1.0])
@pytest.mark.asyncio
async def test_a_non_positive_cap_schedules_nothing(max_seconds: float) -> None:
    """The escape hatch for a deployment where session minutes are not the constraint.
    Disabled means nothing scheduled at all, not a countdown that quietly fires at zero."""
    call, ticker = FakeCall(), Ticker()
    cap = make_cap(call, ticker, max_seconds=max_seconds)

    assert cap.start() is None
    assert cap.task is None
    await asyncio.sleep(0)

    assert ticker.intervals == []
    assert call.spoken == []
    assert call.hangups == 0
    cap.cancel()  # safe having never started


# ------------------------------------------------------------- warning disabled


@pytest.mark.parametrize("warn_seconds", [0.0, -5.0, MAX_SECONDS, MAX_SECONDS + 60.0])
@pytest.mark.asyncio
async def test_a_useless_warning_window_collapses_to_one_sleep(warn_seconds: float) -> None:
    """No warning, or one that would have to be spoken before the call started: sleep
    once for the whole cap. The cap itself still fires — it never depends on the warning."""
    call, ticker = FakeCall(), Ticker()
    task = make_cap(call, ticker, warn_seconds=warn_seconds).start()

    await ticker.release()
    await asyncio.wait_for(task, 1.0)

    assert ticker.intervals == [MAX_SECONDS]
    assert call.events == ["speak", "hangup"]
    assert call.spoken[0].text == FAREWELL
    assert call.hangups == 1


# ------------------------------------------------------------------ zombie room


@pytest.mark.asyncio
async def test_a_zombie_room_is_deleted_even_though_the_session_has_closed() -> None:
    """The reason this module exists. The caller hung up, the session closed, and an
    observer or a forgotten tab is holding the room — and the meter — open. Nobody is
    there to say goodbye to, but the room still has to go."""
    call, ticker = FakeCall(closed=True), Ticker()
    task = make_cap(call, ticker).start()

    await ticker.release()
    await ticker.release()
    await asyncio.wait_for(task, 1.0)

    assert call.spoken == [], "spoke into a call that had already ended"
    assert call.events == ["hangup"]
    assert call.hangups == 1


@pytest.mark.asyncio
async def test_a_session_that_closes_during_the_warning_window_still_gets_hung_up() -> None:
    """The caller heard the warning and hung up rather than asking one more question.
    The warning stands, the goodbye is pointless, the room still gets deleted."""
    call, ticker = FakeCall(), Ticker()
    task = make_cap(call, ticker).start()

    await ticker.release()
    assert call.spoken[0].allow_interruptions is True
    call.closed = True

    await ticker.release()
    await asyncio.wait_for(task, 1.0)

    assert [s.text for s in call.spoken] == [
        warning_text(max_seconds=MAX_SECONDS, warn_seconds=WARN_SECONDS)
    ]
    assert call.events == ["speak", "hangup"]


# ------------------------------------------------------- the farewell cannot block


@pytest.mark.asyncio
async def test_a_farewell_that_raises_does_not_cancel_the_hangup() -> None:
    """The mutation guard. Speech is best-effort courtesy; the hangup is the product. A
    goodbye that throws — a closed TTS stream, a session torn down underneath us — must
    not be able to leave the room running."""
    call, ticker = FakeCall(farewell_error=RuntimeError("tts stream closed")), Ticker()
    task = make_cap(call, ticker).start()

    await ticker.release()
    await ticker.release()
    await asyncio.wait_for(task, 1.0)

    assert call.spoken[-1].text == FAREWELL
    assert call.events == ["speak", "speak", "hangup"]
    assert call.hangups == 1


@pytest.mark.asyncio
async def test_a_farewell_that_never_finishes_playing_is_bounded() -> None:
    """A synthesis stream that hangs would otherwise hold the hangup open forever, which
    is precisely the unbounded call this whole module is here to prevent."""
    call, ticker = FakeCall(playout_resolves=False), Ticker()
    task = make_cap(call, ticker, farewell_timeout=0.01).start()

    await ticker.release()
    await ticker.release()
    await asyncio.wait_for(task, 1.0)

    assert call.handles[-1].waited is True
    assert call.events == ["speak", "speak", "hangup"]
    assert call.hangups == 1


# --------------------------------------------------------------------- cancelling


@pytest.mark.asyncio
async def test_cancelling_before_the_cap_says_nothing_and_hangs_up_nothing() -> None:
    """The ordinary ending: the caller hung up first, so the shutdown path cancels a
    countdown that must not go on to speak or delete anything."""
    call, ticker = FakeCall(), Ticker()
    cap = make_cap(call, ticker)
    task = cap.start()
    assert task is not None

    await asyncio.sleep(0)  # let it park in the first sleep
    assert ticker.intervals == [MAX_SECONDS - WARN_SECONDS]

    cap.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert call.spoken == []
    assert call.hangups == 0


@pytest.mark.asyncio
async def test_cancel_is_idempotent_and_safe_after_the_cap_has_fired() -> None:
    call, ticker = FakeCall(), Ticker()
    cap = make_cap(call, ticker)
    task = cap.start()

    await ticker.release()
    await ticker.release()
    await asyncio.wait_for(task, 1.0)

    cap.cancel()
    cap.cancel()
    assert call.hangups == 1
    assert task is not None and task.done() and not task.cancelled()


@pytest.mark.asyncio
async def test_starting_twice_returns_the_same_countdown() -> None:
    """One cap per call. A second countdown would speak the farewell twice."""
    call, ticker = FakeCall(), Ticker()
    cap = make_cap(call, ticker)

    task = cap.start()
    assert cap.start() is task
    await asyncio.sleep(0)

    cap.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert ticker.intervals == [MAX_SECONDS - WARN_SECONDS]


# ------------------------------------------------------------------ degraded paths


@pytest.mark.asyncio
async def test_a_warning_that_raises_costs_the_warning_not_the_window() -> None:
    """A failed warning must never shorten the call. Without its own boundary the
    exception would reach _run's blanket handler, which jumps straight to the hangup —
    turning a courtesy failure at 270 seconds into an ending 30 seconds early."""
    call, ticker = FakeCall(warning_error=RuntimeError("session draining")), Ticker()
    cap = make_cap(call, ticker)
    task = cap.start()

    await ticker.release()  # warning attempted, raises, is contained
    await ticker.release()  # the warning window still runs in full
    await asyncio.wait_for(task, 1.0)

    assert ticker.intervals == [MAX_SECONDS - WARN_SECONDS, WARN_SECONDS]
    # The farewell and the hangup are unaffected by the courtesy having failed.
    assert call.events == ["speak", "speak", "hangup"]
    assert call.spoken[-1].text == FAREWELL
    assert call.hangups == 1


# ------------------------------------------------------------------- escalation

# `delete_room` swallows its own API errors and resolves successfully either way, so the
# cap cannot see a hangup fail. The contract pinned here: after asking for the hangup it
# waits one grace period, and if nothing has cancelled it by then — which the shutdown
# path does within seconds whenever the deletion actually worked — it falls back to the
# injected local shutdown, which needs no network and cannot be refused.


@pytest.mark.asyncio
async def test_escalation_fires_when_nothing_cancels_the_grace_wait() -> None:
    """The control plane ate the deletion: the room lives on, nothing cancels the
    countdown, and after the grace window the cap ends the job locally."""
    call, ticker = FakeCall(), Ticker()
    cap = make_cap(call, ticker, escalate=True)
    task = cap.start()

    await ticker.release()  # warning
    await ticker.release()  # farewell + hangup, then parked in the grace sleep
    await ticker.release()  # grace expires un-cancelled
    await asyncio.wait_for(task, 1.0)

    assert ticker.intervals == [MAX_SECONDS - WARN_SECONDS, WARN_SECONDS, ESCALATE_AFTER]
    assert call.events == ["speak", "speak", "hangup", "escalate"]
    assert call.escalations == 1


@pytest.mark.asyncio
async def test_escalation_is_skipped_when_shutdown_cancels_the_grace_wait() -> None:
    """The normal ending: the deletion worked, the job began shutting down, and its
    shutdown callback cancelled the countdown mid-grace. Escalating here would call
    shutdown() on a job already doing exactly that — harmless, but pinned away."""
    call, ticker = FakeCall(), Ticker()
    cap = make_cap(call, ticker, escalate=True)
    task = cap.start()

    await ticker.release()
    await ticker.release()
    await ticker.parked()  # hangup done; now parked in the grace sleep
    cap.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert call.hangups == 1
    assert call.escalations == 0


@pytest.mark.asyncio
async def test_a_hangup_that_raises_still_escalates() -> None:
    """The case that needs the fallback most: the deletion API failed outright."""
    call, ticker = FakeCall(hangup_error=RuntimeError("twirp unavailable")), Ticker()
    cap = make_cap(call, ticker, escalate=True)
    task = cap.start()

    await ticker.release()
    await ticker.release()
    await ticker.release()  # grace window still runs after the failed hangup
    await asyncio.wait_for(task, 1.0)

    assert call.events == ["speak", "speak", "hangup", "escalate"]
    assert call.escalations == 1


# ----------------------------------------------------------------- configuration


@pytest.mark.asyncio
@pytest.mark.parametrize("max_seconds", [float("nan"), float("inf")])
async def test_a_non_finite_cap_schedules_nothing(max_seconds: float) -> None:
    """`nan` fails every comparison, so it would slip past a `<= 0` check and park
    `asyncio.sleep(nan)` in a state nobody can reason about; `inf` never fires. Both
    are misconfigurations, and a misconfigured cap must be visibly off, not strange."""
    call, ticker = FakeCall(), Ticker()
    cap = make_cap(call, ticker, max_seconds=max_seconds)

    assert cap.start() is None
    assert cap.task is None
    assert ticker.intervals == []


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, 300.0),  # unset
        ("120", 120.0),
        ("0", 0.0),  # the documented off-switch survives the guard
        # Garbage fails towards the default — a protective limit must not be
        # disabled, or crash the worker at boot, because of a typo in an env var.
        ("nan", 300.0),
        ("inf", 300.0),
        ("five minutes", 300.0),
        # A sign typo is not an off-switch. Only the explicit "0" disables.
        ("-300", 300.0),
    ],
)
def test_seconds_env_fails_towards_the_default(
    monkeypatch: pytest.MonkeyPatch, raw: str | None, expected: float
) -> None:
    import agent

    name = "COCKPIT_TEST_SECONDS"
    if raw is None:
        monkeypatch.delenv(name, raising=False)
    else:
        monkeypatch.setenv(name, raw)
    assert agent._seconds_env(name, 300.0) == expected

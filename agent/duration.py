"""A hard cap on how long a single call may run.

Nothing else in this system ends a call. The session ends when the caller hangs up or
when the room closes, and a room stays open while anyone is at all still in it — an
observer cockpit, or a browser tab someone forgot. Observed live: a room still open 998
seconds after the SIP leg had hung up. Agent session minutes are metered, so the worst
case here is not a long demo, it is the bill.

The cap bounds BOTH halves of that. Ahead of the cap it warns the caller so nobody is
cut off mid-answer; at the cap it says goodbye and deletes the room, which hangs up SIP
and ends the session. The hangup is unconditional — it runs even when the session has
ALREADY closed, because the zombie-room tail is exactly the case where the session is
gone and the room is not. That branch is invisible to any caller and is most of the
reason this module exists, so it is pinned by a test.

Every dependency is injected — speaking, hanging up, reading the session's closed state,
even sleeping — so the whole countdown is exercised without a LiveKit object or a real
timer anywhere near it.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

__all__ = [
    "CAP_TASK_NAME",
    "ESCALATE_AFTER",
    "FAREWELL",
    "FAREWELL_TIMEOUT",
    "CallCap",
    "spoken_duration",
    "warning_text",
]

logger = logging.getLogger("glass-cockpit.duration")

CAP_TASK_NAME = "cockpit-call-cap"

# Upper bound on how long the goodbye may hold the hangup. The farewell is two sentences
# — call it eight seconds of audio — and this exists only so a wedged TTS stream cannot
# turn "end the call now" into an open-ended wait, which is the failure the cap exists to
# prevent in the first place.
FAREWELL_TIMEOUT = 15.0

FAREWELL = (
    "We have hit the demo's call limit, so I will let you go here. Thanks for calling "
    "Glass Cockpit — the dashboard has the full replay. Goodbye."
)

# How long after asking for the hangup the cap waits before concluding it did not work
# and escalating. `JobContext.delete_room` swallows its own API errors and resolves
# successfully either way, so failure cannot be observed at the call site — the only
# honest check is "did the job start shutting down within a grace period". On the normal
# path shutdown cancels this task inside that window, so escalation never runs.
#
# Sized to clear the SDK's own worst case, not just the network's: the 1.6.8 worker
# waits up to 60 seconds for the session's close work before it runs shutdown callbacks,
# and it is the shutdown callback that cancels this countdown. A grace window shorter
# than that would escalate — harmlessly, shutdown() is idempotent, but loudly and
# falsely — on any healthy teardown that was merely slow.
ESCALATE_AFTER = 75.0

_SPOKEN_MINUTES = {
    1: "one minute",
    2: "two minutes",
    3: "three minutes",
    4: "four minutes",
    5: "five minutes",
    10: "ten minutes",
}


def spoken_duration(seconds: float) -> str:
    """The cap the way a person would say it out loud.

    The TTS reads digits perfectly well, so this is presentation only: whole minutes get
    words, anything else stays in seconds rather than inventing "four point two minutes".
    """
    if seconds >= 60 and seconds % 60 == 0:
        minutes = int(seconds // 60)
        return _SPOKEN_MINUTES.get(minutes, f"{minutes} minutes")
    return f"{seconds:.0f} seconds"


def warning_text(*, max_seconds: float, warn_seconds: float) -> str:
    """What the agent says ahead of the cap, built from the configured numbers."""
    return (
        f"Just so you know, demo calls are capped at {spoken_duration(max_seconds)}, so we "
        f"have about {warn_seconds:.0f} seconds left — happy to answer one more question."
    )


class Playable(Protocol):
    """The one thing the cap needs back from a speech handle."""

    async def wait_for_playout(self) -> Any: ...


class Speak(Protocol):
    """``AgentSession.say``, narrowed to what the cap calls."""

    def __call__(self, text: str, *, allow_interruptions: bool) -> Playable: ...


class CallCap:
    """Ends the call ``max_seconds`` after it starts, warning ``warn_seconds`` before.

    One per call. ``max_seconds <= 0`` disables it outright — ``start()`` schedules
    nothing at all, which is the escape hatch for anyone running this demo somewhere
    session minutes are not the binding constraint.
    """

    def __init__(
        self,
        *,
        max_seconds: float,
        warn_seconds: float,
        speak: Speak,
        hangup: Callable[[], Awaitable[None]],
        session_closed: Callable[[], bool],
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        farewell_timeout: float = FAREWELL_TIMEOUT,
        escalate: Callable[[], None] | None = None,
        escalate_after: float = ESCALATE_AFTER,
    ) -> None:
        self._max_seconds = max_seconds
        self._warn_seconds = warn_seconds
        self._speak = speak
        self._hangup = hangup
        self._session_closed = session_closed
        self._sleep = sleep
        self._farewell_timeout = farewell_timeout
        self._escalate = escalate
        self._escalate_after = escalate_after
        # A strong reference of our own: `asyncio.create_task` keeps only a weak one, and
        # a countdown collected mid-await is a cap that silently does not exist.
        self._task: asyncio.Task[None] | None = None

    @property
    def task(self) -> asyncio.Task[None] | None:
        return self._task

    def start(self) -> asyncio.Task[None] | None:
        """Schedule the countdown, or return ``None`` when the cap is disabled."""
        # `nan` fails every comparison — it would slip past `<= 0`, then park
        # `asyncio.sleep(nan)` in a state nobody can reason about; `inf` never fires.
        # Either one is a misconfiguration, and a misconfigured cap must be visibly
        # off, not silently strange.
        if not math.isfinite(self._max_seconds) or self._max_seconds <= 0:
            logger.info("call duration cap disabled; this call is unbounded")
            return None
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name=CAP_TASK_NAME)
        return self._task

    def cancel(self) -> None:
        """Stop the countdown. Idempotent, and safe if it was never started."""
        if self._task is not None and not self._task.done():
            self._task.cancel()

    async def _run(self) -> None:
        try:
            await self._countdown()
        except asyncio.CancelledError:
            raise
        except Exception:
            # Telemetry, speech and clocks may all fail; the hangup may not be skipped
            # because one of them did. Everything above this line is optional courtesy.
            logger.exception("call cap countdown failed; hanging up anyway")
        try:
            # Unconditional, INCLUDING when the session has already closed. That is the
            # zombie-room bound: an observer or an abandoned tab holding the room open
            # after the caller hung up keeps billing until something deletes the room,
            # and this is the only thing that ever will.
            await self._hangup()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("call cap hangup failed")
        if self._escalate is None:
            return
        # The hangup cannot report failure — see ESCALATE_AFTER — so give the normal
        # shutdown path a grace window to cancel this task, and if it never does, fall
        # back to the one ending that needs no network to succeed. Deliberately after
        # the except above: a hangup that raised needs the fallback most of all.
        await self._sleep(self._escalate_after)
        # WARNING, not ERROR: a teardown that beats the grace window by a hair still
        # lands here (there is no await between the sleep returning and the escalate,
        # so a cancel arriving in that instant cannot win), and shutdown() on a job
        # already shutting down is a no-op. The line that matters for alerting is the
        # SDK's own, when a room genuinely refused to die.
        logger.warning(
            "job not shutting down %.0f seconds after the cap's hangup; escalating to a "
            "local job shutdown (either the room deletion failed, or teardown was slow "
            "and this is a no-op)",
            self._escalate_after,
        )
        try:
            self._escalate()
        except Exception:
            logger.exception("call cap escalation failed")

    async def _countdown(self) -> None:
        if 0 < self._warn_seconds < self._max_seconds:
            await self._sleep(self._max_seconds - self._warn_seconds)
            if not self._session_closed():
                logger.info(
                    "call cap: about %.0f seconds left of %.0f; warning the caller",
                    self._warn_seconds,
                    self._max_seconds,
                )
                # Deliberately not awaited to playout. The warning is spoken inside the
                # remaining window — waiting for it would push the cap out by the length
                # of the sentence, and it is interruptible because a caller who wants to
                # talk over it has one question left and should spend it.
                #
                # Its own boundary, not _run's blanket one: a warning that raises (a
                # session mid-drain rejecting say(), say) must cost the caller the
                # warning, never the rest of the window — _run's handler would jump
                # straight to the hangup, thirty seconds early.
                try:
                    self._speak(
                        warning_text(
                            max_seconds=self._max_seconds, warn_seconds=self._warn_seconds
                        ),
                        allow_interruptions=True,
                    )
                except Exception:
                    logger.exception("call cap warning failed; the countdown continues")
            await self._sleep(self._warn_seconds)
        else:
            # No warning, or a warning window that swallows the whole call: one sleep.
            await self._sleep(self._max_seconds)

        logger.info("call reached the %.0f-second cap; hanging up", self._max_seconds)
        if not self._session_closed():
            await self._farewell()

    async def _farewell(self) -> None:
        """Say goodbye, bounded. Never raises: the hangup happens either way."""
        try:
            # Uninterruptible on purpose — the one utterance on this call the caller must
            # not be able to barge in on, because barging in would restart the turn and
            # extend a call that is already over its budget.
            handle = self._speak(FAREWELL, allow_interruptions=False)
            await asyncio.wait_for(handle.wait_for_playout(), self._farewell_timeout)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("call cap farewell failed; hanging up anyway")

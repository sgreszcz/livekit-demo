"""Tests for debrief durability: checkpoints, the final flush, redaction, summaries.

These cover the production failure that lost most of the agent's calls. Three separate
bugs conspired: the debrief was posted from a job-shutdown callback, but the job lives
until the ROOM closes and an observer can hold a room open indefinitely after the caller
hangs up; the callback was registered after an unbounded await on the caller participant,
so a caller who hung up mid-connect meant it was never registered at all; and the upload's
own timeout was longer than the SDK's entire shutdown budget, so a slow upload was killed
without a log line.

Nothing here touches the network or a real timer — the uploader takes an injectable post
function, sleep and clock precisely so these can be deterministic.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any

import pytest

import telemetry
from telemetry import (
    CALL_SUMMARY_MARKER,
    CHECKPOINT_SECONDS,
    CHECKPOINT_TIMEOUT,
    FINAL_TIMEOUT,
    REDACTED,
    DebriefUploader,
    PipelineModels,
    TurnStore,
    classify_entry_room,
    log_call_summary,
    percentile_ms,
    post_debrief,
    redact_room_name,
)

MODELS = PipelineModels(stt="deepgram/nova-3", llm="openai/gpt-4.1-mini", tts="cartesia/sonic-3")

# Ofcom's reserved drama range. Never a real subscriber, so it is safe to commit.
FAKE_NUMBER = "447700900123"
SIP_ROOM = f"sip-cockpit-_+{FAKE_NUMBER}_5xzppVvwo6Px"


# ---------------------------------------------------------------------- doubles


@dataclass
class Call:
    """One recorded debrief request."""

    method: str
    url: str
    token: str | None
    body: dict[str, Any]
    timeout: float


class FakePost:
    """Stands in for the HTTP layer. Raises what the test tells it to."""

    def __init__(self, response: dict[str, Any] | None = None) -> None:
        self.calls: list[Call] = []
        self.response = response if response is not None else {"ok": True}
        #: One entry consumed per request; ``None`` means "succeed this one".
        self.failures: list[BaseException | None] = []

    async def __call__(
        self,
        *,
        method: str,
        url: str,
        token: str | None,
        body: dict[str, Any],
        timeout: float,
    ) -> dict[str, Any]:
        self.calls.append(Call(method, url, token, body, timeout))
        if self.failures:
            failure = self.failures.pop(0)
            if failure is not None:
                raise failure
        return self.response

    @property
    def methods(self) -> list[str]:
        return [c.method for c in self.calls]


@dataclass
class FakeLog:
    """The slice of TelemetryPublisher the uploader reads: an append-only envelope log."""

    _messages: list[dict[str, Any]] = field(default_factory=list)

    @property
    def messages(self) -> list[dict[str, Any]]:
        return self._messages

    def emit(self, count: int = 1) -> None:
        for _ in range(count):
            # A `payload` is not optional. `sanitizeEnvelope` in
            # worker/src/debrief.ts rejects any envelope without a plain-object
            # payload, so envelopes built without one made the contract test
            # below vacuous: it asserted against the fake and would have passed
            # while the real Worker silently dropped every message.
            self._messages.append(
                {
                    "v": 1,
                    "type": "state",
                    "ts": float(len(self._messages)),
                    "payload": {"state": "listening"},
                }
            )


class Ticker:
    """A hand-driven replacement for ``asyncio.sleep`` plus a clock that follows it.

    The checkpoint loop is an infinite ``sleep``/``post`` cycle. Handing it real timers
    would make these tests either slow or flaky, so the test advances it one tick at a
    time and knows exactly when the loop is parked back in ``sleep``.
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

    async def tick(self, timeout: float = 1.0) -> None:
        """Release one sleep and return once the loop is parked in the next one."""
        await asyncio.wait_for(self._parked.wait(), timeout)
        self._parked.clear()
        self._release.set()
        await asyncio.wait_for(self._parked.wait(), timeout)


def make_uploader(
    post: FakePost,
    log: FakeLog,
    ticker: Ticker | None = None,
    *,
    url: str | None = "https://worker.example/debrief",
    token: str | None = "secret",
    meta: dict[str, Any] | None = None,
) -> DebriefUploader:
    ticker = ticker or Ticker()
    return DebriefUploader(
        url=url,
        token=token,
        call_id="RM_abc",
        meta=meta if meta is not None else {"entry": "sip"},
        publisher=log,
        post=post,
        sleep=ticker.sleep,
        clock=ticker.time,
    )


# ------------------------------------------------------------------ checkpoints


@pytest.mark.asyncio
async def test_checkpoints_fire_on_the_interval() -> None:
    """A call that dies mid-flight must still have left a record behind."""
    post, log, ticker = FakePost(), FakeLog(), Ticker()
    uploader = make_uploader(post, log, ticker)
    log.emit()
    uploader.start()

    await ticker.tick()
    log.emit()
    await ticker.tick()
    await uploader.aclose()

    assert post.methods == ["PUT", "PUT"]
    assert ticker.intervals[:2] == [CHECKPOINT_SECONDS, CHECKPOINT_SECONDS]
    assert uploader.checkpoints == 2


@pytest.mark.asyncio
async def test_checkpoint_body_matches_the_worker_contract() -> None:
    post, log, ticker = FakePost(), FakeLog(), Ticker()
    uploader = make_uploader(post, log, ticker, meta={"entry": "sip", "room": "sip-cockpit-x"})
    log.emit(3)
    uploader.start()
    await ticker.tick()
    await uploader.aclose()

    call = post.calls[0]
    assert call.method == "PUT"
    assert call.token == "secret"
    assert call.timeout == CHECKPOINT_TIMEOUT
    # call_id is required — the Worker answers 400 without it and keys the record on it.
    assert call.body["call_id"] == "RM_abc"
    assert call.body["in_progress"] is True
    assert call.body["meta"] == {"entry": "sip", "room": "sip-cockpit-x"}
    assert len(call.body["messages"]) == 3
    # Every envelope carries a payload, because the Worker drops any that does not.
    assert all(isinstance(m["payload"], dict) for m in call.body["messages"])
    # The FIRST checkpoint goes out immediately, before any sleep — see below.
    assert call.body["ended_at"] == 1_000.0


@pytest.mark.asyncio
async def test_checkpoint_is_skipped_when_nothing_new_was_emitted() -> None:
    """A silent stretch between turns has nothing to say; re-uploading the same body
    every fifteen seconds would spend the Worker's write budget on nothing."""
    post, log, ticker = FakePost(), FakeLog(), Ticker()
    uploader = make_uploader(post, log, ticker)
    log.emit()
    uploader.start()

    await ticker.tick()  # uploads
    await ticker.tick()  # nothing new — skipped
    log.emit()
    await ticker.tick()  # uploads again
    await uploader.aclose()

    assert post.methods == ["PUT", "PUT"]
    assert [len(c.body["messages"]) for c in post.calls] == [1, 2]


@pytest.mark.asyncio
async def test_first_checkpoint_fires_even_with_no_envelopes() -> None:
    """The first checkpoint's job is to tell the Worker this call EXISTS, so it goes
    out whether or not the call has emitted anything yet."""
    post, log, ticker = FakePost(), FakeLog(), Ticker()
    uploader = make_uploader(post, log, ticker)
    uploader.start()

    await ticker.tick()
    await uploader.aclose()

    assert post.methods == ["PUT"]
    assert post.calls[0].body["messages"] == []


@pytest.mark.asyncio
async def test_the_first_checkpoint_goes_out_before_any_sleep() -> None:
    """Sleeping first left every call unrecoverable for its opening fifteen seconds,
    and short calls are precisely the ones checkpoints exist to save: a ten-second
    call whose final POST times out had nothing to fall back on but the job-shutdown
    callback, which is deferred indefinitely by the abandoned-room condition this
    whole change is about."""
    post, log, ticker = FakePost(), FakeLog(), Ticker()
    uploader = make_uploader(post, log, ticker)
    log.emit()
    uploader.start()

    await ticker.tick()
    await uploader.aclose()

    # Stamped at the start of the call, not one interval into it.
    assert post.calls[0].body["ended_at"] == 1_000.0
    assert post.calls[0].method == "PUT"


@pytest.mark.asyncio
async def test_a_failing_checkpoint_does_not_propagate() -> None:
    """Telemetry must never be able to end a call. The loop survives and retries."""
    post, log, ticker = FakePost(), FakeLog(), Ticker()
    # Exactly one injected failure; every later attempt succeeds.
    post.failures = [RuntimeError("worker down")]
    uploader = make_uploader(post, log, ticker)
    log.emit()
    uploader.start()

    await ticker.tick()
    log.emit()
    await ticker.tick()

    # Counted rather than hard-coded: the point is that one attempt was refused,
    # nothing was raised, and every attempt after it landed.
    assert post.calls, "the loop stopped after the failure"
    assert set(post.methods) == {"PUT"}
    assert uploader.checkpoints == len(post.calls) - 1
    await uploader.aclose()


@pytest.mark.asyncio
async def test_a_failed_checkpoint_is_retried_with_the_same_count() -> None:
    """The skip guard tracks what was STORED, not what was attempted — otherwise one
    failure would suppress every checkpoint until the next envelope."""
    post, log, ticker = FakePost(), FakeLog(), Ticker()
    post.failures = [TimeoutError("slow"), None]
    uploader = make_uploader(post, log, ticker)
    log.emit()
    uploader.start()

    await ticker.tick()
    await ticker.tick()  # same envelope count, but the first attempt never stored
    await uploader.aclose()

    assert post.methods == ["PUT", "PUT"]
    assert uploader.checkpoints == 1


@pytest.mark.asyncio
async def test_checkpoints_are_disabled_without_an_endpoint() -> None:
    post, log, ticker = FakePost(), FakeLog(), Ticker()
    uploader = make_uploader(post, log, ticker, url=None)
    uploader.start()
    await asyncio.sleep(0)

    assert ticker.intervals == []
    assert post.calls == []
    await uploader.aclose()


# ----------------------------------------------------------------- final upload


@pytest.mark.asyncio
async def test_final_flush_posts_once_on_success() -> None:
    """The Worker upserts by call_id so a duplicate is survivable, but a second POST
    mints a second share id and spends the shutdown budget twice."""
    post, log = FakePost({"id": "k7Qx2f", "url": "https://cockpit.example/call/k7Qx2f"}), FakeLog()
    uploader = make_uploader(post, log)
    log.emit(2)

    first = await uploader.finalize(ended_at=1_234.0)
    second = await uploader.finalize(ended_at=9_999.0)

    assert post.methods == ["POST"]
    assert first == second == "https://cockpit.example/call/k7Qx2f"
    assert uploader.final_uploaded is True
    body = post.calls[0].body
    assert body["in_progress"] is False
    assert body["ended_at"] == 1_234.0
    assert post.calls[0].timeout == FINAL_TIMEOUT


@pytest.mark.asyncio
async def test_shutdown_path_retries_after_a_failed_session_close_flush() -> None:
    """The belt-and-braces contract: the job-shutdown callback is only useful if a
    failed session-close flush leaves the call retryable."""
    post, log = FakePost({"url": "https://cockpit.example/call/k7"}), FakeLog()
    post.failures = [RuntimeError("worker 502")]
    uploader = make_uploader(post, log)
    log.emit()

    assert await uploader.finalize(ended_at=100.0) is None
    assert uploader.final_uploaded is False

    assert await uploader.finalize(ended_at=100.0) == "https://cockpit.example/call/k7"
    assert post.methods == ["POST", "POST"]
    assert uploader.final_uploaded is True


@pytest.mark.asyncio
async def test_the_checkpoint_task_is_stopped_before_the_final_flush() -> None:
    """The Worker deletes the checkpoint record on the final POST, so a checkpoint that
    landed afterwards would resurrect the call as permanently in progress."""
    post, log, ticker = FakePost(), FakeLog(), Ticker()
    uploader = make_uploader(post, log, ticker)
    log.emit()
    uploader.start()
    await ticker.tick()

    await uploader.finalize(ended_at=500.0)

    assert post.methods == ["PUT", "POST"]
    # The loop is gone: nothing is parked in sleep to release any more.
    with pytest.raises(asyncio.TimeoutError):
        await ticker.tick(timeout=0.05)


@pytest.mark.asyncio
async def test_final_flush_without_an_endpoint_is_not_retried() -> None:
    post, log = FakePost(), FakeLog()
    uploader = make_uploader(post, log, url=None)

    assert await uploader.finalize(ended_at=1.0) is None
    assert uploader.final_uploaded is True
    assert post.calls == []


@pytest.mark.asyncio
async def test_final_flush_snapshots_the_message_list() -> None:
    """`messages` keeps growing while the request is in flight; serialising a list that
    mutates under the encoder would raise on the one path that must not."""
    log = FakeLog()

    class SlowPost(FakePost):
        async def __call__(self, **kwargs: Any) -> dict[str, Any]:
            log.emit()  # a straggler arrives mid-upload
            return await super().__call__(**kwargs)

    post = SlowPost()
    uploader = make_uploader(post, log)
    log.emit(2)

    await uploader.finalize(ended_at=1.0)
    assert len(post.calls[0].body["messages"]) == 2


@pytest.mark.asyncio
async def test_a_final_timeout_logs_a_warning_naming_the_timeout(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The production symptom was silence: the SDK killed the process mid-upload and
    nothing said why. A named timeout is the difference between a bug and a mystery."""
    post, log = FakePost(), FakeLog()
    post.failures = [TimeoutError("too slow")]
    uploader = make_uploader(post, log)

    with caplog.at_level(logging.WARNING, logger="glass-cockpit.telemetry"):
        assert await uploader.finalize(ended_at=1.0) is None

    assert "FINAL_TIMEOUT" in caplog.text
    assert "4.0s" in caplog.text


def test_final_timeout_fits_inside_the_sdk_shutdown_budget() -> None:
    """WorkerOptions.shutdown_process_timeout is 10.0s and covers publisher.aclose()
    as well as this upload; the old 10.0s client timeout could not fail gracefully."""
    from livekit.agents.worker import WorkerOptions

    assert FINAL_TIMEOUT < WorkerOptions.shutdown_process_timeout
    assert CHECKPOINT_TIMEOUT < FINAL_TIMEOUT


@pytest.mark.asyncio
async def test_post_debrief_marks_the_body_as_final(monkeypatch: pytest.MonkeyPatch) -> None:
    """The standalone entry point still exists, and speaks the same contract."""
    post = FakePost({"url": "https://cockpit.example/call/k7"})
    monkeypatch.setattr(telemetry, "_http_debrief", post)

    url = await post_debrief(
        url="https://worker.example/debrief",
        token="secret",
        call_id="c1",
        meta={"entry": "browser"},
        messages=[{"v": 1}],
        ended_at=7.0,
    )

    assert url == "https://cockpit.example/call/k7"
    assert post.calls[0].method == "POST"
    assert post.calls[0].timeout == FINAL_TIMEOUT
    assert post.calls[0].body["in_progress"] is False


# -------------------------------------------------------------- entry & privacy


@pytest.mark.parametrize(
    ("room", "expected"),
    [
        (SIP_ROOM, "sip"),
        ("sip-cockpit-_+REDACTED_5xzppVvwo6Px", "sip"),
        ("cockpit-abc123", "browser"),
        ("console", "browser"),
        ("", "browser"),
        # A substring match would misclassify; only the prefix counts.
        ("my-sip-cockpit-thing", "browser"),
    ],
)
def test_classify_entry_room(room: str, expected: str) -> None:
    assert classify_entry_room(room) == expected


def test_classify_entry_room_agrees_with_the_worker() -> None:
    """`classifyEntry` in worker/src/active.ts reads the same prefix. If these two ever
    disagree, one stored call is filed under two different entry types."""
    assert classify_entry_room(SIP_ROOM) == "sip"
    assert classify_entry_room("cockpit-" + "x" * 16) == "browser"


def test_redact_room_name_removes_the_caller_number() -> None:
    assert redact_room_name(SIP_ROOM) == f"sip-cockpit-_{REDACTED}_5xzppVvwo6Px"
    assert FAKE_NUMBER not in redact_room_name(SIP_ROOM)


def test_redact_room_name_is_idempotent_and_leaves_browser_rooms_alone() -> None:
    once = redact_room_name(SIP_ROOM)
    assert redact_room_name(once) == once
    assert redact_room_name("cockpit-abc123") == "cockpit-abc123"


def test_redact_room_name_keeps_short_digit_runs() -> None:
    """Six digits is shorter than any dialable number; only 7+ is redacted."""
    assert redact_room_name("cockpit-123456") == "cockpit-123456"
    assert redact_room_name("cockpit-1234567") == f"cockpit-{REDACTED}"


def test_no_caller_number_survives_into_call_meta() -> None:
    """call_meta goes out on the data channel to every participant, observers included."""
    store = TurnStore(models=MODELS)
    meta = store.call_meta(
        call_id="RM_abc",
        room=redact_room_name(SIP_ROOM),
        started_at=1.0,
        entry=classify_entry_room(SIP_ROOM),
    )
    assert FAKE_NUMBER not in json.dumps(meta)
    assert meta["payload"]["entry"] == "sip"
    assert meta["payload"]["room"] == f"sip-cockpit-_{REDACTED}_5xzppVvwo6Px"


@pytest.mark.asyncio
async def test_no_caller_number_survives_into_an_uploaded_body() -> None:
    """A stored debrief is fetched by anyone holding its share link — that is publication."""
    store = TurnStore(models=MODELS)
    meta = store.call_meta(
        call_id="RM_abc", room=redact_room_name(SIP_ROOM), started_at=1.0, entry="sip"
    )
    log = FakeLog()
    log.messages.append(meta)
    post, ticker = FakePost(), Ticker()
    uploader = make_uploader(post, log, ticker, meta=meta["payload"])
    uploader.start()

    await ticker.tick()
    await uploader.finalize(ended_at=2.0)

    assert post.methods == ["PUT", "POST"]
    for call in post.calls:
        assert FAKE_NUMBER not in json.dumps(call.body)


def test_call_summary_room_is_redacted_even_if_the_caller_forgot() -> None:
    """Last gate before a room name reaches a log aggregator; costs one regex pass."""
    store = TurnStore(models=MODELS)
    summary = store.call_summary(
        call_id="RM_abc",
        entry="sip",
        room=SIP_ROOM,  # deliberately raw
        close_reason="participant_disconnected",
        started_at=0.0,
        ended_at=10.0,
    )
    assert FAKE_NUMBER not in json.dumps(summary)
    assert summary["room"] == f"sip-cockpit-_{REDACTED}_5xzppVvwo6Px"


# ---------------------------------------------------------------- percentiles


@pytest.mark.parametrize(
    ("values", "p", "expected"),
    [
        # Nearest rank: ceil(p/100 * n), 1-indexed. n=10 → p50 is the 5th value.
        ([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], 50, 500.0),
        ([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], 95, 1000.0),
        # n=4 → ceil(0.5*4)=2, ceil(0.95*4)=4.
        ([0.4, 0.1, 0.3, 0.2], 50, 200.0),
        ([0.4, 0.1, 0.3, 0.2], 95, 400.0),
        # n=1 → the only value, whatever the percentile.
        ([0.25], 50, 250.0),
        ([0.25], 95, 250.0),
        # Rank clamps to at least 1: p0 is the fastest turn, never index -1.
        ([0.3, 0.9], 0, 300.0),
        ([0.3, 0.9], 100, 900.0),
    ],
)
def test_percentile_ms_uses_nearest_rank(values: list[float], p: float, expected: float) -> None:
    assert percentile_ms(values, p) == expected


def test_percentile_ms_of_nothing_is_none() -> None:
    """Zero would be a lie that averages beautifully across a fleet."""
    assert percentile_ms([], 50) is None
    assert percentile_ms([], 95) is None


def test_percentile_ms_reports_a_value_some_turn_actually_had() -> None:
    """Nearest rank, not interpolation: on a five-turn call an interpolated p95 is a
    number that never happened."""
    values = [0.20, 0.30, 0.40, 0.50, 2.00]
    assert percentile_ms(values, 95) == 2000.0
    assert percentile_ms(values, 50) in {v * 1000 for v in values}


# -------------------------------------------------------------- call summary


def drive_turn(
    store: TurnStore,
    turn_id: str,
    *,
    eou_delay: float,
    ttft: float,
    ttfb: float,
    prompt_tokens: int = 100,
    completion_tokens: int = 20,
    audio_duration: float = 2.0,
    characters_count: int = 50,
) -> None:
    """Feed one complete turn through the store in SDK emission order."""
    store.record_stt(duration=0.0, audio_duration=audio_duration)
    store.record_eou(turn_id, end_of_utterance_delay=eou_delay, transcription_delay=0.05)
    store.record_llm(
        turn_id,
        ttft=ttft,
        duration=ttft + 0.5,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )
    store.record_tts(
        turn_id, ttfb=ttfb, duration=1.0, audio_duration=1.5, characters_count=characters_count
    )


def test_call_summary_counts_and_percentiles() -> None:
    store = TurnStore(models=MODELS)
    # total_response_latency = eou + ttft + ttfb → 0.4, 0.8, 1.6 seconds.
    drive_turn(store, "t1", eou_delay=0.1, ttft=0.2, ttfb=0.1)
    drive_turn(store, "t2", eou_delay=0.2, ttft=0.4, ttfb=0.2)
    drive_turn(store, "t3", eou_delay=0.4, ttft=0.8, ttfb=0.4)
    # A fourth turn that never completed — the caller hung up mid-answer.
    store.record_eou("t4", end_of_utterance_delay=0.3, transcription_delay=0.05)
    store.get("t3").degraded = True  # type: ignore[union-attr]
    store.get("t2").barge_in = True  # type: ignore[union-attr]

    summary = store.call_summary(
        call_id="RM_abc",
        entry="sip",
        room="cockpit-abc",
        close_reason="participant_disconnected",
        started_at=1_000.0,
        ended_at=1_010.5,
    )

    assert summary["call_id"] == "RM_abc"
    assert summary["entry"] == "sip"
    assert summary["close_reason"] == "participant_disconnected"
    assert summary["duration_seconds"] == 10.5
    assert summary["turns"] == 4
    assert summary["turns_completed"] == 3
    # n=3 → ceil(0.5*3)=2 → 0.8s; ceil(0.95*3)=3 → 1.6s.
    assert summary["latency_p50_ms"] == 800.0
    assert summary["latency_p95_ms"] == 1600.0
    assert summary["degraded_turns"] == 1
    assert summary["barge_ins"] == 1
    assert summary["prompt_tokens"] == 300
    assert summary["completion_tokens"] == 60
    assert summary["stt_seconds"] == 6.0
    assert summary["tts_characters"] == 150
    assert summary["est_cost_usd"] == store.estimated_cost_usd()


def test_call_summary_of_a_call_with_no_turns() -> None:
    """The case that matters most: a caller who hung up before the agent said anything
    still has to leave a record, and it must not divide by zero."""
    store = TurnStore(models=MODELS)
    summary = store.call_summary(
        call_id="RM_abc",
        entry="sip",
        room="sip-cockpit-_+REDACTED_x",
        close_reason="participant_disconnected",
        started_at=1_000.0,
        ended_at=1_002.0,
    )

    assert summary["turns"] == 0
    assert summary["turns_completed"] == 0
    assert summary["latency_p50_ms"] is None
    assert summary["latency_p95_ms"] is None
    assert summary["degraded_turns"] == 0
    assert summary["barge_ins"] == 0
    assert summary["duration_seconds"] == 2.0
    assert summary["est_cost_usd"] == 0.0


def test_call_summary_is_flat_and_json_serialisable() -> None:
    """A log aggregator wants scalars it can aggregate, not a nested waterfall."""
    store = TurnStore(models=MODELS)
    drive_turn(store, "t1", eou_delay=0.1, ttft=0.2, ttfb=0.1)
    summary = store.call_summary(
        call_id="RM_abc",
        entry="browser",
        room="cockpit-abc",
        close_reason="user_initiated",
        started_at=0.0,
        ended_at=5.0,
    )
    assert all(isinstance(v, (str, int, float, type(None))) for v in summary.values())
    assert json.loads(json.dumps(summary)) == summary


def test_log_call_summary_emits_one_parseable_line(caplog: pytest.LogCaptureFixture) -> None:
    """`lk agent logs` streams stdout as JSON with the log text in `message`; the marker
    plus compact JSON is what makes the summary recoverable from there."""
    store = TurnStore(models=MODELS)
    drive_turn(store, "t1", eou_delay=0.1, ttft=0.2, ttfb=0.1)
    summary = store.call_summary(
        call_id="RM_abc",
        entry="sip",
        room=SIP_ROOM,
        close_reason="participant_disconnected",
        started_at=0.0,
        ended_at=5.0,
    )

    with caplog.at_level(logging.INFO, logger="glass-cockpit.telemetry"):
        line = log_call_summary(summary)

    records = [r for r in caplog.records if r.getMessage().startswith(CALL_SUMMARY_MARKER)]
    assert len(records) == 1
    message = records[0].getMessage()
    assert "\n" not in message
    assert FAKE_NUMBER not in message
    marker, _, payload = message.partition(" ")
    assert marker == CALL_SUMMARY_MARKER
    assert payload == line
    assert json.loads(payload)["call_id"] == "RM_abc"


# --------------------------------------------------------------- redaction parity

# These cases are asserted IDENTICALLY in worker/src/debrief.test.ts. The agent and
# the Worker both redact, and they have to agree: if the agent's rule is looser it
# uploads something the Worker would have stripped, and if it is tighter it mangles
# records the Worker would have kept. Two implementations in two languages only stay
# in step if something checks.
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("sip-cockpit-_+447700900123_BXhCPPSrr57t", "sip-cockpit-_+REDACTED_BXhCPPSrr57t"),
        ("sip_+447700900123", "sip_+REDACTED"),
        ("+44-7700-900123", "+REDACTED"),
        ("(0770) 090 0123", "(+REDACTED"),
        ("call me on 07700 900123 later", "call me on +REDACTED later"),
        # Not numbers: an ordinary room name, a short run, and a date.
        ("cockpit-AKI0UWWR2t0BaIwA", "cockpit-AKI0UWWR2t0BaIwA"),
        ("cockpit-a1b2c3", "cockpit-a1b2c3"),
        ("123456", "123456"),
        ("2026-08-07", "2026-08-07"),
    ],
)
def test_redaction_matches_the_worker_rule(raw: str, expected: str) -> None:
    assert telemetry.redact_room_name(raw) == expected


# ---------------------------------------------------------------- endpoint scheme

# Every debrief request carries DEBRIEF_TOKEN as a bearer header, so the endpoint is a
# place a secret gets sent and the scheme is a security control, not a formatting detail.
# Asserted per-scheme because the failure is silent by nature: a plain-http endpoint
# uploads perfectly happily and nothing in the demo looks wrong.
@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://cockpit.agentmaker.io/api/debrief", True),
        # Loopback is where `wrangler dev` lives, and there is no network to sniff.
        # Judged as an address, not a spelling, so every way of writing loopback works.
        ("http://localhost:8787/api/debrief", True),
        ("http://127.0.0.1:8787/api/debrief", True),
        ("http://[::1]:8787/api/debrief", True),
        ("http://[0:0:0:0:0:0:0:1]:8787/api/debrief", True),
        ("http://127.0.0.2:8787/api/debrief", True),
        # The whole point: a copy-pasted or stale http:// endpoint is refused.
        ("http://cockpit.agentmaker.io/api/debrief", False),
        ("http://192.168.1.10:8787/api/debrief", False),
        # A hostname that merely RESOLVES to loopback is still a name on the network.
        ("http://localhost.example.com:8787/api/debrief", False),
        # Neither a transport nor a mistake worth guessing at.
        ("ftp://example.com/debrief", False),
        ("cockpit.agentmaker.io/api/debrief", False),
        # Unparseable must mean "no endpoint", never an exception — this runs inside a
        # connected entrypoint, where raising would kill the call, not just the upload.
        ("https://[::1", False),
        ("", False),
        (None, False),
    ],
)
def test_only_tls_or_loopback_endpoints_receive_the_bearer_token(
    url: str | None, allowed: bool
) -> None:
    assert telemetry.checked_debrief_url(url) == (url if allowed else None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("url", "posts"),
    [
        # The positive control, and it is the point of the parametrize: without it
        # "did not upload" could just as well mean the fake is never called on this
        # path at all, and the test below would pass against a deleted guard.
        ("https://cockpit.agentmaker.io/api/debrief", True),
        ("http://cockpit.agentmaker.io/api/debrief", False),
    ],
)
async def test_only_a_tls_endpoint_receives_the_call(url: str, posts: bool) -> None:
    """A refused endpoint behaves exactly like an unset one, not like a broken one.

    The call still has to work: no exception, no retry loop, no checkpoint task left
    holding a slot — just no debrief, and above all no bearer token on the wire.
    """
    log = FakeLog([])
    log.emit(3)
    post = FakePost({"ok": True, "url": "https://cockpit.agentmaker.io/call/abc"})
    uploader = DebriefUploader(
        url=url,
        token="s3cret",
        call_id="RM_abc",
        meta={"room": "cockpit-abc"},
        publisher=log,
        post=post,
    )
    uploader.start()
    await uploader.aclose()
    share_url = await uploader.finalize(ended_at=1723000000.0)

    assert bool(post.calls) is posts
    # The token is the thing being protected, so assert on the token itself rather
    # than only on the call count.
    assert [c.token for c in post.calls] == (["s3cret"] if posts else [])
    assert (share_url is not None) is posts

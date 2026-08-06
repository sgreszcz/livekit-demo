"""Tests for the telemetry publisher and the debrief upload.

The cockpit merges partial `turn` envelopes by speech id and replaces transcripts in
arrival order, so wire order must match emission order even though the SDK's callbacks
are synchronous and publishing is not. That guarantee is what these tests pin down.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from telemetry import TELEMETRY_TOPIC, TelemetryPublisher, envelope, post_debrief


class FakeLocalParticipant:
    def __init__(self, delays: list[float] | None = None) -> None:
        self.published: list[tuple[bytes, bool, str]] = []
        self._delays = delays or []

    async def publish_data(self, payload: bytes, *, reliable: bool, topic: str) -> None:
        # Vary per-packet latency so a naive create_task-per-envelope would reorder.
        if self._delays:
            await asyncio.sleep(self._delays[len(self.published) % len(self._delays)])
        self.published.append((payload, reliable, topic))


class FakeRoom:
    def __init__(self, delays: list[float] | None = None) -> None:
        self.local_participant = FakeLocalParticipant(delays)


def make_envelope(index: int) -> dict:
    return envelope("state", {"state": "listening", "prev": "speaking"}, ts=float(index))


@pytest.mark.asyncio
async def test_publishes_reliably_on_the_cockpit_topic() -> None:
    room = FakeRoom()
    publisher = TelemetryPublisher(room)
    publisher.start()

    publisher.emit(make_envelope(0))
    await publisher.aclose()

    (payload, reliable, topic) = room.local_participant.published[0]
    assert reliable is True
    assert topic == TELEMETRY_TOPIC
    assert json.loads(payload)["v"] == 1


@pytest.mark.asyncio
async def test_wire_order_matches_emission_order() -> None:
    room = FakeRoom(delays=[0.01, 0.0, 0.005])
    publisher = TelemetryPublisher(room)
    publisher.start()

    for i in range(12):
        publisher.emit(make_envelope(i))
    await publisher.aclose()

    sent = [json.loads(p)["ts"] for p, _, _ in room.local_participant.published]
    assert sent == [float(i) for i in range(12)]


@pytest.mark.asyncio
async def test_emit_ignores_none() -> None:
    """Store methods return None when there is nothing to publish."""
    publisher = TelemetryPublisher(FakeRoom())
    publisher.start()
    publisher.emit(None)
    await publisher.aclose()
    assert publisher.messages == []


@pytest.mark.asyncio
async def test_messages_records_every_envelope_for_the_debrief() -> None:
    publisher = TelemetryPublisher(FakeRoom())
    publisher.start()
    publisher.emit_all([make_envelope(0), make_envelope(1)])
    await publisher.aclose()

    assert [m["ts"] for m in publisher.messages] == [0.0, 1.0]


@pytest.mark.asyncio
async def test_publish_failure_does_not_stop_the_stream() -> None:
    """One bad packet must not take the telemetry bus down mid-call."""

    class BrokenParticipant(FakeLocalParticipant):
        async def publish_data(self, payload: bytes, *, reliable: bool, topic: str) -> None:
            if len(self.published) == 0:
                self.published.append((b"", reliable, topic))
                raise RuntimeError("data channel hiccup")
            await super().publish_data(payload, reliable=reliable, topic=topic)

    room = FakeRoom()
    room.local_participant = BrokenParticipant()
    publisher = TelemetryPublisher(room)
    publisher.start()

    publisher.emit(make_envelope(0))
    publisher.emit(make_envelope(1))
    await publisher.aclose()

    assert len(room.local_participant.published) == 2


@pytest.mark.asyncio
async def test_console_mode_without_a_room_is_a_no_op() -> None:
    publisher = TelemetryPublisher(None)
    publisher.start()
    publisher.emit(make_envelope(0))
    await publisher.aclose()
    assert len(publisher.messages) == 1


@pytest.mark.asyncio
async def test_debrief_skipped_when_endpoint_is_unset() -> None:
    assert (
        await post_debrief(url=None, token=None, call_id="c1", meta={}, messages=[], ended_at=1.0)
        is None
    )


@pytest.mark.asyncio
async def test_debrief_tolerates_an_unreachable_endpoint() -> None:
    """A missing Worker degrades the demo, it does not fail the call."""
    result = await post_debrief(
        url="http://127.0.0.1:9/debrief",  # discard port, always refuses
        token="secret",
        call_id="c1",
        meta={"entry": "browser"},
        messages=[make_envelope(0)],
        ended_at=1.0,
    )
    assert result is None

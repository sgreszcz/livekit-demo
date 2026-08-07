"""Tests for the telemetry publisher and the debrief upload.

The cockpit merges partial `turn` envelopes by speech id and replaces transcripts in
arrival order, so wire order must match emission order even though the SDK's callbacks
are synchronous and publishing is not. That guarantee is what these tests pin down.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

import pytest

from telemetry import TELEMETRY_TOPIC, TelemetryPublisher, envelope, post_debrief


@dataclass(frozen=True)
class Sent:
    """One recorded ``publish_data`` call."""

    payload: bytes
    reliable: bool
    topic: str
    destinations: tuple[str, ...]

    @property
    def ts(self) -> float:
        return json.loads(self.payload)["ts"]


class FakeLocalParticipant:
    def __init__(self, delays: list[float] | None = None) -> None:
        self.published: list[Sent] = []
        self._delays = delays or []

    async def publish_data(
        self,
        payload: bytes,
        *,
        reliable: bool,
        topic: str,
        destination_identities: list[str] | None = None,
    ) -> None:
        # Vary per-packet latency so a naive create_task-per-envelope would reorder.
        if self._delays:
            await asyncio.sleep(self._delays[len(self.published) % len(self._delays)])
        self.published.append(Sent(payload, reliable, topic, tuple(destination_identities or ())))


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

    sent = room.local_participant.published[0]
    assert sent.reliable is True
    assert sent.topic == TELEMETRY_TOPIC
    assert json.loads(sent.payload)["v"] == 1
    # No destinations means broadcast: live telemetry goes to the whole room.
    assert sent.destinations == ()


@pytest.mark.asyncio
async def test_wire_order_matches_emission_order() -> None:
    room = FakeRoom(delays=[0.01, 0.0, 0.005])
    publisher = TelemetryPublisher(room)
    publisher.start()

    for i in range(12):
        publisher.emit(make_envelope(i))
    await publisher.aclose()

    sent = [s.ts for s in room.local_participant.published]
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
        async def publish_data(
            self,
            payload: bytes,
            *,
            reliable: bool,
            topic: str,
            destination_identities: list[str] | None = None,
        ) -> None:
            if len(self.published) == 0:
                self.published.append(Sent(b'{"ts":-1}', reliable, topic, ()))
                raise RuntimeError("data channel hiccup")
            await super().publish_data(
                payload,
                reliable=reliable,
                topic=topic,
                destination_identities=destination_identities,
            )

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


# ------------------------------------------------------- observer catch-up snapshot


@pytest.mark.asyncio
async def test_snapshot_is_addressed_to_the_observer_alone() -> None:
    """The caller's cockpit has already merged these envelopes; a second copy would
    double-count every state change and interruption in its timeline."""
    room = FakeRoom()
    publisher = TelemetryPublisher(room)
    publisher.start()

    publisher.emit_all([make_envelope(0), make_envelope(1)])
    publisher.snapshot_to("observer-42")
    await publisher.aclose()

    live, replay = room.local_participant.published[:2], room.local_participant.published[2:]
    assert [s.destinations for s in live] == [(), ()]
    assert [s.destinations for s in replay] == [("observer-42",), ("observer-42",)]
    assert all(s.topic == TELEMETRY_TOPIC and s.reliable for s in replay)


@pytest.mark.asyncio
async def test_snapshot_replays_the_whole_call_in_order() -> None:
    room = FakeRoom(delays=[0.01, 0.0, 0.005])
    publisher = TelemetryPublisher(room)
    publisher.start()

    for i in range(5):
        publisher.emit(make_envelope(i))
    assert publisher.snapshot_to("observer-42") == 5
    await publisher.aclose()

    replay = [s.ts for s in room.local_participant.published if s.destinations]
    assert replay == [0.0, 1.0, 2.0, 3.0, 4.0]


@pytest.mark.asyncio
async def test_snapshot_precedes_later_live_envelopes() -> None:
    """The observer must see the call so far before it sees what happens next —
    otherwise the catch-up overwrites live state the cockpit already rendered."""
    room = FakeRoom(delays=[0.005, 0.0])
    publisher = TelemetryPublisher(room)
    publisher.start()

    publisher.emit(make_envelope(0))
    publisher.snapshot_to("observer-42")
    publisher.emit(make_envelope(1))
    await publisher.aclose()

    # Broadcast 0, the addressed replay of 0, then broadcast 1 — the envelope emitted
    # after the observer joined is never transmitted ahead of the catch-up.
    assert [(s.ts, s.destinations) for s in room.local_participant.published] == [
        (0.0, ()),
        (0.0, ("observer-42",)),
        (1.0, ()),
    ]


@pytest.mark.asyncio
async def test_snapshot_is_not_recorded_in_the_debrief() -> None:
    """`messages` is what the call emitted, not how many times it was transmitted."""
    publisher = TelemetryPublisher(FakeRoom())
    publisher.start()

    publisher.emit(make_envelope(0))
    publisher.snapshot_to("observer-42")
    await publisher.aclose()

    assert [m["ts"] for m in publisher.messages] == [0.0]


@pytest.mark.asyncio
async def test_snapshot_before_any_telemetry_sends_nothing() -> None:
    """An observer that beats the first envelope needs no catch-up — it is already live."""
    room = FakeRoom()
    publisher = TelemetryPublisher(room)
    publisher.start()

    assert publisher.snapshot_to("observer-42") == 0
    await publisher.aclose()
    assert room.local_participant.published == []


@pytest.mark.asyncio
async def test_two_observers_each_get_their_own_copy() -> None:
    room = FakeRoom()
    publisher = TelemetryPublisher(room)
    publisher.start()

    publisher.emit(make_envelope(0))
    publisher.snapshot_to("observer-a")
    publisher.snapshot_to("observer-b")
    await publisher.aclose()

    assert [s.destinations for s in room.local_participant.published] == [
        (),
        ("observer-a",),
        ("observer-b",),
    ]


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

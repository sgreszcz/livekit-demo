"""Glass Cockpit — a LiveKit voice agent that publishes its own live telemetry.

Run locally against your microphone:      python agent.py console
Run as a worker against LiveKit Cloud:    python agent.py start

The whole pipeline (STT, LLM, TTS, turn detection) runs on LiveKit Inference, so the
only credentials needed are the standard LIVEKIT_URL / LIVEKIT_API_KEY /
LIVEKIT_API_SECRET trio.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import random
import time
from collections.abc import Callable, Sequence
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentFalseInterruptionEvent,
    AgentServer,
    AgentSession,
    AgentStateChangedEvent,
    CloseEvent,
    ConversationItemAddedEvent,
    JobContext,
    MetricsCollectedEvent,
    RunContext,
    SpeechCreatedEvent,
    UserInputTranscribedEvent,
    cli,
    function_tool,
    inference,
)
from livekit.agents.metrics import EOUMetrics, LLMMetrics, STTMetrics, TTSMetrics
from livekit.agents.voice.speech_handle import SpeechHandle

from chaos import (
    DEFAULT_SLOW_LLM_MODEL,
    ChaosCommand,
    ChaosController,
    ChaosIntensity,
    DelayedLLM,
    DelayedTTS,
    VoiceInjection,
    parse_control_message,
    plan_voice_chaos,
)
from telemetry import (
    CONTROL_TOPIC,
    DebriefUploader,
    PipelineModels,
    TelemetryPublisher,
    TurnStore,
    classify_entry_room,
    envelope,
    is_observer,
    log_call_summary,
    redact_room_name,
)

load_dotenv()

logger = logging.getLogger("glass-cockpit")

STT_MODEL = os.getenv("COCKPIT_STT_MODEL", "deepgram/nova-3")
LLM_MODEL = os.getenv("COCKPIT_LLM_MODEL", "openai/gpt-4.1-mini")
TTS_MODEL = os.getenv("COCKPIT_TTS_MODEL", "cartesia/sonic-3")
# Chaos mode's "slow model" swap. Read here rather than in chaos.py because module-level
# env reads in an imported module would run before load_dotenv() below.
SLOW_LLM_MODEL = os.getenv("COCKPIT_SLOW_LLM_MODEL", DEFAULT_SLOW_LLM_MODEL)

INSTRUCTIONS = """\
You are the guide for "Glass Cockpit", a live demonstration of a LiveKit voice agent \
that publishes its own telemetry. You are speaking to a visitor over a voice call, and \
beside you on their screen is a dashboard rendering every measurement of this very \
conversation, in real time.

What you are:
- A Python voice agent on the LiveKit Agents framework. Speech-to-text, the language \
model, text-to-speech and turn detection all run on LiveKit Inference.
- Every turn you take is measured and streamed to that dashboard over the room's data \
channel: end-of-utterance detection, transcription delay, time to first token, time to \
first audio byte, interruptions, token counts and a running cost estimate.

Who built you:
- Steve Greszczyszyn. Twenty years in Cisco voice infrastructure, now building AI \
agents. He built this as a Forward-Deployed-Engineer-style reference implementation: \
the kind of thing you hand a customer to show that a voice agent can be operated, not \
just demoed.

What you can explain, when asked:
- The latency waterfall. Turn detection is deciding the caller has finished speaking. \
Time to first token is the language model starting to respond. Time to first byte is \
speech synthesis starting to return audio. Their sum is roughly what the caller \
experiences as "how long before it answered me".
- Chaos mode: the visitor can degrade this very call and watch the waterfall react the \
way a slow region or an overloaded provider would look in production. They can arm it \
from the dashboard, or simply ask you out loud — which is the only way for someone on \
a phone. Four injections: artificial latency in front of the language model, artificial \
latency in front of speech synthesis, swapping you onto a deliberately heavier model, \
and clamping how many tokens you are allowed to answer with — that last one will cut \
you off mid-sentence, which is the point, so do not apologise for it or work around it.
- Your own numbers: call the get_call_metrics tool and read the result back \
conversationally. Never invent latency or cost figures — always use the tool.

Offering chaos mode:
- Once you have actually answered something of theirs — their first real question, or \
any time they ask what you can do or what else there is — offer it, briefly, and do not \
keep offering: you can degrade yourself on purpose while they listen, with artificial \
latency, a heavier model, or answers clipped off mid-sentence, and you can pick one at \
random if they would rather be surprised. Mild or severe, their choice.
- Never arm it unless they asked for it or agreed to it. Never arm it unprompted.
- Arm it with the set_chaos tool, always — it is the only thing that actually changes \
the pipeline. Its reply is written to be spoken, so say what it gives you rather than \
inventing your own numbers, and always tell them what you applied and that the \
dashboard will flag this turn as degraded.
- If they ask you to stop it, turn it off, or go back to normal, call set_chaos with \
"off".

How you speak:
- Professional and concise, the way a good solutions engineer demos to a customer. \
Two or three sentences unless asked to go deeper. This is a voice call, so no markdown, \
no bullet points, and expand numbers into words the way a person would say them.
- Confident about what the system does and honest about what it estimates. The cost \
figure is an approximation, and you say so if it comes up.
- Never gimmicky. No jokes about being an AI, no theatrics. The engineering is the show.

You have already greeted the visitor. The call opened with a fixed spoken greeting that \
welcomed them to Glass Cockpit, told them every measurement of this call is streaming to \
the dashboard, and invited them to ask anything or to ask how the call quality is. Do not \
greet them again and do not reintroduce yourself — pick the conversation up from there, \
and if their first question is broad, offer the latency waterfall or chaos mode as places \
to start.

If they ask who can see this — whether the call is public, recorded, or being watched — \
be straight with them rather than reassuring: the dashboard for this call is reachable by \
anyone with the link, a read-only observer can join at any point and is replayed \
everything measured so far, and what they see is telemetry and transcripts, not the audio. \
Answer it plainly and move on; do not volunteer it unprompted.
"""

# Spoken verbatim the moment the session starts, instead of asking the model to compose a
# greeting. A generated opener costs a full LLM round-trip before the first audio byte —
# on a demo whose entire subject is latency, the first thing the visitor experiences must
# not be the slowest thing on the call.
#
# A spoken observation notice was tried here and deliberately removed. Every word of this
# sentence is on the critical path of the one number this demo exists to show, and the
# disclosure does not need to be spoken to be given: it lives on the web page, where a
# visitor reads it before the call starts and it costs no audio at all. The persona is
# still instructed (see INSTRUCTIONS) to answer honestly the moment a caller asks who can
# see this — which is free at runtime and is where the question actually gets asked.
GREETING = (
    "Welcome to Glass Cockpit. You're talking to a live LiveKit voice agent, and every "
    "measurement of this call — including this sentence — is streaming to the dashboard. "
    "Ask me anything, or ask how the call quality is."
)


class ChaosBroadcaster:
    """Applies a chaos change and announces the resulting state. One per call.

    Chaos can now be armed two ways — the browser's ``cockpit-control`` packets and the
    caller's own voice — and the two must never be able to disagree. They share this:
    one :class:`ChaosController`, and one place the ack envelope is built. A second
    envelope literal somewhere else is exactly how a browser panel ends up showing a
    state the pipeline is not in.
    """

    def __init__(self, chaos: ChaosController, publisher: TelemetryPublisher) -> None:
        self._chaos = chaos
        self._publisher = publisher

    @property
    def chaos(self) -> ChaosController:
        return self._chaos

    def apply(self, command: ChaosCommand) -> dict[str, Any]:
        """Apply a command, publish the full-state ack, and return the envelope sent.

        The ack carries the whole state, not the delta: a cockpit that joined mid-call,
        one whose own request was partly rejected as malformed, or one that never asked
        for this change at all because the caller asked for it out loud, has no other
        way to learn what the agent is actually doing.
        """
        self._chaos.apply(command)
        payload = self._chaos.envelope_payload()
        logger.info("chaos state: %s", payload)
        env = envelope("chaos", payload, ts=time.time())
        self._publisher.emit(env)
        return env


def apply_control_packet(data: bytes, broadcaster: ChaosBroadcaster) -> dict[str, Any] | None:
    """The browser control path: parse a ``cockpit-control`` payload and apply it.

    Module level rather than a closure so the data-channel path is reachable from a
    test — the voice path has to be provably identical to it, and a path that can only
    be exercised by standing up a room cannot be compared against anything.
    """
    command = parse_control_message(data)
    if command is None:
        return None
    return broadcaster.apply(command)


class GlassCockpitAgent(Agent):
    """The demo guide, with read access to the call's own telemetry.

    Both tools reach the live call through objects handed in at construction — the turn
    store for reading, the chaos broadcaster for writing — rather than through anything
    global, so the agent is exactly as testable as the pieces it is given.
    """

    def __init__(
        self,
        store: TurnStore,
        chaos: ChaosBroadcaster,
        *,
        chooser: Callable[[Sequence[str]], str] = random.choice,
    ) -> None:
        super().__init__(instructions=INSTRUCTIONS)
        self._store = store
        self._chaos = chaos
        self._chooser = chooser

    @function_tool
    async def get_call_metrics(self, ctx: RunContext) -> str:
        """Read this call's live latency, interruption and cost telemetry.

        Call this whenever the visitor asks how the call is performing, how fast you
        are, what the last turn cost, or how chaos mode is affecting things. Speak the
        result back conversationally rather than reciting it verbatim.
        """
        return self._store.summary()

    @function_tool
    async def set_chaos(
        self,
        ctx: RunContext,
        injection: VoiceInjection,
        intensity: ChaosIntensity = "mild",
    ) -> str:
        """Degrade this call on purpose, the way the dashboard's chaos panel does.

        Call this ONLY when the visitor has asked for a degradation or agreed to one
        being offered. Never call it unprompted.

        injection:
          latency — artificial delay in front of the language model, so answers start
            coming back later.
          voice_delay — artificial delay in front of speech synthesis, so there is a
            longer pause before you start talking.
          slow_model — swap onto a deliberately heavier language model.
          token_starvation — clamp how many tokens you may answer with, so answers cut
            off mid-sentence. That is the intended effect; do not apologise for it.
          random — pick one of the four at random, for a visitor who would rather be
            surprised.
          off — clear every injection and return to normal. Use this whenever they ask
            you to stop, turn it off, or go back to normal.

        intensity: "mild" or "severe". Ignored by slow_model, which has one setting.

        Each call replaces the whole chaos state rather than adding to it, so exactly
        one injection is ever armed and repeating a call is harmless. The reply is a
        sentence written to be spoken — say it, rather than describing it.
        """
        plan = plan_voice_chaos(injection, intensity, chooser=self._chooser)
        self._chaos.apply(plan.command)
        return plan.spoken


def _wire_telemetry(
    session: AgentSession,
    store: TurnStore,
    publisher: TelemetryPublisher,
) -> None:
    """Subscribe to the session events that feed the cockpit."""
    # Held so barge-in detection can ask whether the speech the agent was delivering
    # was actually interrupted. session.current_speech may already be cleared by the
    # time the state change fires, but the handle we captured stays truthful.
    active_speech: SpeechHandle | None = None

    @session.on("speech_created")
    def _on_speech_created(ev: SpeechCreatedEvent) -> None:
        nonlocal active_speech
        active_speech = ev.speech_handle

    @session.on("metrics_collected")
    def _on_metrics(ev: MetricsCollectedEvent) -> None:
        m = ev.metrics
        if isinstance(m, EOUMetrics):
            publisher.emit_all(
                store.record_eou(
                    m.speech_id,
                    end_of_utterance_delay=m.end_of_utterance_delay,
                    transcription_delay=m.transcription_delay,
                )
            )
        elif isinstance(m, LLMMetrics):
            # speech_id is attached by the SDK from a context variable. Fall back to
            # the turn in flight rather than dropping a whole stage of the waterfall.
            turn_id = m.speech_id or store.current_turn_id
            if turn_id is None:
                return
            publisher.emit(
                store.record_llm(
                    turn_id,
                    ttft=m.ttft,
                    duration=m.duration,
                    prompt_tokens=m.prompt_tokens,
                    completion_tokens=m.completion_tokens,
                    # Identifies the completion, and with it the chaos delay that was
                    # actually injected in front of this invocation.
                    request_id=m.request_id,
                )
            )
        elif isinstance(m, TTSMetrics):
            turn_id = m.speech_id or store.current_turn_id
            if turn_id is None:
                return
            publisher.emit(
                store.record_tts(
                    turn_id,
                    ttfb=m.ttfb,
                    duration=m.duration,
                    audio_duration=m.audio_duration,
                    characters_count=m.characters_count,
                    # Identifies the synthesis, and with it the chaos delay actually
                    # injected in front of this segment.
                    request_id=m.request_id,
                )
            )
        elif isinstance(m, STTMetrics):
            # Buffered; published by record_eou once the turn has an id.
            store.record_stt(duration=m.duration, audio_duration=m.audio_duration)

    @session.on("user_input_transcribed")
    def _on_user_transcript(ev: UserInputTranscribedEvent) -> None:
        # Also buffered: no speech id exists until end-of-utterance.
        if ev.is_final:
            store.record_user_transcript(ev.transcript)

    @session.on("conversation_item_added")
    def _on_item(ev: ConversationItemAddedEvent) -> None:
        # The event also fires for non-message items (e.g. AgentHandoff), which
        # have no role attribute.
        if getattr(ev.item, "role", None) == "assistant" and ev.item.text_content:
            publisher.emit(store.record_agent_transcript(ev.item.text_content))

    @session.on("agent_state_changed")
    def _on_state(ev: AgentStateChangedEvent) -> None:
        publisher.emit_all(
            store.record_state(
                ev.old_state,
                ev.new_state,
                speech_interrupted=active_speech is not None and active_speech.interrupted,
            )
        )
        # A turn is finished once the agent stops speaking; report usage then.
        if ev.old_state == "speaking":
            publisher.emit(store.record_usage())

    @session.on("agent_false_interruption")
    def _on_false_interruption(ev: AgentFalseInterruptionEvent) -> None:
        publisher.emit(store.record_false_interruption())


# The participant kinds a human caller can arrive as — the same set the SDK's own
# wait_for_participant defaults to (CONNECTOR, SIP, STANDARD). Excludes other agents.
CALLER_KINDS = (
    rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
    rtc.ParticipantKind.PARTICIPANT_KIND_SIP,
    rtc.ParticipantKind.PARTICIPANT_KIND_CONNECTOR,
)


def is_caller(participant: rtc.Participant) -> bool:
    """True for the human this call is with — not an observer cockpit, not an agent."""
    return participant.kind in CALLER_KINDS and not is_observer(participant.identity)


def classify_entry(participant: rtc.Participant) -> str:
    """Classify how the caller reached us: a SIP trunk, or a browser."""
    if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
        return "sip"
    return "browser"


async def wait_for_caller(room: rtc.Room) -> rtc.RemoteParticipant:
    """Wait for the participant this call is actually with.

    ``JobContext.wait_for_participant`` cannot be used here: it filters on exact identity
    or on participant kind, and an observer cockpit is an ordinary STANDARD participant —
    indistinguishable by kind from the caller. Given a room the caller has not joined yet,
    it would return the first observer to arrive and the call would be classified, and
    reported, against the wrong participant. Identity is the only signal that separates
    them, so the wait is reimplemented with an identity filter.

    Participants already in the room are considered first, then both connection events:
    ``participant_connected`` fires on arrival, ``participant_active`` once the participant
    is ready to exchange media, and either can come first depending on the kind.
    """
    fut: asyncio.Future[rtc.RemoteParticipant] = asyncio.get_running_loop().create_future()

    def _consider(participant: rtc.RemoteParticipant) -> None:
        if not fut.done() and is_caller(participant):
            fut.set_result(participant)

    for participant in list(room.remote_participants.values()):
        _consider(participant)
    if fut.done():
        return fut.result()

    room.on("participant_connected", _consider)
    room.on("participant_active", _consider)
    try:
        return await fut
    finally:
        room.off("participant_connected", _consider)
        room.off("participant_active", _consider)


async def _warn_on_entry_mismatch(room: rtc.Room, expected: str) -> None:
    """Cross-check the room-name entry classification against the real caller.

    ``classify_entry_room`` is authoritative — it is synchronous, it cannot fail, and the
    worker classifies the same way — but it is an inference from a naming convention, and
    a naming convention can change under us. This watches for that: it waits for the
    caller, compares, and logs if they disagree.

    It is deliberately fire-and-forget and deliberately gates NOTHING. Its predecessor
    was awaited inline, and because ``wait_for_caller`` has no timeout, a caller who hung
    up before the agent finished connecting meant the await never resolved — so the
    shutdown callback registered after it was never registered, and the call left no
    record whatsoever. That await is why calls disappeared; it never gets to block again.
    """
    try:
        participant = await wait_for_caller(room)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("entry cross-check failed")
        return
    observed = classify_entry(participant)
    if observed != expected:
        logger.warning(
            "entry mismatch: room name implies %s but caller %s is %s — the room naming "
            "convention may have changed",
            expected,
            # A SIP participant identity is `sip_+447700900123` — the caller's
            # number. This warning fires precisely when room naming has changed
            # under us, which is exactly when somebody will be reading the logs.
            redact_room_name(participant.identity),
            observed,
        )


def _close_reason(reason: Any) -> str:
    """The wire value of a ``CloseReason``, e.g. ``participant_disconnected``.

    ``CloseReason`` is a ``str`` Enum, so ``str()`` on it yields ``CloseReason.X`` rather
    than the value a log aggregator should group by; ``.value`` is the stable name.
    """
    return str(getattr(reason, "value", reason))


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    chaos = ChaosController()
    models = PipelineModels(stt=STT_MODEL, llm=LLM_MODEL, tts=TTS_MODEL)
    store = TurnStore(
        models=models,
        applied_llm_chaos=chaos.llm_applied.take,
        applied_tts_chaos=chaos.tts_applied.take,
    )
    publisher = TelemetryPublisher(ctx.room)
    # The one path to the controller, shared by the browser panel and the voice tool.
    broadcaster = ChaosBroadcaster(chaos, publisher)
    started_at = time.time()

    await ctx.connect()
    publisher.start()

    @ctx.room.on("data_received")
    def _on_data(packet: rtc.DataPacket) -> None:
        if packet.topic != CONTROL_TOPIC:
            return
        apply_control_packet(packet.data, broadcaster)

    @ctx.room.on("participant_connected")
    def _on_participant_connected(participant: rtc.RemoteParticipant) -> None:
        # A cockpit that joined mid-call missed everything published before it arrived.
        # Catch it up, addressed to it alone — the caller has already seen all of this.
        if is_observer(participant.identity):
            publisher.snapshot_to(participant.identity)

    # Everything from here to add_shutdown_callback is either synchronous or a bounded
    # await, on purpose. This is the window in which the call becomes recoverable, and
    # nothing that can block indefinitely is allowed inside it — see
    # _warn_on_entry_mismatch for the await that used to be here and why it isn't.
    call_id = await ctx.room.sid or ctx.job.id
    entry = classify_entry_room(ctx.room.name)
    # Redacted before it is ever stored or transmitted. `call_meta` goes on the data
    # channel to every participant, observers included, and into the debrief that anyone
    # holding a share link can fetch; a SIP room name carries the caller's number.
    meta = store.call_meta(
        call_id=call_id,
        room=redact_room_name(ctx.room.name),
        started_at=started_at,
        entry=entry,
    )
    publisher.emit(meta)

    uploader = DebriefUploader(
        url=os.getenv("DEBRIEF_URL"),
        token=os.getenv("DEBRIEF_TOKEN"),
        call_id=call_id,
        meta=meta["payload"],
        publisher=publisher,
    )
    uploader.start()

    # The session close time, captured the moment it happens. The job can outlive the
    # session by minutes, so this is the only truthful `ended_at`; falling back to the
    # job's own clock is what once stored a 10.5-second call as 4376 seconds long.
    closed_at: float | None = None
    # Strong references. `asyncio.create_task` only keeps a weak one, so a task nobody
    # holds can be garbage-collected mid-await; the final debrief is not something to
    # leave to the collector's discretion.
    flush_task: asyncio.Task[None] | None = None
    entry_task: asyncio.Task[None] | None = None
    # Exactly one `call_summary` line per call: a log aggregator counts lines, and a
    # second one from the shutdown path would double every call in the fleet totals.
    # The final UPLOAD is retried on failure; the summary is not, because it cannot fail.
    summarised = False

    async def _finish(reason: str, ended_at: float) -> None:
        """Log the call summary and flush the final debrief. Never raises."""
        nonlocal summarised
        try:
            if not summarised:
                summarised = True
                log_call_summary(
                    store.call_summary(
                        call_id=call_id,
                        entry=entry,
                        # Redacted inside call_summary; the raw name never leaves here.
                        room=ctx.room.name,
                        close_reason=reason,
                        started_at=started_at,
                        ended_at=ended_at,
                    ),
                    log=logger,
                )
        except Exception:
            logger.exception("failed to build the call summary")
        share_url = await uploader.finalize(ended_at=ended_at)
        if share_url:
            logger.info("call replay available at %s", share_url)

    async def _debrief() -> None:
        """Job-shutdown path: belt to the session-close braces.

        Runs when the ROOM closes, which is not when the call ends — an observer or an
        abandoned tab can hold a room open indefinitely after the caller hangs up. By
        then `finalize` has usually already succeeded and this is a no-op; it earns its
        keep when the session-close flush failed, or when the job dies without the
        session ever emitting `close` at all.
        """
        if entry_task is not None:
            entry_task.cancel()
        if flush_task is not None and not flush_task.done():
            # Let the session-close flush finish rather than racing it. It is bounded by
            # FINAL_TIMEOUT, and cancelling an upload that is about to succeed in order
            # to start the same upload again is the worst use of a 10 s budget.
            with contextlib.suppress(Exception):
                await flush_task
        await publisher.aclose()
        await _finish("job_shutdown", closed_at if closed_at is not None else time.time())

    ctx.add_shutdown_callback(_debrief)

    # Diagnostic only, and started only now that the call is already recoverable.
    entry_task = asyncio.create_task(_warn_on_entry_mismatch(ctx.room, entry), name="cockpit-entry")

    session = AgentSession(
        stt=models.stt,
        # Both chaos wrappers are constructed with real Inference plugins rather than
        # letting AgentSession resolve the model strings: a wrapper has to own the
        # stream the SDK measures, and it cannot wrap a plugin it never sees. The slow
        # model is built up front and kept warm so the swap costs nothing mid-call.
        llm=DelayedLLM(
            inference.LLM(model=models.llm),
            chaos,
            slow=inference.LLM(model=SLOW_LLM_MODEL),
        ),
        tts=DelayedTTS(inference.TTS(model=models.tts), chaos),
        turn_detection=inference.TurnDetector(),
    )
    _wire_telemetry(session, store, publisher)

    @session.on("close")
    def _on_close(ev: CloseEvent) -> None:
        """Flush the debrief when the CALL ends, not when the job does.

        This is the fix for the failure that lost most of production's calls. The job
        shuts down when the ROOM closes, and a room stays open while anyone is in it: an
        observer cockpit that joined to watch, or a browser tab someone forgot. Observed
        live — the session closed on a SIP hangup and eleven minutes later the process
        was still running with the debrief unposted, one drain or redeploy away from
        losing the call for good. The session-close event is the first moment the system
        knows the call is over, so it is where the record gets written.

        The SDK dispatches this handler synchronously, so the work is handed to a task —
        and the task is held, because create_task alone would not.
        """
        nonlocal closed_at, flush_task
        if closed_at is None:
            closed_at = ev.created_at
        if flush_task is not None:
            return
        logger.info("session closed (%s); flushing debrief", _close_reason(ev.reason))
        flush_task = asyncio.create_task(
            _finish(_close_reason(ev.reason), ev.created_at), name="cockpit-final-debrief"
        )

    await session.start(agent=GlassCockpitAgent(store, broadcaster), room=ctx.room)
    # say(), not generate_reply(): the greeting is fixed text, so there is nothing to
    # think about and no reason to make the visitor wait for a completion before the
    # first audio byte. It still goes through the full speech path — a SpeechHandle,
    # a "speech_created" event (so barge-in tracking covers the greeting), TTS metrics
    # tagged with its speech id, and an assistant message in the chat context — so the
    # cockpit renders a normal, if partial, agent-initiated turn.
    session.say(GREETING)


if __name__ == "__main__":
    cli.run_app(server)

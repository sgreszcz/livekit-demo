"""Glass Cockpit — a LiveKit voice agent that publishes its own live telemetry.

Run locally against your microphone:      python agent.py console
Run as a worker against LiveKit Cloud:    python agent.py start

The whole pipeline (STT, LLM, TTS, turn detection) runs on LiveKit Inference, so the
only credentials needed are the standard LIVEKIT_URL / LIVEKIT_API_KEY /
LIVEKIT_API_SECRET trio.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentFalseInterruptionEvent,
    AgentServer,
    AgentSession,
    AgentStateChangedEvent,
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
    ChaosController,
    DelayedLLM,
    DelayedTTS,
    parse_control_message,
)
from telemetry import (
    CONTROL_TOPIC,
    PipelineModels,
    TelemetryPublisher,
    TurnStore,
    envelope,
    is_observer,
    post_debrief,
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
- Chaos mode: from the dashboard the visitor can degrade this very call and watch the \
waterfall react the way a slow region or an overloaded provider would look in \
production. Four injections: artificial latency in front of the language model, \
artificial latency in front of speech synthesis, swapping you onto a deliberately \
heavier model, and clamping how many tokens you are allowed to answer with — that last \
one will cut you off mid-sentence, which is the point, so do not apologise for it or \
work around it.
- Your own numbers: call the get_call_metrics tool and read the result back \
conversationally. Never invent latency or cost figures — always use the tool.

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
"""

# Spoken verbatim the moment the session starts, instead of asking the model to compose a
# greeting. A generated opener costs a full LLM round-trip before the first audio byte —
# on a demo whose entire subject is latency, the first thing the visitor experiences must
# not be the slowest thing on the call.
GREETING = (
    "Welcome to Glass Cockpit. You're talking to a live LiveKit voice agent, and every "
    "measurement of this call — including this sentence — is streaming to the dashboard. "
    "Ask me anything, or ask how the call quality is."
)


class GlassCockpitAgent(Agent):
    """The demo guide, with read access to the call's own telemetry."""

    def __init__(self, store: TurnStore) -> None:
        super().__init__(instructions=INSTRUCTIONS)
        self._store = store

    @function_tool
    async def get_call_metrics(self, ctx: RunContext) -> str:
        """Read this call's live latency, interruption and cost telemetry.

        Call this whenever the visitor asks how the call is performing, how fast you
        are, what the last turn cost, or how chaos mode is affecting things. Speak the
        result back conversationally rather than reciting it verbatim.
        """
        return self._store.summary()


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


async def _resolve_entry(ctx: JobContext) -> str:
    return classify_entry(await wait_for_caller(ctx.room))


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
    started_at = time.time()

    await ctx.connect()
    publisher.start()

    @ctx.room.on("data_received")
    def _on_data(packet: rtc.DataPacket) -> None:
        if packet.topic != CONTROL_TOPIC:
            return
        command = parse_control_message(packet.data)
        if command is None:
            return
        chaos.apply(command)
        # The ack carries the whole state, not the delta: a cockpit that joined
        # mid-call, or one whose own request was partly rejected as malformed, has no
        # other way to learn what the agent is actually doing.
        payload = chaos.envelope_payload()
        logger.info("chaos state: %s", payload)
        publisher.emit(envelope("chaos", payload, ts=time.time()))

    @ctx.room.on("participant_connected")
    def _on_participant_connected(participant: rtc.RemoteParticipant) -> None:
        # A cockpit that joined mid-call missed everything published before it arrived.
        # Catch it up, addressed to it alone — the caller has already seen all of this.
        if is_observer(participant.identity):
            publisher.snapshot_to(participant.identity)

    entry = await _resolve_entry(ctx)
    call_id = await ctx.room.sid or ctx.job.id
    meta = store.call_meta(call_id=call_id, room=ctx.room.name, started_at=started_at, entry=entry)
    publisher.emit(meta)

    async def _debrief() -> None:
        await publisher.aclose()
        share_url = await post_debrief(
            url=os.getenv("DEBRIEF_URL"),
            token=os.getenv("DEBRIEF_TOKEN"),
            call_id=call_id,
            meta=meta["payload"],
            messages=publisher.messages,
            ended_at=time.time(),
        )
        if share_url:
            logger.info("call replay available at %s", share_url)

    ctx.add_shutdown_callback(_debrief)

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

    await session.start(agent=GlassCockpitAgent(store), room=ctx.room)
    # say(), not generate_reply(): the greeting is fixed text, so there is nothing to
    # think about and no reason to make the visitor wait for a completion before the
    # first audio byte. It still goes through the full speech path — a SpeechHandle,
    # a "speech_created" event (so barge-in tracking covers the greeting), TTS metrics
    # tagged with its speech id, and an assistant message in the chat context — so the
    # cockpit renders a normal, if partial, agent-initiated turn.
    session.say(GREETING)


if __name__ == "__main__":
    cli.run_app(server)

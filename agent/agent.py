"""Glass Cockpit — a LiveKit voice agent that publishes its own live telemetry.

Run locally against your microphone:      python agent.py console
Run as a worker against LiveKit Cloud:    python agent.py start

The whole pipeline (STT, LLM, TTS, turn detection) runs on LiveKit Inference, so the
only credentials needed are the standard LIVEKIT_URL / LIVEKIT_API_KEY /
LIVEKIT_API_SECRET trio.
"""

from __future__ import annotations

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

from chaos import ChaosController, DelayedLLM, parse_control_message
from telemetry import (
    CONTROL_TOPIC,
    PipelineModels,
    TelemetryPublisher,
    TurnStore,
    envelope,
    post_debrief,
)

load_dotenv()

logger = logging.getLogger("glass-cockpit")

STT_MODEL = os.getenv("COCKPIT_STT_MODEL", "deepgram/nova-3")
LLM_MODEL = os.getenv("COCKPIT_LLM_MODEL", "openai/gpt-4.1-mini")
TTS_MODEL = os.getenv("COCKPIT_TTS_MODEL", "cartesia/sonic-3")

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
- Chaos mode: the visitor can inject artificial latency in front of the language model \
from the dashboard, or ask you to describe it, and watch the waterfall degrade the way \
a slow region or an overloaded provider would look in production.
- Your own numbers: call the get_call_metrics tool and read the result back \
conversationally. Never invent latency or cost figures — always use the tool.

How you speak:
- Professional and concise, the way a good solutions engineer demos to a customer. \
Two or three sentences unless asked to go deeper. This is a voice call, so no markdown, \
no bullet points, and expand numbers into words the way a person would say them.
- Confident about what the system does and honest about what it estimates. The cost \
figure is an approximation, and you say so if it comes up.
- Never gimmicky. No jokes about being an AI, no theatrics. The engineering is the show.

Open the call by greeting the visitor, telling them briefly what they're looking at, and \
inviting them to ask about the numbers or to try chaos mode.
"""


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


async def _resolve_entry(ctx: JobContext) -> str:
    """Classify how the caller reached us: a SIP trunk, or a browser."""
    participant = await ctx.wait_for_participant()
    is_sip = participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP
    return "sip" if is_sip else "browser"


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    chaos = ChaosController()
    models = PipelineModels(stt=STT_MODEL, llm=LLM_MODEL, tts=TTS_MODEL)
    store = TurnStore(models=models, applied_delay=chaos.applied.take)
    publisher = TelemetryPublisher(ctx.room)
    started_at = time.time()

    await ctx.connect()
    publisher.start()

    @ctx.room.on("data_received")
    def _on_data(packet: rtc.DataPacket) -> None:
        if packet.topic != CONTROL_TOPIC:
            return
        delay_ms = parse_control_message(packet.data)
        if delay_ms is None:
            return
        chaos.set_delay_ms(delay_ms)
        logger.info("chaos delay set to %d ms", chaos.delay_ms)
        publisher.emit(envelope("chaos", chaos.envelope_payload(), ts=time.time()))

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
        llm=DelayedLLM(inference.LLM(model=models.llm), chaos),
        tts=models.tts,
        turn_detection=inference.TurnDetector(),
    )
    _wire_telemetry(session, store, publisher)

    await session.start(agent=GlassCockpitAgent(store), room=ctx.room)
    session.generate_reply()


if __name__ == "__main__":
    cli.run_app(server)

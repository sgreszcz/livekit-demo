"""Approximate unit prices for the models in the Glass Cockpit pipeline.

These are hand-maintained ballpark figures used only to render a live running cost
in the cockpit. They are **not** billing-accurate: providers change list prices,
volume tiers apply, and LiveKit Inference bundles its own margin. The UI labels
every figure as approximate, and so should you.

Update the tables below rather than sprinkling magic numbers through the agent.
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = [
    "LLM_PRICES",
    "STT_USD_PER_MINUTE",
    "TTS_USD_PER_MILLION_CHARS",
    "LLMPrice",
    "estimate_cost_usd",
]


@dataclass(frozen=True)
class LLMPrice:
    """List price in USD per million tokens."""

    prompt: float
    completion: float


# USD per million tokens.
LLM_PRICES: dict[str, LLMPrice] = {
    "openai/gpt-4.1-mini": LLMPrice(prompt=0.40, completion=1.60),
    "openai/gpt-4.1-nano": LLMPrice(prompt=0.10, completion=0.40),
    "openai/gpt-4.1": LLMPrice(prompt=2.00, completion=8.00),
    "openai/gpt-4o-mini": LLMPrice(prompt=0.15, completion=0.60),
    "openai/gpt-4o": LLMPrice(prompt=2.50, completion=10.00),
    "google/gemini-2.5-flash": LLMPrice(prompt=0.30, completion=2.50),
    "google/gemini-2.5-flash-lite": LLMPrice(prompt=0.10, completion=0.40),
}

# USD per minute of audio transcribed.
STT_USD_PER_MINUTE: dict[str, float] = {
    "deepgram/nova-3": 0.0077,
    "deepgram/nova-2": 0.0058,
    "cartesia/ink-whisper": 0.0060,
    "assemblyai/universal-streaming": 0.0050,
}

# USD per million characters synthesised.
TTS_USD_PER_MILLION_CHARS: dict[str, float] = {
    "cartesia/sonic-3": 10.0,
    "cartesia/sonic-2": 10.0,
    "cartesia/sonic-turbo": 10.0,
    "elevenlabs/eleven_flash_v2_5": 30.0,
    "deepgram/aura-2": 15.0,
}

# Used when a configured model is missing from the tables above, so an unknown
# model degrades to a plausible estimate instead of silently costing nothing.
DEFAULT_LLM_PRICE = LLMPrice(prompt=0.40, completion=1.60)
DEFAULT_STT_USD_PER_MINUTE = 0.0077
DEFAULT_TTS_USD_PER_MILLION_CHARS = 10.0


def estimate_cost_usd(
    *,
    llm_model: str,
    prompt_tokens: int,
    completion_tokens: int,
    stt_model: str,
    stt_audio_seconds: float,
    tts_model: str,
    tts_characters: int,
) -> float:
    """Estimate the cumulative USD cost of a call from running usage totals."""
    llm_price = LLM_PRICES.get(llm_model, DEFAULT_LLM_PRICE)
    stt_rate = STT_USD_PER_MINUTE.get(stt_model, DEFAULT_STT_USD_PER_MINUTE)
    tts_rate = TTS_USD_PER_MILLION_CHARS.get(tts_model, DEFAULT_TTS_USD_PER_MILLION_CHARS)

    cost = (
        prompt_tokens * llm_price.prompt / 1_000_000
        + completion_tokens * llm_price.completion / 1_000_000
        + stt_audio_seconds / 60.0 * stt_rate
        + tts_characters * tts_rate / 1_000_000
    )
    return round(cost, 4)

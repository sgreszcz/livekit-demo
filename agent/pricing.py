"""Approximate unit prices for the models in the Glass Cockpit pipeline.

These are hand-maintained ballpark figures used only to render a live running cost
in the cockpit. They are **not** billing-accurate: providers change list prices,
volume tiers apply, and LiveKit Inference bundles its own margin. The UI labels
every figure as approximate, and so should you.

Update the tables below rather than sprinkling magic numbers through the agent.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

__all__ = [
    "LLM_PRICES",
    "STT_USD_PER_MINUTE",
    "TTS_USD_PER_MILLION_CHARS",
    "LLMPrice",
    "estimate_cost_usd",
    "llm_cost_usd",
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


def llm_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Unrounded USD for one model's share of a call."""
    price = LLM_PRICES.get(model, DEFAULT_LLM_PRICE)
    return (
        prompt_tokens * price.prompt / 1_000_000 + completion_tokens * price.completion / 1_000_000
    )


def estimate_cost_usd(
    *,
    llm_usage: Mapping[str, tuple[int, int]],
    stt_model: str,
    stt_audio_seconds: float,
    tts_model: str,
    tts_characters: int,
) -> float:
    """Estimate the cumulative USD cost of a call from running usage totals.

    ``llm_usage`` maps a model id to its ``(prompt_tokens, completion_tokens)``, because
    one call can legitimately span more than one model: chaos mode's slow-model swap
    moves the agent onto a model several times the price of the default (``gpt-4.1`` is
    five times ``gpt-4.1-mini``), and pricing every token at the configured model's rate
    would quietly understate the cost of exactly the turns the visitor switched on to
    watch. For the ordinary single-model call this is arithmetically identical to
    pricing the flat totals.
    """
    stt_rate = STT_USD_PER_MINUTE.get(stt_model, DEFAULT_STT_USD_PER_MINUTE)
    tts_rate = TTS_USD_PER_MILLION_CHARS.get(tts_model, DEFAULT_TTS_USD_PER_MILLION_CHARS)

    cost = (
        sum(
            llm_cost_usd(model, prompt, completion)
            for model, (prompt, completion) in llm_usage.items()
        )
        + stt_audio_seconds / 60.0 * stt_rate
        + tts_characters * tts_rate / 1_000_000
    )
    return round(cost, 4)

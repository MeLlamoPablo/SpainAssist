# Loaded by LiteLLM as a callback module (litellm_settings.callbacks: ["sa_pricing.handler"]).
# Registers OpenRouter's own prices (https://openrouter.ai/api/v1/models) for every model it
# serves, at start, every few hours and on a chat price miss, so spend reaches key budgets and
# a new model needs no deploy. LiteLLM's remote price list lags behind OpenRouter and its prices may be stale; OpenRouter
# is what we are billed.
import asyncio
import json
import sys
import threading
import time
import urllib.request

import litellm
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
REFRESH_SECONDS = 6 * 60 * 60
MISS_REFRESH_SECONDS = 60
_refresh_lock = threading.Lock()
_last_miss_refresh = float("-inf")

# Not in OpenRouter's model list: Perplexity Decider (document scan screening) through
# /openrouter/alpha/decisions. The app calls the alias that follows Perplexity's latest Flash
# decider (perplexity/pplx-decider-flash-v1.2 on 2026-10-17): check this price when it moves.
STATIC_PRICES = {
    "openrouter/~perplexity/pplx-decider-flash-latest": {
        "input_cost_per_token": 1e-08,
        "output_cost_per_token": 0.0,
        "litellm_provider": "openrouter",
        "mode": "evaluation",
    },
}

# OpenRouter pricing field -> LiteLLM price field (USD per token).
PRICE_FIELDS = {
    "prompt": "input_cost_per_token",
    "completion": "output_cost_per_token",
    "input_cache_read": "cache_read_input_token_cost",
    "input_cache_write": "cache_creation_input_token_cost",
    "audio": "input_cost_per_audio_token",
}


def price(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    # OpenRouter marks routers whose price depends on the model they pick with -1.
    return number if number >= 0 else None


def model_entry(model: dict) -> dict | None:
    """LiteLLM price entry for one OpenRouter model, or None when it has no usable price."""
    pricing = model.get("pricing") or {}
    entry: dict = {"litellm_provider": "openrouter", "mode": "chat"}
    for source, target in PRICE_FIELDS.items():
        value = price(pricing.get(source))
        if value is not None:
            entry[target] = value
    # Free and router models stay unpriced, so PricedModelsOnly keeps rejecting them.
    if not any(entry.get(f, 0) > 0 for f in ("input_cost_per_token", "output_cost_per_token")):
        return None
    for tier in pricing.get("overrides") or []:
        threshold = tier.get("min_prompt_tokens")
        if not isinstance(threshold, int) or threshold <= 0 or threshold % 1000:
            continue
        suffix = f"_above_{threshold // 1000}k_tokens"
        for source, target in (("prompt", "input_cost_per_token"), ("completion", "output_cost_per_token")):
            value = price(tier.get(source))
            if value is not None:
                entry[target + suffix] = value
    top = model.get("top_provider") or {}
    if isinstance(model.get("context_length"), int):
        entry["max_input_tokens"] = model["context_length"]
    if isinstance(top.get("max_completion_tokens"), int):
        entry["max_output_tokens"] = top["max_completion_tokens"]
    inputs = (model.get("architecture") or {}).get("input_modalities") or []
    params = model.get("supported_parameters") or []
    # Only set, never clear, flags: register_model merges into LiteLLM's own entry.
    for flag, supported in (
        ("supports_vision", "image" in inputs),
        ("supports_audio_input", "audio" in inputs),
        ("supports_function_calling", "tools" in params),
        ("supports_reasoning", "reasoning" in params),
    ):
        if supported:
            entry[flag] = True
    return entry


def openrouter_prices(models: list) -> dict:
    prices = {}
    for model in models:
        model_id = model.get("id") if isinstance(model, dict) else None
        entry = model_entry(model) if isinstance(model_id, str) else None
        if entry:
            prices[f"openrouter/{model_id}"] = entry
    return prices


def fetch_models() -> list:
    request = urllib.request.Request(OPENROUTER_MODELS_URL, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["data"]


def refresh(*, on_miss: bool = False) -> None:
    """Keep cached prices on failure; serialize refreshes and throttle catalog misses globally."""
    global _last_miss_refresh
    with _refresh_lock:
        if on_miss and time.monotonic() - _last_miss_refresh < MISS_REFRESH_SECONDS:
            return
        try:
            prices = openrouter_prices(fetch_models())
            litellm.register_model(prices)
        except Exception as error:  # noqa: BLE001: any failure keeps the previous prices
            # Printed: the proxy runs with LITELLM_LOG=ERROR, and this is no request error.
            print(f"sa_pricing: could not load OpenRouter prices: {error}", file=sys.stderr, flush=True)
        else:
            print(f"sa_pricing: registered {len(prices)} OpenRouter prices", file=sys.stderr, flush=True)
        finally:
            if on_miss:
                # Also throttle failures and different unknown names, without a per-model cache.
                _last_miss_refresh = time.monotonic()


def refresh_forever() -> None:
    stop = threading.Event()
    while not stop.wait(REFRESH_SECONDS):
        refresh()


litellm.register_model(STATIC_PRICES)
refresh()
threading.Thread(target=refresh_forever, name="sa-pricing-refresh", daemon=True).start()

CHAT_CALL_TYPES = {"completion", "acompletion"}


def has_price(model: str) -> bool:
    """True if LiteLLM can price the model, as the wildcard route serves it."""
    info = litellm.model_cost.get(f"openrouter/{model}") or {}
    return any((info.get(field) or 0) > 0 for field in ("input_cost_per_token", "output_cost_per_token"))


class PricedModelsOnly(CustomLogger):
    """
    Rejects chat calls to models LiteLLM has no positive price for. Budget reservation
    (fail_closed_budget_enforcement) needs a price to compute a call's worst case: without one
    it sends the call unchecked. That covers OpenRouter's routers (openrouter/auto is priced -1,
    auto-beta, fusion, pareto-code and nvidia/switchyard are unpriced: they may pick any
    model), free models, and models LiteLLM's own list lacks while OpenRouter's cannot be loaded.
    """

    def __init__(self):
        super().__init__()
        self._miss_lock = asyncio.Lock()

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        model = data.get("model")
        if call_type in CHAT_CALL_TYPES and isinstance(model, str) and not has_price(model):
            # Coalesce concurrent misses; fetching the public catalog must not block chat traffic.
            async with self._miss_lock:
                if not has_price(model):
                    await asyncio.to_thread(refresh, on_miss=True)
            if not has_price(model):
                raise HTTPException(
                    status_code=400,
                    detail={"error": f"Model {model} is not available: its price is unknown."},
                )
        return data


handler = PricedModelsOnly()

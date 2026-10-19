"""Offline callback tests: no LiteLLM installation, background thread or network needed."""
import asyncio
import importlib.util
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        self.detail = detail


def catalog_model(model_id, prompt="0.000001", completion="0.000002"):
    return {"id": model_id, "pricing": {"prompt": prompt, "completion": completion}}


class PricingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.litellm = types.ModuleType("litellm")
        self.litellm.model_cost = {}
        self.litellm.register_model = Mock(side_effect=self.litellm.model_cost.update)
        logger = types.ModuleType("litellm.integrations.custom_logger")
        logger.CustomLogger = object
        fastapi = types.ModuleType("fastapi")
        fastapi.HTTPException = HTTPException
        modules = {
            "litellm": self.litellm,
            "litellm.integrations": types.ModuleType("litellm.integrations"),
            "litellm.integrations.custom_logger": logger,
            "fastapi": fastapi,
        }
        path = Path(__file__).parents[1] / "terraform/templates/litellm_sa_pricing.py"
        spec = importlib.util.spec_from_file_location("sa_pricing_test", path)
        self.pricing = importlib.util.module_from_spec(spec)
        with (
            patch.dict(sys.modules, modules),
            patch("urllib.request.urlopen") as urlopen,
            patch("threading.Thread") as thread,
        ):
            urlopen.return_value.__enter__.return_value.read.return_value = b'{"data": []}'
            spec.loader.exec_module(self.pricing)
            urlopen.assert_called_once()
            thread.return_value.start.assert_called_once()
        self.clock = Mock(return_value=1000)
        patch.object(self.pricing, "time", types.SimpleNamespace(monotonic=self.clock)).start()
        self.fetch = patch.object(self.pricing, "fetch_models", return_value=[]).start()
        self.addCleanup(patch.stopall)
        self.litellm.register_model.reset_mock()

    async def call(self, model="inception/mercury-3", call_type="acompletion"):
        data = {"model": model}
        result = await self.pricing.handler.async_pre_call_hook(None, None, data, call_type)
        self.assertIs(result, data)
        return result

    async def assert_rejected(self, model="inception/mercury-3"):
        with self.assertRaises(HTTPException) as caught:
            await self.call(model)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("its price is unknown", caught.exception.detail["error"])

    async def test_new_model_is_refreshed_and_allowed_in_same_request(self):
        self.fetch.return_value = [catalog_model("inception/mercury-3")]
        await self.call()
        self.fetch.assert_called_once()
        self.assertTrue(self.pricing.has_price("inception/mercury-3"))
        await self.call()
        self.fetch.assert_called_once()

    async def test_known_models_and_other_call_types_skip_refresh(self):
        self.litellm.model_cost["openrouter/known"] = {"input_cost_per_token": 0.000001}
        await self.call("known")
        await self.call("unpriced", "transcription")
        await self.call(None)
        self.fetch.assert_not_called()

    async def test_unknown_free_and_router_models_remain_rejected(self):
        self.fetch.return_value = [
            catalog_model("free", "0", "0"),
            catalog_model("router", "-1", "-1"),
        ]
        for model in ("missing", "free", "router", "another-missing"):
            await self.assert_rejected(model)
        self.fetch.assert_called_once()
        self.assertEqual(self.pricing._last_miss_refresh, 1000)

    async def test_miss_refresh_retries_after_cooldown(self):
        await self.assert_rejected()
        self.fetch.return_value = [catalog_model("inception/mercury-3")]
        self.clock.return_value = 1059
        await self.assert_rejected()
        self.fetch.assert_called_once()
        self.clock.return_value = 1060
        await self.call()
        self.assertEqual(self.fetch.call_count, 2)

    async def test_fetch_failure_is_throttled_preserves_prices_and_recovers(self):
        self.litellm.model_cost["openrouter/known"] = {"output_cost_per_token": 0.000002}
        self.fetch.side_effect = OSError("catalog unavailable")
        await self.assert_rejected()
        await self.assert_rejected("other")
        await self.call("known")
        self.fetch.assert_called_once()
        self.fetch.side_effect = None
        self.fetch.return_value = [catalog_model("inception/mercury-3")]
        self.clock.return_value += 60
        await self.call()
        self.assertTrue(self.pricing.has_price("known"))

    async def test_registration_failure_rejects_and_can_retry(self):
        self.fetch.return_value = [catalog_model("inception/mercury-3")]
        self.litellm.register_model.side_effect = RuntimeError("registration failed")
        await self.assert_rejected()
        await self.assert_rejected()
        self.fetch.assert_called_once()
        self.litellm.register_model.side_effect = self.litellm.model_cost.update
        self.clock.return_value += 60
        await self.call()

    async def test_concurrent_misses_share_fetch_without_blocking_known_calls(self):
        started, release = threading.Event(), threading.Event()

        def slow_fetch():
            started.set()
            if not release.wait(3):
                raise TimeoutError("test did not release fetch")
            return [catalog_model("inception/mercury-3"), catalog_model("second-new-model")]

        self.fetch.side_effect = slow_fetch
        tasks = [asyncio.create_task(self.call()) for _ in range(5)]
        tasks.append(asyncio.create_task(self.call("second-new-model")))
        try:
            async with asyncio.timeout(2):
                while not started.is_set():
                    await asyncio.sleep(0.001)
                self.litellm.model_cost["openrouter/known"] = {"input_cost_per_token": 0.1}
                # The event loop and known-price fast path stay responsive during the fetch.
                await asyncio.wait_for(self.call("known"), timeout=0.1)
                self.assertTrue(any(not task.done() for task in tasks))
        finally:
            release.set()
            await asyncio.gather(*tasks)
        self.fetch.assert_called_once()

    async def test_periodic_refresh_still_updates_prices_during_miss_cooldown(self):
        await self.assert_rejected()
        self.fetch.return_value = [catalog_model("inception/mercury-3")]
        await asyncio.to_thread(self.pricing.refresh)
        await self.call()
        self.assertEqual(self.fetch.call_count, 2)


if __name__ == "__main__":
    unittest.main()

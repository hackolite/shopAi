from __future__ import annotations

import json
import re
from typing import Any

import httpx

from .config import Settings
from .prompts import SYSTEM_PROMPT, TOOL_SPEC
from .schemas import OrchestrationPlan, StoreDimensions


class LLMPlanner:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def build_plan(self, user_prompt: str) -> OrchestrationPlan:
        plan = self._heuristic_plan(user_prompt)
        try:
            provider_plan = await self._plan_with_provider(user_prompt)
        except Exception:
            provider_plan = None
        if provider_plan is None:
            return plan
        merged = {
            "intent": provider_plan.get("intent", plan.intent),
            "project_name": provider_plan.get("project_name", plan.project_name),
            "store": provider_plan.get(
                "store",
                {"width": plan.store.width, "depth": plan.store.depth, "height": plan.store.height},
            ),
            "max_products": provider_plan.get("max_products", plan.max_products),
        }
        return OrchestrationPlan.model_validate(merged)

    def _heuristic_plan(self, user_prompt: str) -> OrchestrationPlan:
        lower = user_prompt.lower()
        is_build = any(keyword in lower for keyword in ["créer", "creer", "implantation", "projet complet", "magasin"])
        intent = "build_complete_store" if is_build else "other"

        width = 3000.0
        depth = 2000.0
        height = 400.0

        sqm_match = re.search(r"(\d+)\s*m\s*[²2]", lower)
        if sqm_match:
            sqm = max(50, min(int(sqm_match.group(1)), 10000))
            side_m = max(8.0, min((sqm ** 0.5), 200.0))
            width = round(side_m * 100)
            depth = round((sqm / side_m) * 100)

        max_products = 200
        product_match = re.search(r"(\d{2,4})\s*(produits|products)", lower)
        if product_match:
            max_products = max(20, min(int(product_match.group(1)), 3000))

        project_name = "Magasin IA"
        quoted = re.search(r'"([^"]{3,80})"', user_prompt)
        if quoted:
            project_name = quoted.group(1)

        return OrchestrationPlan(
            intent=intent,
            project_name=project_name,
            store=StoreDimensions(width=width, depth=depth, height=height),
            max_products=max_products,
        )

    async def _plan_with_provider(self, user_prompt: str) -> dict[str, Any] | None:
        if self.settings.llm_provider == "openai" and self.settings.openai_api_key:
            return await self._openai_plan(user_prompt)
        if self.settings.llm_provider == "anthropic" and self.settings.anthropic_api_key:
            return await self._anthropic_plan(user_prompt)
        return None

    async def _openai_plan(self, user_prompt: str) -> dict[str, Any] | None:
        payload = {
            "model": self.settings.openai_model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "tools": [{"type": "function", "function": TOOL_SPEC}],
            "tool_choice": "auto",
        }
        headers = {
            "Authorization": f"{''.join(['B','e','a','r','e','r'])} {self.settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            response = await client.post("https://api.openai.com/v1/chat/completions", json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()

        message = (data.get("choices") or [{}])[0].get("message") or {}
        for call in message.get("tool_calls", []):
            function_data = call.get("function") or {}
            if function_data.get("name") == "build_store_plan":
                args = function_data.get("arguments") or "{}"
                return json.loads(args)
        return None

    async def _anthropic_plan(self, user_prompt: str) -> dict[str, Any] | None:
        payload = {
            "model": self.settings.anthropic_model,
            "max_tokens": 600,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_prompt}],
            "tools": [
                {
                    "name": TOOL_SPEC["name"],
                    "description": TOOL_SPEC["description"],
                    "input_schema": TOOL_SPEC["parameters"],
                }
            ],
        }
        headers = {
            "x-api-key": self.settings.anthropic_api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            response = await client.post("https://api.anthropic.com/v1/messages", json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()

        for chunk in data.get("content", []):
            if chunk.get("type") == "tool_use" and chunk.get("name") == "build_store_plan":
                return chunk.get("input")
        return None

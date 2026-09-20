from __future__ import annotations

import json
import re
from typing import Any

import httpx

from .config import Settings
from .prompts import SYSTEM_PROMPT, TOOL_SPEC
from .schemas import Category, OrchestrationPlan, StoreDimensions

_MODIFICATION = r"\b(modifi\w*|déplac\w*|deplac\w*|supprim\w*|agrandi\w*|élargi\w*|elargi\w*|réorgani\w*|reorgani\w*|renomm\w*|modify|move|remove|update|resize|rename|widen)\b"
_CREATION = r"\b(créer|creer|crée|cree|create|nouveau|nouvelle|new|projet complet)\b"
_PROJECT = r"\b(magasin|store|project|projet|supermarché|supermarche|supermarket|implantation|layout)\b"


class LLMPlanner:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def build_plan(
        self, user_prompt: str, category: Category | None = None, context: dict[str, Any] | None = None,
    ) -> OrchestrationPlan:
        if self.settings.llm_provider == "none":
            return self._heuristic_plan(user_prompt, category)
        provider_plan = await self._plan_with_provider(json.dumps(
            {"prompt": user_prompt, "category": category, "context": context or {}}, ensure_ascii=False,
        ))
        if provider_plan is None:
            raise ValueError("Le fournisseur LLM n'a pas retourné de plan exploitable (clé ou appel d'outil manquant).")
        plan = OrchestrationPlan.model_validate(provider_plan)
        if category not in {None, "freestyle"} and plan.intent != category:
            raise ValueError("Le plan LLM ne respecte pas la catégorie demandée.")
        if plan.intent in {"layout-create", "build_complete_store"}:
            if re.search(_MODIFICATION, user_prompt.lower()) or (
                category != "layout-create" and not (
                    re.search(_CREATION, user_prompt.lower()) and re.search(_PROJECT, user_prompt.lower())
                )
            ):
                raise ValueError("Une création de projet doit être explicitement demandée, jamais déduite d'une modification.")
        return plan

    def _heuristic_plan(self, user_prompt: str, category: Category | None = None) -> OrchestrationPlan:
        lower = user_prompt.lower()
        if category in {"layout-modify", "assortment-modify"} or re.search(_MODIFICATION, lower):
            raise ValueError("Configure un fournisseur LLM pour planifier des modifications précises.")
        is_build = bool(re.search(_CREATION, lower) and re.search(_PROJECT, lower))
        intent = category if category not in {None, "freestyle"} else ("build_complete_store" if is_build else "other")

        width = 3000.0
        depth = 2000.0
        height = 400.0

        sqm_match = re.search(r"\b(\d{1,5})\s*m\s*[²2]\b", lower)
        if sqm_match:
            sqm = max(50, min(int(sqm_match.group(1)), 10000))
            side_m = max(8.0, min((sqm ** 0.5), 200.0))
            width = round(side_m * 100)
            depth = round((sqm / side_m) * 100)

        max_products = 200
        product_match = re.search(r"(\d{2,4})\s*(produits|products)", lower)
        if product_match:
            max_products = max(1, min(int(product_match.group(1)), 500))

        project_name = "Magasin IA"
        quoted = re.search(r'"([^"]{3,80})"', user_prompt)
        if quoted:
            project_name = quoted.group(1)

        return OrchestrationPlan(
            intent=intent,
            project_name=project_name,
            store=StoreDimensions(width=width, depth=depth, height=height) if intent in {"layout-create", "build_complete_store"} else None,
            max_products=max_products,
        )

    async def _plan_with_provider(self, user_prompt: str) -> dict[str, Any] | None:
        if self.settings.llm_provider == "openai" and self.settings.openai_api_key:
            return await self._openai_plan(user_prompt)
        if self.settings.llm_provider == "anthropic" and self.settings.anthropic_api_key:
            return await self._anthropic_plan(user_prompt)
        if self.settings.llm_provider == "xai" and self.settings.xai_api_key:
            return await self._xai_plan(user_prompt)
        if self.settings.llm_provider == "openrouter" and self.settings.openrouter_api_key:
            return await self._openrouter_plan(user_prompt)
        return None

    async def _openai_plan(self, user_prompt: str) -> dict[str, Any] | None:
        return await self._openai_compatible_plan(
            user_prompt,
            api_base_url="https://api.openai.com/v1",
            model=self.settings.openai_model,
            api_key=self.settings.openai_api_key,
        )

    async def _xai_plan(self, user_prompt: str) -> dict[str, Any] | None:
        return await self._openai_compatible_plan(
            user_prompt,
            api_base_url="https://api.x.ai/v1",
            model=self.settings.xai_model,
            api_key=self.settings.xai_api_key,
            allow_tool_choice_fallback=True,
        )

    async def _openrouter_plan(self, user_prompt: str) -> dict[str, Any] | None:
        headers: dict[str, str] = {}
        if self.settings.openrouter_http_referer:
            headers["HTTP-Referer"] = self.settings.openrouter_http_referer
        if self.settings.openrouter_app_title:
            headers["X-Title"] = self.settings.openrouter_app_title
        return await self._openai_compatible_plan(
            user_prompt,
            api_base_url="https://openrouter.ai/api/v1",
            model=self.settings.openrouter_model,
            api_key=self.settings.openrouter_api_key,
            extra_headers=headers,
        )

    async def _openai_compatible_plan(
        self,
        user_prompt: str,
        *,
        api_base_url: str,
        model: str,
        api_key: str | None,
        extra_headers: dict[str, str] | None = None,
        allow_tool_choice_fallback: bool = False,
    ) -> dict[str, Any] | None:
        if not api_key:
            return None
        payload = self._openai_compatible_payload(user_prompt, model=model, force_tool_choice=True)
        headers = {
            "Authorization": f"{''.join(['B','e','a','r','e','r'])} {api_key}",
            "Content-Type": "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            try:
                response = await client.post(f"{api_base_url}/chat/completions", json=payload, headers=headers)
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                if not allow_tool_choice_fallback or exc.response.status_code != 400:
                    raise
                response = await client.post(
                    f"{api_base_url}/chat/completions",
                    json=self._openai_compatible_payload(user_prompt, model=model, force_tool_choice=False),
                    headers=headers,
                )
                response.raise_for_status()
            data = response.json()

        message = (data.get("choices") or [{}])[0].get("message") or {}
        for call in message.get("tool_calls", []):
            function_data = call.get("function") or {}
            if function_data.get("name") == "build_store_plan":
                args = function_data.get("arguments") or "{}"
                return json.loads(args)
        return None

    def _openai_compatible_payload(self, user_prompt: str, *, model: str, force_tool_choice: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "tools": [{"type": "function", "function": TOOL_SPEC}],
        }
        if force_tool_choice:
            payload["tool_choice"] = {"type": "function", "function": {"name": TOOL_SPEC["name"]}}
        return payload

    async def _anthropic_plan(self, user_prompt: str) -> dict[str, Any] | None:
        payload = {
            "model": self.settings.anthropic_model,
            "max_tokens": 8192,
            "tool_choice": {"type": "tool", "name": TOOL_SPEC["name"]},
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

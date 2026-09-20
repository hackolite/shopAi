from __future__ import annotations

import pytest

from app.config import Settings
from app.llm import LLMPlanner


def _settings() -> Settings:
    return Settings(
        backend_base_url="http://localhost:8000",
        llm_provider="xai",
        openai_api_key=None,
        anthropic_api_key=None,
        xai_api_key="token",
        openrouter_api_key=None,
        openai_model="gpt-4o-mini",
        anthropic_model="claude-3-5-sonnet-latest",
        xai_model="grok-4",
        openrouter_model="openai/gpt-4o-mini",
        openrouter_http_referer=None,
        openrouter_app_title=None,
        request_timeout_seconds=30.0,
        max_retries=3,
        collision_max_retries=6,
        collision_offset_cm=20.0,
        catalog_json_path=None,
    )


@pytest.mark.asyncio
async def test_provider_inferred_creation_is_downgraded_to_other(monkeypatch: pytest.MonkeyPatch):
    planner = LLMPlanner(_settings())

    async def fake_provider_plan(_: str):
        return {"intent": "layout-create", "project_name": " Demo "}

    monkeypatch.setattr(planner, "_plan_with_provider", fake_provider_plan)
    plan = await planner.build_plan("Modifie la largeur de l'allée centrale", None, {})
    assert plan.intent == "other"
    assert plan.project_name == "Demo"
    assert plan.store is None
    assert plan.furniture == []
    assert plan.products == []
    assert plan.planograms == []


@pytest.mark.asyncio
async def test_provider_intent_is_trimmed_before_validation(monkeypatch: pytest.MonkeyPatch):
    planner = LLMPlanner(_settings())

    async def fake_provider_plan(_: str):
        return {"intent": " layout-modify "}

    monkeypatch.setattr(planner, "_plan_with_provider", fake_provider_plan)
    plan = await planner.build_plan("Déplace un meuble de 30 cm", "layout-modify", {})
    assert plan.intent == "layout-modify"

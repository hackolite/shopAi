from __future__ import annotations

import asyncio
import copy
import sys
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from orchestrator.app import agent as agent_module
from orchestrator.app.agent import ShopAIOrchestrator
from orchestrator.app.config import load_settings
from orchestrator.app.llm import LLMPlanner
from orchestrator.app.main import app as orchestrator_app, get_settings
from orchestrator.app.schemas import OrchestrationPlan, WebhookRequest
from orchestrator.app.tools import BackendApiError, BackendTools
from orchestrator.app.workflow import compile_operations


def run(awaitable):
    return asyncio.run(awaitable)


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "none")
    monkeypatch.setenv("WEBHOOK_AUTH_TOKEN", "test-orchestrator-shared-key")
    agent_module._pending.clear()
    return load_settings()


@pytest.fixture
def state():
    product = {
        "ean": "1234567890123", "name": "Test product", "brand": "Test", "category": "Test",
        "widthCm": 10, "depthCm": 8, "heightCm": 20, "weightG": 500,
    }
    furniture = {
        "id": "shelf", "name": "Shelf", "type": "gondola_double", "libraryId": "gondola_double",
        "position": [200, 0, 200], "rotation": [0, 0, 0],
        "dimensions": {"width": 120, "depth": 80, "height": 200},
    }
    return {
        "scene": {
            "store": {"dimensions": {"width": 1000, "depth": 1000, "height": 400}, "position": [0, 0, 0]},
            "furniture": [furniture],
        },
        "catalog": {"products": [product]},
        "planograms": [],
    }


@pytest.fixture
def library(state):
    furniture = state["scene"]["furniture"][0]
    return {"gondola_double": {
        "id": "gondola_double", "name": "Gondole double", "type": "gondola_double",
        "defaultDimensions": furniture["dimensions"], "hasFaces": ["front", "back"],
    }}


@pytest.fixture
def fake_backend(monkeypatch, state, library):
    calls = []

    async def request(self, method, path, payload=None, retries=None):
        calls.append((method, path, copy.deepcopy(payload)))
        if method == "GET":
            if path.endswith("/scene"):
                return copy.deepcopy(state["scene"])
            if path.endswith("/catalog"):
                return copy.deepcopy(state["catalog"])
            if path.endswith("/planograms"):
                return {"planograms": copy.deepcopy(state["planograms"])}
            if path == "/api/furniture-library/":
                return {"furniture": copy.deepcopy(list(library.values()))}
            return {}
        if path == "/api/cad/projects/":
            return {"id": "created-project"}
        return payload or {}

    monkeypatch.setattr(BackendTools, "_request", request)
    return calls


def _modify_plan():
    return OrchestrationPlan.model_validate({
        "intent": "layout-modify",
        "furniture": [{"action": "update", "id": "shelf", "position": [400, 0, 200]}],
    })


def test_preview_and_confirmation_reuse_exact_plan(settings, fake_backend, monkeypatch):
    count = 0

    async def plan(self, *args):
        nonlocal count
        count += 1
        return _modify_plan()

    monkeypatch.setattr(LLMPlanner, "build_plan", plan)
    payload = WebhookRequest(projectId="current", prompt="Move shelf", category="layout-modify")
    preview = run(ShopAIOrchestrator(settings).run(payload, "session"))
    assert preview.requiresConfirmation and not preview.changed and preview.confirmationToken
    assert all(method == "GET" for method, _, _ in fake_backend)
    fake_backend.clear()
    confirm = payload.model_copy(update={"confirm": True, "confirmationToken": preview.confirmationToken})
    result = run(ShopAIOrchestrator(settings).run(confirm, "session"))
    assert count == 1
    assert result.changed and result.projectId == "current"
    writes = [item for item in fake_backend if item[0] != "GET"]
    assert writes == [("PUT", "/api/cad/projects/current/scene/furniture/shelf", {"position": [400.0, 0.0, 200.0]})]
    with pytest.raises(HTTPException, match="409"):
        run(ShopAIOrchestrator(settings).run(confirm, "session"))


@pytest.mark.parametrize("field,value", [
    ("prompt", "different"), ("projectId", "other"), ("category", "freestyle"),
    ("confirmationToken", "tampered"),
])
def test_confirmation_is_bound_to_request(settings, fake_backend, monkeypatch, field, value):
    async def plan(self, *args):
        return _modify_plan()
    monkeypatch.setattr(LLMPlanner, "build_plan", plan)
    payload = WebhookRequest(projectId="current", prompt="Move", category="layout-modify")
    preview = run(ShopAIOrchestrator(settings).run(payload, "session"))
    confirm = payload.model_copy(update={"confirm": True, "confirmationToken": preview.confirmationToken, field: value})
    with pytest.raises(HTTPException) as error:
        run(ShopAIOrchestrator(settings).run(confirm, "session"))
    assert error.value.status_code == 409
    assert all(method == "GET" for method, _, _ in fake_backend)


def test_session_binding_expiry_and_stale_project(settings, fake_backend, monkeypatch, state):
    async def plan(self, *args):
        return _modify_plan()
    monkeypatch.setattr(LLMPlanner, "build_plan", plan)
    payload = WebhookRequest(projectId="current", prompt="Move", category="layout-modify")
    preview = run(ShopAIOrchestrator(settings).run(payload, "session"))
    confirm = payload.model_copy(update={"confirm": True, "confirmationToken": preview.confirmationToken})
    with pytest.raises(HTTPException):
        run(ShopAIOrchestrator(settings).run(confirm, "different-session"))
    token = preview.confirmationToken
    pending = agent_module._pending[token]
    agent_module._pending[token] = replace(pending, expires=0)
    with pytest.raises(HTTPException):
        run(ShopAIOrchestrator(settings).run(confirm, "session"))
    agent_module._pending[token] = pending
    state["scene"]["store"]["dimensions"]["width"] = 1200
    with pytest.raises(HTTPException) as error:
        run(ShopAIOrchestrator(settings).run(confirm, "session"))
    assert error.value.status_code == 409
    assert all(method == "GET" for method, _, _ in fake_backend)


def test_confirm_without_preview_does_not_plan(settings, fake_backend):
    with pytest.raises(HTTPException) as error:
        run(ShopAIOrchestrator(settings).run(WebhookRequest(projectId="current", prompt="Create", confirm=True), "session"))
    assert error.value.status_code == 409
    assert fake_backend == []


@pytest.mark.parametrize("session,secret,status", [(None, "configured", 401), ("session", None, 503)])
def test_missing_credentials_fail_before_any_callback(settings, fake_backend, session, secret, status):
    with pytest.raises(HTTPException) as error:
        run(ShopAIOrchestrator(replace(settings, webhook_auth_token=secret)).run(
            WebhookRequest(projectId="current", prompt="Create"), session,
        ))
    assert error.value.status_code == status
    assert not fake_backend


@pytest.mark.parametrize("status", [400, 401, 409, 422, 500, 503])
def test_callbacks_authenticated_and_writes_never_retry(settings, monkeypatch, status):
    calls = []
    real_client = httpx.AsyncClient

    def handler(request):
        calls.append(request)
        assert request.headers["Authorization"] == "Bearer " + settings.webhook_auth_token
        assert request.headers["X-ShopAI-Session"] == "session"
        return httpx.Response(status, json={"detail": "failure"})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    with pytest.raises(BackendApiError):
        run(BackendTools(settings, "session").place_furniture("current", {"id": "test"}))
    assert len(calls) == 1


def test_read_retries_only_transient_errors(settings, monkeypatch):
    calls = []
    real_client = httpx.AsyncClient
    status = 503

    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={"detail": "failure"})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    with pytest.raises(BackendApiError):
        run(BackendTools(settings, "session").health_check())
    assert len(calls) == settings.max_retries
    calls.clear()
    status = 401
    with pytest.raises(BackendApiError):
        run(BackendTools(settings, "session").health_check())
    assert len(calls) == 1


def test_write_timeout_is_not_retried(settings, monkeypatch):
    calls = []
    real_client = httpx.AsyncClient

    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("lost response")
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    with pytest.raises(BackendApiError):
        run(BackendTools(settings, "session").create_project("Test"))
    assert len(calls) == 1


def test_provider_failure_never_falls_back(settings, monkeypatch):
    async def failure(self, prompt):
        raise httpx.ConnectError("provider offline")
    monkeypatch.setattr(LLMPlanner, "_plan_with_provider", failure)
    with pytest.raises(httpx.ConnectError):
        run(LLMPlanner(replace(settings, llm_provider="openai")).build_plan("Créer magasin"))


def test_provider_missing_key_and_wrong_intent_are_rejected(settings, monkeypatch):
    with pytest.raises(ValueError, match="fournisseur"):
        run(LLMPlanner(replace(settings, llm_provider="openai", openai_api_key=None)).build_plan("Créer"))

    async def wrong(self, prompt):
        return {"intent": "build_complete_store"}
    monkeypatch.setattr(LLMPlanner, "_plan_with_provider", wrong)
    planner = LLMPlanner(replace(settings, llm_provider="openai"))
    with pytest.raises(ValueError):
        run(planner.build_plan("Modifier implantation", "layout-modify"))
    with pytest.raises(ValueError):
        run(planner.build_plan("Move shelf"))
    with pytest.raises(ValueError):
        run(planner.build_plan("Créer une gondole"))


@pytest.mark.parametrize("provider,host", [
    ("openai", "api.openai.com"), ("xai", "api.x.ai"),
    ("openrouter", "openrouter.ai"), ("anthropic", "api.anthropic.com"),
])
def test_provider_tool_call_compatibility(settings, monkeypatch, provider, host):
    import json

    real_client = httpx.AsyncClient
    seen = []

    def handler(request):
        seen.append(request)
        assert request.url.host == host
        sent = json.loads(request.content)
        assert sent["tools"]
        assert "layout-modify" in sent["messages"][-1]["content"]
        if provider == "anthropic":
            return httpx.Response(200, json={"content": [{
                "type": "tool_use", "name": "build_store_plan", "input": _modify_plan().model_dump(),
            }]})
        return httpx.Response(200, json={"choices": [{"message": {"tool_calls": [{
            "function": {"name": "build_store_plan", "arguments": _modify_plan().model_dump_json()},
        }]}}]})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    planner = LLMPlanner(replace(settings, llm_provider=provider, **{f"{provider}_api_key": "test-provider-key"}))
    assert run(planner.build_plan("Move shelf", "layout-modify")).intent == "layout-modify"
    assert len(seen) == 1


def test_offline_modifications_are_explicitly_unsupported(settings):
    with pytest.raises(ValueError):
        run(LLMPlanner(settings).build_plan("Modifier le magasin"))
    with pytest.raises(ValueError):
        run(LLMPlanner(settings).build_plan("Réorganise le magasin"))
    assert run(LLMPlanner(settings).build_plan("Le magasin est mal agencé")).intent == "other"


@pytest.mark.parametrize("patch", [
    {"intent": "arbitrary"}, {"max_products": 501}, {"max_products": True},
    {"store": {"width": float("nan")}}, {"store": {"depth": -2}},
    {"store": {"width": 1200}},
    {"furniture": [{"action": "update", "id": "../outside"}]},
    {"planograms": [{"name": "Invalid", "furnitureId": "shelf", "face": "front", "rows": 0}]},
])
def test_plan_schema_is_bounded(patch):
    with pytest.raises(ValidationError):
        OrchestrationPlan.model_validate({"intent": "layout-create", **patch})


def test_layout_modifications_do_not_create_projects(settings, state, library):
    create, operations = compile_operations(BackendTools(settings, "session"), _modify_plan(), state, library)
    assert not create
    assert len(operations) == 1 and operations[0].method == "PUT"
    assert state["scene"]["furniture"][0]["position"] == [200, 0, 200]


def test_layout_creation_explicitly_clears_seeded_catalog(settings, state, library):
    create, operations = compile_operations(
        BackendTools(settings, "session"),
        OrchestrationPlan(intent="layout-create"),
        state,
        library,
    )
    assert create
    assert operations[0].path == "/catalog/import"
    assert operations[0].payload == {"products": [], "merge": False}
    assert "Vider" in operations[0].description
    assert state["catalog"]["products"]


@pytest.mark.parametrize("position,rotation", [([980, 0, 200], [0, 0, 0]), ([0, 0, 200], [0, 45, 0])])
def test_layout_bounds_account_for_rotation(settings, state, library, position, rotation):
    plan = OrchestrationPlan.model_validate({"intent": "layout-modify", "furniture": [
        {"action": "update", "id": "shelf", "position": position, "rotation": rotation},
    ]})
    with pytest.raises(ValueError, match="limites"):
        compile_operations(BackendTools(settings, "session"), plan, state, library)


def test_duplicate_furniture_and_collisions_rejected(settings, state, library):
    for identifier in ("shelf", "new"):
        plan = OrchestrationPlan.model_validate({"intent": "layout-modify", "furniture": [
            {"action": "add", "id": identifier, "libraryId": "gondola_double", "position": [200, 0, 200]},
        ]})
        with pytest.raises(ValueError):
            compile_operations(BackendTools(settings, "session"), plan, state, library)


def test_assortment_modification_preserves_other_catalog_data(settings, state, library):
    original = state["catalog"]["products"][0]
    original["description"] = "must survive"
    product = {key: value for key, value in original.items() if key != "description"}
    product["name"] = "Updated"
    plan = OrchestrationPlan.model_validate({"intent": "assortment-modify", "products": [product]})
    create, operations = compile_operations(BackendTools(settings, "session"), plan, state, library)
    assert not create and len(operations) == 1
    assert operations[0].payload["merge"] is True
    assert operations[0].payload["products"][0]["description"] == "must survive"


def test_full_assortment_updates_existing_face_not_duplicate(settings, state, library):
    state["planograms"] = [{
        "id": "existing-plano", "name": "Old", "furnitureId": "shelf", "face": "front",
        "rows": 1, "cols": 1, "widthCm": 120, "heightCm": 200, "cells": [],
    }]
    create, operations = compile_operations(
        BackendTools(settings, "session"), OrchestrationPlan(intent="assortment-full"), state, library,
    )
    assert not create
    updates = [item for item in operations if item.method == "PUT"]
    assert len(updates) == 1 and updates[0].path == "/planograms/existing-plano"
    assert updates[0].payload["gondola"] is None
    assert len([item for item in operations if item.path == "/planograms"]) == 1


def test_full_assortment_never_silently_truncates_existing_catalog(settings, state, library):
    product = state["catalog"]["products"][0]
    state["catalog"]["products"] = [
        {**product, "ean": f"product-{index}"} for index in range(4807)
    ]
    with pytest.raises(ValueError, match="4807"):
        compile_operations(
            BackendTools(settings, "session"),
            OrchestrationPlan(intent="assortment-full"),
            state,
            library,
        )
    plan = OrchestrationPlan.model_validate({
        "intent": "assortment-full",
        "products": [state["catalog"]["products"][0]],
    })
    _, operations = compile_operations(BackendTools(settings, "session"), plan, state, library)
    assert operations[0].payload["merge"] is True
    assert len(operations[0].payload["products"]) == 1


def test_assortment_empty_scene_and_unknown_ean_rejected(settings, state, library):
    plan = OrchestrationPlan.model_validate({"intent": "assortment-modify", "planograms": [
        {"name": "P", "furnitureId": "shelf", "face": "front", "cells": [{"ean": "missing", "row": 0, "col": 0}]},
    ]})
    with pytest.raises(ValueError, match="EAN"):
        compile_operations(BackendTools(settings, "session"), plan, state, library)
    state["scene"]["furniture"] = []
    with pytest.raises(ValueError, match="face"):
        compile_operations(BackendTools(settings, "session"), OrchestrationPlan(intent="assortment-full"), state, library)


def test_missing_local_catalog_does_not_invent_products(settings):
    with pytest.raises(ValueError, match="catalogue"):
        BackendTools(replace(settings, catalog_json_path="missing-catalog.json"), "session").load_products(20)


def test_partial_creation_reports_new_project_and_changes(settings, fake_backend, monkeypatch):
    payload = WebhookRequest(projectId="current", prompt="Créer", category="layout-create")
    preview = run(ShopAIOrchestrator(settings).run(payload, "session"))
    original_request = BackendTools._request

    async def fail(self, method, path, payload=None, retries=None):
        if method == "PUT":
            raise BackendApiError(422, "invalid dimensions", method, path)
        return await original_request(self, method, path, payload, retries)
    monkeypatch.setattr(BackendTools, "_request", fail)
    result = run(ShopAIOrchestrator(settings).run(payload.model_copy(update={
        "confirm": True, "confirmationToken": preview.confirmationToken,
    }), "session"))
    assert result.changed and result.projectId == "created-project"
    assert "Échec" in result.message


@pytest.mark.parametrize("status,changed", [(409, False), (502, True)])
def test_failed_first_modification_reports_uncertainty(settings, fake_backend, monkeypatch, status, changed):
    async def plan(self, *args):
        return _modify_plan()
    monkeypatch.setattr(LLMPlanner, "build_plan", plan)
    payload = WebhookRequest(projectId="current", prompt="Move", category="layout-modify")
    preview = run(ShopAIOrchestrator(settings).run(payload, "session"))
    original_request = BackendTools._request

    async def fail(self, method, path, payload=None, retries=None):
        if method == "PUT":
            raise BackendApiError(status, "failed", method, path)
        return await original_request(self, method, path, payload, retries)
    monkeypatch.setattr(BackendTools, "_request", fail)
    result = run(ShopAIOrchestrator(settings).run(payload.model_copy(update={
        "confirm": True, "confirmationToken": preview.confirmationToken,
    }), "session"))
    assert result.changed is changed and result.projectId == "current"


def test_webhook_fails_closed_when_secret_not_configured(settings):
    orchestrator_app.dependency_overrides[get_settings] = lambda: replace(settings, webhook_auth_token=None)
    try:
        with TestClient(orchestrator_app) as client:
            assert client.post("/webhook/llm", json={"projectId": "p", "prompt": "Create"}).status_code == 503
    finally:
        orchestrator_app.dependency_overrides.clear()


def test_real_backend_creation_modification_and_assortment(settings, monkeypatch, tmp_path):
    from main import app
    from services import project_manager as pm
    from services.studio_assistant import audit_persisted_project

    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path / "projects")
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_TOKEN", settings.webhook_auth_token)
    real_client = httpx.AsyncClient
    with TestClient(app) as backend:
        response = backend.post("/api/platform/auth/register", json={
            "name": "Orchestrator", "email": f"{uuid4().hex}@example.com", "password": "orchestrator-test-password",
        })
        assert response.status_code == 200, response.text
        session = backend.cookies.get("shopai_session")
        project_id = backend.post("/api/cad/projects/", json={"name": "Original"}).json()["id"]

        def handler(request):
            assert request.headers["X-ShopAI-Session"] == session
            assert request.headers["Authorization"] == "Bearer " + settings.webhook_auth_token
            response = backend.request(request.method, request.url.path, content=request.content, headers=dict(request.headers))
            return httpx.Response(response.status_code, content=response.content, headers=response.headers)

        monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
        payload = WebhookRequest(projectId=project_id, prompt='Créer magasin "Integration" 100 m² 20 produits')
        preview = run(ShopAIOrchestrator(settings).run(payload, session))
        assert len(backend.get("/api/cad/projects/").json()) == 1
        result = run(ShopAIOrchestrator(settings).run(payload.model_copy(update={
            "confirm": True, "confirmationToken": preview.confirmationToken,
        }), session))
        assert result.changed and result.projectId != project_id and "Échec" not in result.message, result
        project_id = result.projectId
        assert audit_persisted_project(project_id)["ok"]
        scene = backend.get(f"/api/cad/projects/{project_id}/scene").json()
        assert scene["furniture"]
        planos = backend.get(f"/api/cad/projects/{project_id}/planograms").json()["planograms"]
        assert planos
        existing_ids = {item["id"] for item in planos}
        payload = WebhookRequest(projectId=project_id, prompt="Assortiment complet", category="assortment-full")
        preview = run(ShopAIOrchestrator(settings).run(payload, session))
        result = run(ShopAIOrchestrator(settings).run(payload.model_copy(update={
            "confirm": True, "confirmationToken": preview.confirmationToken,
        }), session))
        assert result.changed and result.projectId == project_id and "Échec" not in result.message, result
        assert {item["id"] for item in backend.get(f"/api/cad/projects/{project_id}/planograms").json()["planograms"]} == existing_ids
        layout_request = WebhookRequest(
            projectId=project_id, prompt="Créer implantation seule", category="layout-create",
        )
        layout_preview = run(ShopAIOrchestrator(settings).run(layout_request, session))
        layout_result = run(ShopAIOrchestrator(settings).run(layout_request.model_copy(update={
            "confirm": True, "confirmationToken": layout_preview.confirmationToken,
        }), session))
        assert layout_result.changed and "Échec" not in layout_result.message, layout_result
        assert layout_result.projectId != project_id
        assert backend.get(f"/api/cad/projects/{layout_result.projectId}/catalog").json()["products"] == []
        assert audit_persisted_project(layout_result.projectId)["ok"]
        furniture = scene["furniture"][0]

        async def rename(self, *args):
            return OrchestrationPlan.model_validate({"intent": "layout-modify", "furniture": [
                {"action": "update", "id": furniture["id"], "name": "Renamed register"},
            ]})
        monkeypatch.setattr(LLMPlanner, "build_plan", rename)
        payload = WebhookRequest(projectId=project_id, prompt="Renommer caisse", category="layout-modify")
        preview = run(ShopAIOrchestrator(settings).run(payload, session))
        result = run(ShopAIOrchestrator(settings).run(payload.model_copy(update={
            "confirm": True, "confirmationToken": preview.confirmationToken,
        }), session))
        assert result.changed and result.projectId == project_id and "Échec" not in result.message, result
        assert backend.get(f"/api/cad/projects/{project_id}/scene").json()["furniture"][0]["name"] == "Renamed register"

        payload = payload.model_copy(update={"category": "freestyle", "prompt": "Renommer librement"})
        preview = run(ShopAIOrchestrator(settings).run(payload, session))
        result = run(ShopAIOrchestrator(settings).run(payload.model_copy(update={
            "confirm": True, "confirmationToken": preview.confirmationToken,
        }), session))
        assert result.changed and result.projectId == project_id and "Échec" not in result.message, result

        product = backend.get(f"/api/cad/projects/{project_id}/catalog").json()["products"][0]
        product = {key: product[key] for key in (
            "ean", "name", "brand", "category", "widthCm", "depthCm", "heightCm", "weightG",
        )}
        product["name"] = "Updated product"

        async def update_product(self, *args):
            return OrchestrationPlan.model_validate({
                "intent": "assortment-modify", "products": [product],
            })
        monkeypatch.setattr(LLMPlanner, "build_plan", update_product)
        payload = WebhookRequest(projectId=project_id, prompt="Renommer produit", category="assortment-modify")
        preview = run(ShopAIOrchestrator(settings).run(payload, session))
        result = run(ShopAIOrchestrator(settings).run(payload.model_copy(update={
            "confirm": True, "confirmationToken": preview.confirmationToken,
        }), session))
        assert result.changed and result.projectId == project_id and "Échec" not in result.message, result
        catalog = backend.get(f"/api/cad/projects/{project_id}/catalog").json()["products"]
        assert len(catalog) == 20
        assert next(item for item in catalog if item["ean"] == product["ean"])["name"] == "Updated product"
        assert audit_persisted_project(project_id)["ok"]

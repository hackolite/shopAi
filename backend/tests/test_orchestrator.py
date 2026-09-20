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
from orchestrator.app.workflow import Operation, compile_operations, fingerprint, validate_layout


def run(awaitable):
    return asyncio.run(awaitable)


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "none")
    monkeypatch.delenv("WEBHOOK_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("STUDIO_LLM_WEBHOOK_TOKEN", raising=False)
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


@pytest.mark.parametrize("session", [None, "", "   "])
def test_missing_session_fails_before_any_callback(settings, fake_backend, session):
    with pytest.raises(HTTPException) as error:
        run(ShopAIOrchestrator(settings).run(
            WebhookRequest(projectId="current", prompt="Create"), session,
        ))
    assert error.value.status_code == 401
    assert not fake_backend


@pytest.mark.parametrize("status", [400, 401, 409, 422, 500, 503])
def test_callbacks_authenticated_and_writes_never_retry(settings, monkeypatch, status):
    calls = []
    real_client = httpx.AsyncClient

    def handler(request):
        calls.append(request)
        assert "Authorization" not in request.headers
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


def test_sequential_furniture_operations_keep_original_request_payloads(settings, state, library):
    plan = OrchestrationPlan.model_validate({
        "intent": "layout-modify",
        "furniture": [
            {
                "action": "add", "id": "new-shelf", "libraryId": "gondola_double",
                "position": [600, 0, 200],
            },
            {"action": "update", "id": "shelf", "position": [400, 0, 200]},
            {"action": "update", "id": "new-shelf", "position": [200, 0, 200]},
        ],
    })
    _, operations = compile_operations(BackendTools(settings, "session"), plan, state, library)
    assert operations[0].payload["position"] == [600, 0, 200]
    assert operations[1].payload["position"] == [400, 0, 200]
    assert operations[2].payload["position"] == [200, 0, 200]
    scene = copy.deepcopy(state["scene"])
    for operation in operations:
        if operation.method == "POST":
            scene["furniture"].append(copy.deepcopy(operation.payload))
        else:
            identifier = operation.path.rsplit("/", 1)[-1]
            item = next(item for item in scene["furniture"] if item["id"] == identifier)
            item.update(copy.deepcopy(operation.payload))
        validate_layout(scene)


def test_operation_copies_nested_payload_data():
    payload = {"position": [100, 0, 200], "dimensions": {"width": 120}}
    operation = Operation("POST", "/scene/furniture", payload, "Add furniture")
    payload["position"][0] = 900
    payload["dimensions"]["width"] = 1000
    assert operation.payload == {"position": [100, 0, 200], "dimensions": {"width": 120}}


def test_gondola_fingerprint_ignores_only_derived_cell_ids(state):
    state["planograms"] = [{
        "id": "planogram",
        "gondola": {"id": "gondola", "placements": [{"ean": "1234567890123"}]},
        "cells": [{"id": "generated-first", "ean": "1234567890123", "row": 0, "col": 0}],
    }]
    original_hash = fingerprint(state)
    regenerated = copy.deepcopy(state)
    regenerated["planograms"][0]["cells"][0]["id"] = "generated-again"
    assert fingerprint(regenerated) == original_hash
    assert state["planograms"][0]["cells"][0]["id"] == "generated-first"
    regenerated["planograms"][0]["cells"][0]["ean"] = "different-product"
    assert fingerprint(regenerated) != original_hash
    regenerated = copy.deepcopy(state)
    regenerated["planograms"][0]["gondola"]["placements"][0]["ean"] = "different-product"
    assert fingerprint(regenerated) != original_hash
    regenerated = copy.deepcopy(state)
    regenerated["planograms"][0]["gondola"]["placements"][0]["cellId"] = "persisted-cell-id"
    assert fingerprint(regenerated) != original_hash


def test_legacy_planogram_fingerprint_preserves_persisted_cell_ids(state):
    state["planograms"] = [{
        "id": "planogram",
        "gondola": None,
        "cells": [{"id": "persisted-first", "ean": "1234567890123", "row": 0, "col": 0}],
    }]
    original_hash = fingerprint(state)
    state["planograms"][0]["cells"][0]["id"] = "persisted-second"
    assert fingerprint(state) != original_hash


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


@pytest.mark.parametrize("session", [None, "", "   "])
def test_webhook_requires_session_before_planning(settings, monkeypatch, session):
    monkeypatch.setattr(LLMPlanner, "build_plan", lambda *a: pytest.fail("Must authenticate before LLM"))
    orchestrator_app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(orchestrator_app) as client:
            headers = {} if session is None else {"X-ShopAI-Session": session}
            assert client.post("/webhook/llm", headers=headers, json={"projectId": "p", "prompt": "Create"}).status_code == 401
    finally:
        orchestrator_app.dependency_overrides.clear()


@pytest.fixture
def authenticated_backend(monkeypatch, tmp_path):
    from main import app
    from services import project_manager as pm

    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path / "projects")
    real_client = httpx.AsyncClient
    calls = []
    with TestClient(app) as backend:
        response = backend.post("/api/platform/auth/register", json={
            "name": "Owner", "email": f"{uuid4().hex}@example.com", "password": "orchestrator-test-password",
        })
        assert response.status_code == 200
        session = backend.cookies.get("shopai_session")
        project_id = backend.post("/api/cad/projects/", json={"name": "Private"}).json()["id"]

        def handler(request):
            calls.append((request.method, request.url.path))
            assert request.url.host == "localhost"
            assert "Authorization" not in request.headers
            response = backend.request(request.method, request.url.path, content=request.content, headers=dict(request.headers))
            return httpx.Response(response.status_code, content=response.content)

        monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
        yield backend, session, project_id, calls


@pytest.mark.parametrize("kind,status", [("invalid", 401), ("expired", 401), ("cross-tenant", 403)])
def test_webhook_validates_database_session_and_tenant_before_llm(
    settings, authenticated_backend, monkeypatch, kind, status,
):
    from main import app
    from services import platform_service

    backend, session, project_id, calls = authenticated_backend
    if kind == "invalid":
        session = "unknown-session"
    elif kind == "expired":
        with platform_service._connect() as conn:
            conn.execute("UPDATE sessions SET expires_at = ? WHERE token = ?", ("2000-01-01T00:00:00+00:00", session))
            conn.commit()
    else:
        with TestClient(app) as outsider:
            assert outsider.post("/api/platform/auth/register", json={
                "name": "Outsider", "email": f"{uuid4().hex}@example.com", "password": "orchestrator-test-password",
            }).status_code == 200
            session = outsider.cookies.get("shopai_session")
    monkeypatch.setattr(LLMPlanner, "build_plan", lambda *a: pytest.fail("Unauthorized provider call"))
    orchestrator_app.dependency_overrides[get_settings] = lambda: replace(settings, llm_provider="openai")
    try:
        with TestClient(orchestrator_app) as client:
            response = client.post("/webhook/llm", headers={"X-ShopAI-Session": session}, json={
                "projectId": project_id, "prompt": "Create a store",
            })
        assert response.status_code == status, response.text
        assert calls == [("GET", f"/api/cad/projects/{project_id}/scene")]
    finally:
        orchestrator_app.dependency_overrides.clear()


def test_webhook_without_shared_secret_logs_safe_stages(settings, authenticated_backend, monkeypatch, caplog):
    _, session, project_id, calls = authenticated_backend
    private_prompt = "private-prompt-do-not-log"
    private_key = "private-provider-key-do-not-log"

    async def plan(self, *args):
        assert calls[0] == ("GET", f"/api/cad/projects/{project_id}/scene")
        return OrchestrationPlan(intent="layout-create", store={"width": 1000, "depth": 1000, "height": 400})

    monkeypatch.setattr(LLMPlanner, "build_plan", plan)
    orchestrator_app.dependency_overrides[get_settings] = lambda: replace(
        settings, llm_provider="openai", openai_api_key=private_key,
    )
    caplog.set_level("INFO", logger="uvicorn.error")
    try:
        with TestClient(orchestrator_app) as client:
            response = client.post("/webhook/llm", headers={"X-ShopAI-Session": session}, json={
                "projectId": project_id, "prompt": private_prompt,
            })
        assert response.status_code == 200, response.text
        assert response.json()["requiresConfirmation"]
        assert all(method == "GET" for method, _ in calls)
        for stage in ("webhook started", "Project access validated", "Planning started provider=openai",
                      "Planning completed", "Preview ready", "webhook completed status=200", "duration_ms="):
            assert stage in caplog.text
        for secret in (private_prompt, private_key, session, response.json()["confirmationToken"]):
            assert secret not in caplog.text
    finally:
        orchestrator_app.dependency_overrides.clear()


@pytest.mark.parametrize("kind,status", [("revoked", 401), ("expired", 401), ("cross-tenant", 403)])
def test_confirmation_revalidates_access_before_writes(settings, authenticated_backend, monkeypatch, kind, status):
    from services import platform_service

    backend, session, project_id, calls = authenticated_backend
    payload = WebhookRequest(projectId=project_id, prompt="Créer implantation", category="layout-create")
    preview = run(ShopAIOrchestrator(settings).run(payload, session))
    calls.clear()
    monkeypatch.setattr(LLMPlanner, "build_plan", lambda *a: pytest.fail("Confirmation must never call LLM"))
    if kind == "revoked":
        platform_service.logout_session(session)
    elif kind == "expired":
        with platform_service._connect() as conn:
            conn.execute("UPDATE sessions SET expires_at = ? WHERE token = ?", ("2000-01-01T00:00:00+00:00", session))
            conn.commit()
    else:
        original = platform_service.require_current_user_project_access

        def reject(project):
            if project == project_id:
                raise HTTPException(403, "Access revoked")
            return original(project)

        monkeypatch.setattr(platform_service, "require_current_user_project_access", reject)
    confirm = payload.model_copy(update={"confirm": True, "confirmationToken": preview.confirmationToken})
    with pytest.raises(HTTPException) as error:
        run(ShopAIOrchestrator(settings).run(confirm, session))
    assert error.value.status_code == status
    assert calls == [("GET", f"/api/cad/projects/{project_id}/scene")]
    assert preview.confirmationToken not in agent_module._pending


@pytest.mark.parametrize("failure", ["transport", "status", "plan"])
def test_provider_failures_do_not_leak_payloads(settings, fake_backend, monkeypatch, caplog, failure):
    private = "private-provider-payload-do-not-log"

    async def fail(self, *args):
        if failure == "transport":
            raise httpx.ConnectError(private)
        if failure == "status":
            response = httpx.Response(429, text=private, request=httpx.Request("POST", "https://provider.invalid"))
            raise httpx.HTTPStatusError(private, request=response.request, response=response)
        raise ValueError(private)

    monkeypatch.setattr(LLMPlanner, "build_plan", fail)
    caplog.set_level("INFO", logger="uvicorn.error")
    with pytest.raises(HTTPException) as error:
        run(ShopAIOrchestrator(settings).run(WebhookRequest(projectId="current", prompt=private), "session"))
    assert error.value.status_code == (422 if failure == "plan" else 502)
    assert private not in caplog.text
    assert private not in error.value.detail
    assert "error_class=" in caplog.text
    assert all(method == "GET" for method, _, _ in fake_backend)


@pytest.mark.parametrize("failure", ["transport", "status"])
def test_callback_failures_are_safe(settings, monkeypatch, caplog, failure):
    real_client = httpx.AsyncClient
    private = "private-backend-body-do-not-log"

    def handler(request):
        if failure == "transport":
            raise httpx.ConnectError(private)
        return httpx.Response(503, json={"detail": private})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    caplog.set_level("INFO", logger="uvicorn.error")
    with pytest.raises(BackendApiError) as error:
        run(BackendTools(settings, "private-session-do-not-log").health_check())
    assert private not in str(error.value)
    assert private not in caplog.text
    assert "private-session-do-not-log" not in caplog.text
    assert ("error_class=ConnectError" if failure == "transport" else "status=503") in caplog.text


def test_confirmation_invalid_state_is_safe(settings, fake_backend, monkeypatch, caplog):
    payload = WebhookRequest(projectId="current", prompt="Créer implantation", category="layout-create")
    preview = run(ShopAIOrchestrator(settings).run(payload, "session"))
    fake_backend.clear()

    async def invalid_state(*a):
        raise ValueError("private-invalid-state-do-not-log")

    monkeypatch.setattr(agent_module, "read_state", invalid_state)
    caplog.set_level("INFO", logger="uvicorn.error")
    with pytest.raises(HTTPException) as error:
        run(ShopAIOrchestrator(settings).run(payload.model_copy(update={
            "confirm": True, "confirmationToken": preview.confirmationToken,
        }), "session"))
    assert error.value.status_code == 422
    assert "private-invalid-state-do-not-log" not in caplog.text
    assert "private-invalid-state-do-not-log" not in error.value.detail
    assert not fake_backend


def test_webhook_rejects_client_backend_url(settings, monkeypatch):
    monkeypatch.setattr(LLMPlanner, "build_plan", lambda *a: pytest.fail("Untrusted URL must not reach LLM"))
    orchestrator_app.dependency_overrides[get_settings] = lambda: settings
    try:
        with TestClient(orchestrator_app) as client:
            response = client.post("/webhook/llm", headers={"X-ShopAI-Session": "session"}, json={
                "projectId": "current", "prompt": "Create", "backend_base_url": "https://untrusted.invalid",
            })
        assert response.status_code == 422
    finally:
        orchestrator_app.dependency_overrides.clear()


def test_real_backend_creation_modification_and_assortment(settings, monkeypatch, tmp_path):
    from main import app
    from services import project_manager as pm
    from services.studio_assistant import audit_persisted_project

    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path / "projects")
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
            assert "Authorization" not in request.headers
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

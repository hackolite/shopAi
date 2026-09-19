from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from services import llm_assistant
from services import project_manager as pm


@pytest.fixture
def workspace(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path / "projects")
    return tmp_path


def _register(client: TestClient, name: str = "Studio") -> None:
    result = client.post("/api/platform/auth/register", json={
        "name": name, "email": f"{uuid4().hex}@example.com", "password": "studio-test-password",
    })
    assert result.status_code == 200, result.text


@pytest.fixture
def studio(workspace):
    from main import app

    with TestClient(app) as client:
        _register(client)
        result = client.post("/api/cad/projects/", json={"name": "Mon projet existant"})
        assert result.status_code == 200, result.text
        yield client, result.json()["id"]


def test_status_reports_disabled_without_env(studio, monkeypatch: pytest.MonkeyPatch):
    client, project_id = studio
    monkeypatch.delenv("STUDIO_LLM_WEBHOOK_URL", raising=False)
    response = client.get(f"/api/cad/projects/{project_id}/assistant/llm/status")
    assert response.status_code == 200
    assert response.json() == {"enabled": False}


def test_llm_endpoint_rejects_when_not_configured(studio, monkeypatch: pytest.MonkeyPatch):
    client, project_id = studio
    monkeypatch.delenv("STUDIO_LLM_WEBHOOK_URL", raising=False)
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": "Créer implantation: X"})
    assert response.status_code == 503
    assert "STUDIO_LLM_WEBHOOK_URL" in response.text


def test_llm_endpoint_relays_a_valid_preview_reply(studio, monkeypatch: pytest.MonkeyPatch):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")

    captured: dict = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return httpx.Response(200, json={
            "message": "Aperçu de la modification.",
            "requiresConfirmation": True,
            "changed": False,
        })

    monkeypatch.setattr(llm_assistant.httpx, "post", fake_post)
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={
        "prompt": "Modifier implantation: élargis l'allée centrale",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["requiresConfirmation"] is True
    assert body["changed"] is False
    assert captured["json"] == {
        "projectId": project_id, "prompt": "Modifier implantation: élargis l'allée centrale", "confirm": False,
    }
    assert "X-ShopAI-Session" in captured["headers"]


def test_llm_endpoint_rejects_malformed_agent_reply(studio, monkeypatch: pytest.MonkeyPatch):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")

    def fake_post(url, json=None, headers=None, timeout=None):
        return httpx.Response(200, json={"unexpectedField": True})

    monkeypatch.setattr(llm_assistant.httpx, "post", fake_post)
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": "Créer implantation: X"})
    assert response.status_code == 502
    assert "invalide" in response.text


def test_llm_endpoint_surfaces_transport_failures(studio, monkeypatch: pytest.MonkeyPatch):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")

    def fake_post(url, json=None, headers=None, timeout=None):
        raise httpx.ConnectTimeout("boom")

    monkeypatch.setattr(llm_assistant.httpx, "post", fake_post)
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": "Créer implantation: X"})
    assert response.status_code == 502
    assert "injoignable" in response.text


def test_llm_endpoint_audits_a_reported_write_and_surfaces_issues(studio, monkeypatch: pytest.MonkeyPatch):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")

    scene = pm.load_project_file(project_id, "scene.json")
    scene["store"]["dimensions"]["width"] = -1
    pm.save_project_file(project_id, "scene.json", scene)

    def fake_post(url, json=None, headers=None, timeout=None):
        return httpx.Response(200, json={
            "message": "Implantation modifiée.",
            "requiresConfirmation": False,
            "changed": True,
            "projectId": project_id,
        })

    monkeypatch.setattr(llm_assistant.httpx, "post", fake_post)
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={
        "prompt": "Modifier implantation: X", "confirm": True,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["changed"] is True
    assert any("Audit post-écriture" in step for step in body["steps"])


def test_llm_endpoint_requires_authentication_and_tenant_access(studio):
    from main import app

    client, project_id = studio
    with TestClient(app) as outsider:
        response = outsider.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": "X"})
        assert response.status_code == 401
        _register(outsider, "Other tenant")
        response = outsider.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": "X"})
        assert response.status_code == 403


def test_llm_endpoint_allows_external_agent_callbacks_via_forwarded_session_header(
    studio,
    monkeypatch: pytest.MonkeyPatch,
):
    from main import app

    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")

    def fake_post(url, json=None, headers=None, timeout=None):
        with TestClient(app) as callback_client:
            response = callback_client.post(
                "/api/cad/projects/import",
                json={
                    "name": "Projet généré par agent",
                    "snapshot": {
                        "scene": {"store": {}, "furniture": []},
                        "catalog": {"products": []},
                        "planograms": [],
                    },
                },
                headers={"X-ShopAI-Session": headers["X-ShopAI-Session"]},
            )
        assert response.status_code == 200, response.text
        return httpx.Response(200, json={
            "message": "Projet créé.",
            "requiresConfirmation": False,
            "changed": True,
            "projectId": response.json()["id"],
        })

    monkeypatch.setattr(llm_assistant.httpx, "post", fake_post)
    response = client.post(
        f"/api/cad/projects/{project_id}/assistant/llm",
        json={"prompt": "Créer implantation: X", "confirm": True},
    )
    assert response.status_code == 200, response.text
    created_project_id = response.json()["projectId"]

    created_project = client.get(f"/api/cad/projects/{created_project_id}")
    assert created_project.status_code == 200, created_project.text
    assert created_project.json()["name"] == "Projet généré par agent"


@pytest.mark.parametrize("payload", [
    {"prompt": ""}, {"prompt": "   "}, {"prompt": "a" * 2001},
    {"prompt": 123}, {"prompt": "X", "confirm": "yes"},
    {"prompt": "X", "extra": "nope"},
])
def test_llm_endpoint_prompt_is_bounded_and_strictly_validated(studio, payload):
    client, project_id = studio
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json=payload)
    assert response.status_code == 422

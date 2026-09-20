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
    monkeypatch.delenv("STUDIO_LLM_WEBHOOK_TOKEN", raising=False)
    monkeypatch.delenv("WEBHOOK_AUTH_TOKEN", raising=False)
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
    assert response.json() == {
        "enabled": False,
        "reachable": False,
        "status": "missing",
        "message": "Provider LLM introuvable : variable serveur STUDIO_LLM_WEBHOOK_URL absente.",
    }


def test_status_preflight_reports_ready_when_webhook_responds(studio, monkeypatch: pytest.MonkeyPatch):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")

    def fake_get(url, timeout=None):
        assert url == "http://agent.invalid/webhook"
        return httpx.Response(405)

    monkeypatch.setattr(llm_assistant.httpx, "get", fake_get)
    response = client.get(f"/api/cad/projects/{project_id}/assistant/llm/status")
    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "reachable": True,
        "status": "ready",
        "message": "Provider LLM détecté et joignable.",
    }


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
    assert "Authorization" not in captured["headers"]


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
    assert "ne peut pas être considéré comme réussi" in body["message"]
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
                headers={
                    "X-ShopAI-Session": headers["X-ShopAI-Session"],
                },
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


def test_forwarded_session_authenticates_without_shared_secret(studio):
    from main import app

    client, project_id = studio
    session_token = client.cookies.get("shopai_session")
    assert session_token

    with TestClient(app) as callback_client:
        for extra_headers in ({}, {"Authorization": "******"}):
            response = callback_client.get(
                f"/api/cad/projects/{project_id}/scene",
                headers={"X-ShopAI-Session": session_token, **extra_headers},
            )
            assert response.status_code == 200


@pytest.mark.parametrize("payload", [
    {"prompt": ""}, {"prompt": "   "}, {"prompt": "a" * 2001},
    {"prompt": 123}, {"prompt": "X", "confirm": "yes"},
    {"prompt": "X", "extra": "nope"},
    {"prompt": "X", "webhookUrl": "https://untrusted.invalid"},
    {"prompt": "X", "category": "unsupported"},
    {"prompt": "X", "confirmationToken": ""},
    {"prompt": "X", "confirmationToken": 123},
    {"prompt": "X", "confirmationToken": "a" * 513},
])
def test_llm_endpoint_prompt_is_bounded_and_strictly_validated(studio, payload):
    client, project_id = studio
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json=payload)
    assert response.status_code == 422


def test_forwarded_creation_and_edits_belong_to_the_browser_tenant(studio, monkeypatch):
    from main import app

    client, _ = studio
    headers = {
        "X-ShopAI-Session": client.cookies.get("shopai_session"),
    }
    with TestClient(app) as agent:
        created = agent.post("/api/cad/projects/", json={"name": "Agent"}, headers=headers)
        assert created.status_code == 200, created.text
        project_id = created.json()["id"]
        updated = agent.put(
            f"/api/cad/projects/{project_id}/scene/store",
            json={"name": "Updated by agent"}, headers=headers,
        )
        assert updated.status_code == 200, updated.text
        assert agent.get(
            f"/api/cad/projects/{project_id}/export/retail-layout", headers=headers,
        ).status_code == 200
        _register(agent, "Other tenant")
        assert agent.get(f"/api/cad/projects/{project_id}").status_code == 403
        assert agent.get(f"/api/cad/projects/{project_id}/simulation/pedestrians").status_code == 403
    assert client.get(f"/api/cad/projects/{project_id}").status_code == 200
    assert project_id in {p["id"] for p in client.get("/api/cad/projects/").json()["projects"]}


@pytest.mark.parametrize("session", ["invalid-session", "", "   ", "expired"])
def test_invalid_forwarded_session_cannot_create_an_unowned_project(studio, session):
    from services import platform_service

    client, project_id = studio
    if session == "expired":
        session = client.cookies.get("shopai_session")
        with platform_service._connect() as conn:
            conn.execute("UPDATE sessions SET expires_at = ? WHERE token = ?", ("2000-01-01T00:00:00+00:00", session))
            conn.commit()
    headers = {"X-ShopAI-Session": session}
    before = {p["id"] for p in pm.list_cad_projects()}
    assert client.post("/api/cad/projects/", json={"name": "Rejected"}, headers=headers).status_code == 401
    assert client.get(f"/api/cad/projects/{project_id}/scene", headers=headers).status_code == 401
    assert {p["id"] for p in pm.list_cad_projects()} == before


def test_category_and_confirmation_token_are_relayed(studio, monkeypatch):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")

    def fake_post(url, json=None, **kwargs):
        assert json["category"] == "layout-modify"
        assert json["confirmationToken"] == "preview-token"
        return httpx.Response(200, json={
            "message": "Aperçu", "requiresConfirmation": True, "changed": False,
            "confirmationToken": "returned-token",
        })

    monkeypatch.setattr(llm_assistant.httpx, "post", fake_post)
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={
        "prompt": "Modifier", "category": "layout-modify", "confirmationToken": "preview-token",
    })
    assert response.status_code == 200, response.text
    assert response.json()["confirmationToken"] == "returned-token"


@pytest.mark.parametrize("reply", [
    {"changed": True},
    {"changed": "true", "projectId": "unused"},
])
def test_invalid_write_report_is_rejected(studio, monkeypatch, reply):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")
    monkeypatch.setattr(llm_assistant.httpx, "post", lambda *a, **kw: httpx.Response(200, json={
        "message": "Success", "requiresConfirmation": False, **reply,
    }))
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": "X", "confirm": True})
    assert response.status_code == 502


def test_agent_cannot_return_another_tenants_project(studio, monkeypatch):
    from main import app

    client, project_id = studio
    with TestClient(app) as outsider:
        _register(outsider, "Other tenant")
        other_id = outsider.post("/api/cad/projects/", json={"name": "Private"}).json()["id"]
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")
    monkeypatch.setattr(llm_assistant.httpx, "post", lambda *a, **kw: httpx.Response(200, json={
        "message": "Success", "requiresConfirmation": False, "changed": True, "projectId": other_id,
    }))
    monkeypatch.setattr(
        llm_assistant, "audit_persisted_project",
        lambda *a: pytest.fail("Must not audit another tenant's project"),
    )
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": "X", "confirm": True})
    assert response.status_code == 403


def test_unconfirmed_write_report_is_rejected(studio, monkeypatch):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")
    monkeypatch.setattr(llm_assistant.httpx, "post", lambda *a, **kw: httpx.Response(200, json={
        "message": "Success", "requiresConfirmation": False, "changed": True, "projectId": project_id,
    }))
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": "X"})
    assert response.status_code == 502


def test_expired_preview_requests_a_new_confirmation(studio, monkeypatch):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")
    monkeypatch.setattr(llm_assistant.httpx, "post", lambda *a, **kw: httpx.Response(
        409, json={"detail": "Expired confirmation"},
    ))
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={
        "prompt": "X", "confirm": True, "confirmationToken": "expired",
    })
    assert response.status_code == 409
    assert "nouvel aperçu" in response.json()["detail"]


@pytest.mark.parametrize("status", [401, 403, 404, 422, 429, 502, 503, 504, 500])
def test_proxy_returns_safe_actionable_errors(studio, monkeypatch, caplog, status):
    client, project_id = studio
    private = "private-upstream-detail-do-not-log"
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")
    monkeypatch.setattr(llm_assistant.httpx, "post", lambda *a, **kw: httpx.Response(
        status, json={"detail": private}, headers={"content-type": private},
    ))
    caplog.set_level("INFO", logger="uvicorn.error")
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": private})
    assert response.status_code == (502 if status == 500 else status)
    assert private not in response.text
    assert private not in caplog.text
    assert f"status={status}" in caplog.text
    assert "duration_ms=" in caplog.text


@pytest.mark.parametrize("failure", ["transport", "validation", "audit"])
def test_proxy_errors_and_logs_never_include_sensitive_values(studio, monkeypatch, caplog, failure):
    client, project_id = studio
    private = "private-request-and-error-do-not-log"
    confirmation = "private-confirmation-do-not-log"
    session = client.cookies.get("shopai_session")
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")

    def fake_post(*a, **kw):
        if failure == "transport":
            raise httpx.ConnectTimeout(private)
        if failure == "validation":
            return httpx.Response(200, json={"message": private, "changed": private})
        return httpx.Response(200, json={
            "message": "Success", "changed": True, "requiresConfirmation": False, "projectId": project_id,
        })

    def fail_audit(*a):
        raise ValueError(private)

    monkeypatch.setattr(llm_assistant.httpx, "post", fake_post)
    monkeypatch.setattr(llm_assistant, "audit_persisted_project", fail_audit)
    caplog.set_level("INFO", logger="uvicorn.error")
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={
        "prompt": private, "confirm": True, "confirmationToken": confirmation,
    })
    assert response.status_code == (200 if failure == "audit" else 502)
    for secret in (private, confirmation, session):
        assert secret not in caplog.text
        assert secret not in response.text
    assert "error_class=" in caplog.text
    if failure == "audit":
        assert "Post-write audit started" in caplog.text
        assert "ne peut pas être considéré comme réussi" in response.json()["message"]


def test_proxy_success_logs_completion_without_payload(studio, monkeypatch, caplog):
    client, project_id = studio
    monkeypatch.setenv("STUDIO_LLM_WEBHOOK_URL", "http://agent.invalid/webhook")
    monkeypatch.setattr(llm_assistant.httpx, "post", lambda *a, **kw: httpx.Response(200, json={
        "message": "private-response-do-not-log", "requiresConfirmation": True, "changed": False,
        "confirmationToken": "private-confirmation-do-not-log",
    }))
    caplog.set_level("INFO", logger="uvicorn.error")
    response = client.post(f"/api/cad/projects/{project_id}/assistant/llm", json={"prompt": "private-prompt-do-not-log"})
    assert response.status_code == 200
    assert "External LLM request completed" in caplog.text
    assert "duration_ms=" in caplog.text
    for private in ("private-response-do-not-log", "private-confirmation-do-not-log", "private-prompt-do-not-log",
                    client.cookies.get("shopai_session")):
        assert private not in caplog.text

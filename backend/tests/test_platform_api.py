from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

import services.project_manager as pm

pm.STORAGE_ROOT = Path(tempfile.mkdtemp(prefix="shopai_platform_test_"))

from main import app  # noqa: E402


def _make_client() -> TestClient:
    return TestClient(app, raise_server_exceptions=True)


def _register(client: TestClient, *, name: str, email: str) -> dict:
    response = client.post(
        "/api/platform/auth/register",
        json={"name": name, "email": email, "password": "supersafepass"},
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def test_dashboard_and_project_visibility_are_tenant_scoped() -> None:
    alpha = _make_client()
    beta = _make_client()

    alpha_user = _register(alpha, name="Alice Retail", email="alice@example.com")
    assert alpha_user["email"] == "alice@example.com"

    project_response = alpha.post("/api/cad/projects/", json={"name": "Alice Store"})
    assert project_response.status_code == 200, project_response.text
    alpha_project_id = project_response.json()["id"]

    catalog_response = alpha.post(
        "/api/platform/catalogs",
        json={
            "name": "Catalog Alice",
            "description": "Assortiment premium",
            "sourceProjectId": alpha_project_id,
            "productCount": 42,
        },
    )
    assert catalog_response.status_code == 200, catalog_response.text

    simulation_response = alpha.post(
        "/api/platform/simulations",
        json={
            "name": "Simulation Alice",
            "description": "Rush midi",
            "sourceProjectId": alpha_project_id,
            "scenarioCount": 3,
        },
    )
    assert simulation_response.status_code == 200, simulation_response.text

    agent_response = alpha.post(
        "/api/platform/agent-requests",
        json={
            "provider": "github-copilot",
            "targetResourceType": "project",
            "targetResourceId": alpha_project_id,
            "prompt": "Ajoute un onboarding retail.",
        },
    )
    assert agent_response.status_code == 200, agent_response.text

    beta_user = _register(beta, name="Bob Retail", email="bob@example.com")
    assert beta_user["email"] == "bob@example.com"
    beta_project_response = beta.post("/api/cad/projects/", json={"name": "Bob Store"})
    assert beta_project_response.status_code == 200, beta_project_response.text
    beta_project_id = beta_project_response.json()["id"]

    alpha_projects = alpha.get("/api/cad/projects/")
    assert alpha_projects.status_code == 200, alpha_projects.text
    assert [item["id"] for item in alpha_projects.json()["projects"]] == [alpha_project_id]

    beta_projects = beta.get("/api/cad/projects/")
    assert beta_projects.status_code == 200, beta_projects.text
    assert [item["id"] for item in beta_projects.json()["projects"]] == [beta_project_id]

    forbidden = alpha.get(f"/api/cad/projects/{beta_project_id}")
    assert forbidden.status_code == 403, forbidden.text

    dashboard = alpha.get("/api/platform/dashboard")
    assert dashboard.status_code == 200, dashboard.text
    payload = dashboard.json()
    assert payload["stats"] == {
        "projectCount": 1,
        "catalogCount": 1,
        "simulationCount": 1,
        "agentRequestCount": 1,
    }
    assert payload["projects"][0]["id"] == alpha_project_id
    assert payload["catalogs"][0]["sourceProjectId"] == alpha_project_id
    assert payload["simulations"][0]["sourceProjectId"] == alpha_project_id
    assert payload["agentRequests"][0]["targetResourceId"] == alpha_project_id


def test_mcp_endpoint_exposes_tools_and_can_create_resources() -> None:
    client = _make_client()
    _register(client, name="Charlie Ops", email="charlie@example.com")

    initialize = client.post(
        "/api/platform/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2026-06-18", "capabilities": {}},
        },
    )
    assert initialize.status_code == 200, initialize.text
    assert initialize.json()["result"]["serverInfo"]["name"] == "shopai-platform-mcp"

    tools = client.post(
        "/api/platform/mcp",
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    )
    assert tools.status_code == 200, tools.text
    tool_names = [tool["name"] for tool in tools.json()["result"]["tools"]]
    assert "get_dashboard" in tool_names
    assert "submit_change_request" in tool_names

    create_project = client.post(
        "/api/platform/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "create_project", "arguments": {"name": "MCP Store"}},
        },
    )
    assert create_project.status_code == 200, create_project.text
    project_id = create_project.json()["result"]["structuredContent"]["id"]

    submit_change = client.post(
        "/api/platform/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "submit_change_request",
                "arguments": {
                    "provider": "custom-agent",
                    "targetResourceType": "project",
                    "targetResourceId": project_id,
                    "prompt": "Ajoute un bloc KPI en homepage.",
                },
            },
        },
    )
    assert submit_change.status_code == 200, submit_change.text
    assert "Demande enregistrée" in submit_change.json()["result"]["content"][0]["text"]

    dashboard = client.post(
        "/api/platform/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "get_dashboard", "arguments": {}},
        },
    )
    assert dashboard.status_code == 200, dashboard.text
    structured = dashboard.json()["result"]["structuredContent"]
    assert structured["stats"]["projectCount"] == 1
    assert structured["stats"]["agentRequestCount"] == 1
    assert structured["projects"][0]["id"] == project_id

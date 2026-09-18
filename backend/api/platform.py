from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Request, Response
from pydantic import BaseModel, Field

from services import platform_service

router = APIRouter(prefix="/api/platform", tags=["platform"])


class AuthPayload(BaseModel):
    email: str
    password: str


class RegisterPayload(AuthPayload):
    name: str


class OAuthPayload(BaseModel):
    email: str
    name: str | None = None


class WorkspacePayload(BaseModel):
    name: str
    description: str = ""
    sourceProjectId: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    productCount: int = 0
    scenarioCount: int = 0


class AgentRequestPayload(BaseModel):
    provider: str
    targetResourceType: str
    targetResourceId: str | None = None
    prompt: str


@router.get("/bootstrap")
def bootstrap() -> dict[str, Any]:
    return {
        "hasUsers": platform_service.count_users() > 0,
        "authProviders": ["password", "google", "github"],
        "features": [
            "multi-tenant dashboard",
            "tenant-owned CAD projects",
            "tenant-owned catalogs",
            "tenant-owned checkout simulations",
            "agent request inbox",
            "HTTP MCP bridge",
        ],
    }


@router.get("/session")
def get_session() -> dict[str, Any]:
    user = platform_service.get_current_user()
    return {"user": user}


@router.post("/auth/register")
def register(payload: RegisterPayload, response: Response) -> dict[str, Any]:
    user = platform_service.register_user(payload.name, payload.email, payload.password)
    platform_service.create_session_response(response, user)
    return {"user": user}


@router.post("/auth/login")
def login(payload: AuthPayload, response: Response) -> dict[str, Any]:
    user = platform_service.login_user(payload.email, payload.password)
    platform_service.create_session_response(response, user)
    return {"user": user}


@router.post("/auth/oauth/{provider}")
def oauth_sign_in(provider: str, payload: OAuthPayload, response: Response) -> dict[str, Any]:
    user = platform_service.oauth_sign_in(provider, payload.email, payload.name)
    platform_service.create_session_response(response, user)
    return {"user": user}


@router.post("/auth/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    platform_service.logout_session(request.cookies.get(platform_service.SESSION_COOKIE_NAME))
    platform_service.clear_session_cookie(response)
    return {"ok": True}


@router.get("/dashboard")
def get_dashboard() -> dict[str, Any]:
    return platform_service.get_dashboard()


@router.post("/catalogs")
def create_catalog(payload: WorkspacePayload) -> dict[str, Any]:
    return platform_service.create_catalog_workspace(
        name=payload.name,
        description=payload.description,
        source_project_id=payload.sourceProjectId,
        product_count=payload.productCount,
        payload=payload.payload,
    )


@router.post("/simulations")
def create_simulation(payload: WorkspacePayload) -> dict[str, Any]:
    return platform_service.create_checkout_simulation_list(
        name=payload.name,
        description=payload.description,
        source_project_id=payload.sourceProjectId,
        scenario_count=payload.scenarioCount,
        payload=payload.payload,
    )


@router.post("/agent-requests")
def create_agent_request(payload: AgentRequestPayload) -> dict[str, Any]:
    return platform_service.create_agent_request(
        provider=payload.provider,
        prompt=payload.prompt,
        target_resource_type=payload.targetResourceType,
        target_resource_id=payload.targetResourceId,
    )


@router.get("/mcp")
def get_mcp_description() -> dict[str, Any]:
    return platform_service.get_mcp_server_description()


@router.post("/mcp")
def call_mcp(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return platform_service.handle_mcp_request(payload)

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from services import platform_service
from services.catalog_import import parse_catalog_csv
from services.retail_layout import split_retail_layout

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


class StoreLayoutPayload(BaseModel):
    name: str
    description: str = ""
    sourceProjectId: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class PedestrianDatasetPayload(BaseModel):
    name: str
    description: str = ""
    sourceProjectId: str | None = None
    pedestrianCount: int = 0
    payload: dict[str, Any] = Field(default_factory=dict)


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
        "oauthProviders": platform_service.get_oauth_provider_status(),
        "features": [
            "multi-tenant dashboard",
            "tenant-owned CAD projects",
            "tenant-owned catalogs",
            "tenant-owned checkout simulations",
            "agent request inbox",
            "REST/OpenAPI agent guide",
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


@router.get("/auth/oauth/{provider}/start")
def oauth_start(provider: str, request: Request, next: str = Query("/", alias="next")):
    url = platform_service.get_oauth_authorization_url(
        provider=provider,
        request_base_url=str(request.base_url).rstrip("/"),
        next_path=next,
    )
    return RedirectResponse(url=url, status_code=302)


@router.get("/auth/oauth/{provider}/callback")
def oauth_callback(
    provider: str,
    request: Request,
    code: str = Query(...),
    state: str = Query(...),
):
    user, next_path = platform_service.complete_oauth_sign_in(
        provider=provider,
        code=code,
        state=state,
        request_base_url=str(request.base_url).rstrip("/"),
    )
    redirect = RedirectResponse(
        url=platform_service.build_safe_local_redirect_url(str(request.base_url).rstrip("/"), next_path),
        status_code=302,
    )
    platform_service.create_session_response(redirect, user)
    return redirect


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


@router.get("/catalogs")
def list_catalogs() -> dict[str, Any]:
    return {"catalogs": platform_service.list_catalog_workspaces()}


@router.post("/catalogs/import-csv")
async def create_catalog_from_csv(
    file: UploadFile = File(...),
    name: str = Form(...),
    description: str = Form(""),
) -> dict[str, Any]:
    """Upload a product catalog CSV and persist it as a reusable tenant catalog."""
    raw = await file.read()
    try:
        csv_text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=422, detail="File must be UTF-8 encoded CSV text") from exc
    catalog = parse_catalog_csv(csv_text)
    payload = catalog.model_dump(mode="json")
    return platform_service.create_catalog_workspace(
        name=name,
        description=description,
        product_count=len(payload["products"]),
        payload=payload,
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


@router.post("/simulations/import-json")
async def create_simulation_from_json(
    file: UploadFile = File(...),
    name: str = Form(...),
    description: str = Form(""),
) -> dict[str, Any]:
    """Upload a simulation scenario list (JSON) and persist it as a reusable tenant simulation.

    Accepts either a JSON array of scenarios or an object with a ``scenarios`` key.
    """
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=422, detail="File must be UTF-8 encoded JSON text") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid JSON file: {exc}") from exc

    if isinstance(data, list):
        scenarios = data
    elif isinstance(data, dict):
        scenarios = data.get("scenarios", [])
        if not isinstance(scenarios, list):
            raise HTTPException(status_code=422, detail="'scenarios' must be a list")
    else:
        raise HTTPException(status_code=422, detail="JSON root must be an array or an object with 'scenarios'")

    return platform_service.create_checkout_simulation_list(
        name=name,
        description=description,
        scenario_count=len(scenarios),
        payload={"scenarios": scenarios},
    )


@router.post("/store-layouts")
def create_store_layout(payload: StoreLayoutPayload) -> dict[str, Any]:
    return platform_service.create_store_layout(
        name=payload.name,
        description=payload.description,
        source_project_id=payload.sourceProjectId,
        payload=payload.payload,
    )


@router.post("/store-layouts/import-json")
async def create_store_layout_from_json(
    file: UploadFile = File(...),
    name: str = Form(...),
    description: str = Form(""),
) -> dict[str, Any]:
    """Upload a ShopAI retail-layout JSON export and persist it as a reusable store layout.

    The file must follow ShopAI's unified retail-layout format (the same JSON
    produced by ``GET /api/cad/projects/{id}/export/retail-layout``), which is
    split back into a scene (store + furniture) and its planograms.
    """
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=422, detail="File must be UTF-8 encoded JSON text") from exc
    try:
        layout = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid JSON file: {exc}") from exc
    if not isinstance(layout, dict):
        raise HTTPException(status_code=422, detail="JSON root must be a ShopAI retail-layout object")

    try:
        scene_dict, planograms_list = split_retail_layout(layout=layout, project_name=name.strip() or None)
    except (AttributeError, TypeError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid ShopAI retail-layout document: {exc}") from exc
    payload = {"scene": scene_dict, "planograms": planograms_list}
    return platform_service.create_store_layout(
        name=name,
        description=description,
        payload=payload,
    )


@router.get("/store-layouts")
def list_store_layouts() -> dict[str, Any]:
    return {"storeLayouts": platform_service.list_store_layouts()}


@router.get("/store-layouts/{layout_id}")
def get_store_layout(layout_id: str) -> dict[str, Any]:
    return platform_service.get_store_layout(layout_id)


@router.post("/pedestrian-datasets")
def create_pedestrian_dataset(payload: PedestrianDatasetPayload) -> dict[str, Any]:
    return platform_service.create_pedestrian_dataset(
        name=payload.name,
        description=payload.description,
        source_project_id=payload.sourceProjectId,
        pedestrian_count=payload.pedestrianCount,
        payload=payload.payload,
    )


@router.get("/pedestrian-datasets")
def list_pedestrian_datasets() -> dict[str, Any]:
    return {"pedestrianDatasets": platform_service.list_pedestrian_datasets()}


@router.get("/pedestrian-datasets/{dataset_id}")
def get_pedestrian_dataset(dataset_id: str) -> dict[str, Any]:
    return platform_service.get_pedestrian_dataset(dataset_id)


@router.post("/agent-requests")
def create_agent_request(payload: AgentRequestPayload) -> dict[str, Any]:
    return platform_service.create_agent_request(
        provider=payload.provider,
        prompt=payload.prompt,
        target_resource_type=payload.targetResourceType,
        target_resource_id=payload.targetResourceId,
    )


@router.get("/agent-guide")
def get_agent_guide(request: Request) -> dict[str, Any]:
    return platform_service.get_agent_api_description(str(request.base_url).rstrip("/"))


@router.get("/agent-capabilities")
def get_agent_capabilities(projectId: str | None = Query(None)) -> dict[str, Any]:
    return platform_service.get_agent_capability_report(projectId)

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, Request, Response

import services.project_manager as project_manager
from models.project import Planogram, ProjectSettings, SceneData, SimulationConfig

SESSION_COOKIE_NAME = "shopai_session"
SESSION_DURATION_DAYS = 14
_SUPPORTED_OAUTH_PROVIDERS = {"google", "github"}
_current_user: ContextVar[dict[str, Any] | None] = ContextVar(
    "shopai_current_user",
    default=None,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> Path:
    storage_root = Path(project_manager.STORAGE_ROOT)
    storage_root.parent.mkdir(parents=True, exist_ok=True)
    return storage_root.parent / "platform.sqlite3"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def ensure_platform_schema() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tenants (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (tenant_id) REFERENCES tenants(id)
            );

            CREATE TABLE IF NOT EXISTS user_identities (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                provider_subject TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(provider, provider_subject),
                FOREIGN KEY (user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS project_memberships (
                project_id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                owner_user_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (tenant_id) REFERENCES tenants(id),
                FOREIGN KEY (owner_user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS catalog_workspaces (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                owner_user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                source_project_id TEXT,
                product_count INTEGER NOT NULL DEFAULT 0,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (tenant_id) REFERENCES tenants(id),
                FOREIGN KEY (owner_user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS checkout_simulation_lists (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                owner_user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                source_project_id TEXT,
                scenario_count INTEGER NOT NULL DEFAULT 0,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (tenant_id) REFERENCES tenants(id),
                FOREIGN KEY (owner_user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS agent_requests (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                owner_user_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                target_resource_type TEXT NOT NULL,
                target_resource_id TEXT,
                prompt TEXT NOT NULL,
                implementation_notes TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (tenant_id) REFERENCES tenants(id),
                FOREIGN KEY (owner_user_id) REFERENCES users(id)
            );
            """
        )


def _slugify(value: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "-" for char in value)
    parts = [part for part in cleaned.split("-") if part]
    return "-".join(parts)[:48] or "tenant"


def _ensure_unique_slug(conn: sqlite3.Connection, base_slug: str) -> str:
    slug = base_slug
    suffix = 1
    while conn.execute("SELECT 1 FROM tenants WHERE slug = ?", (slug,)).fetchone() is not None:
        suffix += 1
        slug = f"{base_slug[:40]}-{suffix}"
    return slug


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return f"pbkdf2_sha256${salt.hex()}${digest.hex()}"


def _verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, salt_hex, digest_hex = stored_hash.split("$", 2)
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    computed = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt_hex),
        120_000,
    )
    return hmac.compare_digest(computed.hex(), digest_hex)


def _row_to_user_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "tenantId": row["tenant_id"],
        "name": row["name"],
        "email": row["email"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_DURATION_DAYS * 24 * 60 * 60,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")


def _issue_session(conn: sqlite3.Connection, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    created_at = datetime.now(timezone.utc)
    expires_at = created_at + timedelta(days=SESSION_DURATION_DAYS)
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token, user_id, created_at.isoformat(), expires_at.isoformat()),
    )
    return token


def count_users() -> int:
    ensure_platform_schema()
    with _connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()
    return int(row["count"] if row is not None else 0)


def register_user(name: str, email: str, password: str) -> dict[str, Any]:
    ensure_platform_schema()
    cleaned_name = name.strip()
    cleaned_email = email.strip().lower()
    if not cleaned_name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not cleaned_email or "@" not in cleaned_email:
        raise HTTPException(status_code=400, detail="A valid email is required")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must contain at least 8 characters")

    with _connect() as conn:
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (cleaned_email,)).fetchone() is not None:
            raise HTTPException(status_code=409, detail="An account already exists for this email")
        now = _utc_now()
        tenant_id = str(uuid4())
        user_id = str(uuid4())
        slug = _ensure_unique_slug(conn, _slugify(cleaned_name or cleaned_email.split("@", 1)[0]))
        conn.execute(
            "INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (tenant_id, f"{cleaned_name} workspace", slug, now, now),
        )
        conn.execute(
            """
            INSERT INTO users (id, tenant_id, name, email, password_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (user_id, tenant_id, cleaned_name, cleaned_email, _hash_password(password), now, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Failed to create user")
    return _row_to_user_payload(row)


def login_user(email: str, password: str) -> dict[str, Any]:
    ensure_platform_schema()
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email.strip().lower(),)).fetchone()
    if row is None or not _verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return _row_to_user_payload(row)


def oauth_sign_in(provider: str, email: str, name: str | None = None) -> dict[str, Any]:
    ensure_platform_schema()
    provider_name = provider.strip().lower()
    if provider_name not in _SUPPORTED_OAUTH_PROVIDERS:
        raise HTTPException(status_code=400, detail="Unsupported OAuth provider")
    cleaned_email = email.strip().lower()
    if not cleaned_email or "@" not in cleaned_email:
        raise HTTPException(status_code=400, detail="A valid email is required")
    display_name = (name or cleaned_email.split("@", 1)[0]).strip() or cleaned_email.split("@", 1)[0]
    subject = cleaned_email

    with _connect() as conn:
        identity = conn.execute(
            "SELECT user_id FROM user_identities WHERE provider = ? AND provider_subject = ?",
            (provider_name, subject),
        ).fetchone()
        if identity is not None:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (identity["user_id"],)).fetchone()
            if row is None:
                raise HTTPException(status_code=500, detail="Corrupted identity record")
            return _row_to_user_payload(row)

        existing = conn.execute("SELECT * FROM users WHERE email = ?", (cleaned_email,)).fetchone()
        now = _utc_now()
        if existing is None:
            tenant_id = str(uuid4())
            user_id = str(uuid4())
            slug = _ensure_unique_slug(conn, _slugify(display_name))
            conn.execute(
                "INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (tenant_id, f"{display_name} workspace", slug, now, now),
            )
            conn.execute(
                """
                INSERT INTO users (id, tenant_id, name, email, password_hash, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    tenant_id,
                    display_name,
                    cleaned_email,
                    _hash_password(secrets.token_urlsafe(24)),
                    now,
                    now,
                ),
            )
        else:
            user_id = existing["id"]
        conn.execute(
            "INSERT INTO user_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid4()), user_id, provider_name, subject, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Failed to sign in")
    return _row_to_user_payload(row)


def create_session_response(response: Response, user: dict[str, Any]) -> dict[str, Any]:
    ensure_platform_schema()
    with _connect() as conn:
        token = _issue_session(conn, user["id"])
        conn.commit()
    _set_session_cookie(response, token)
    return user


def logout_session(token: str | None) -> None:
    if not token:
        return
    ensure_platform_schema()
    with _connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()


def resolve_session_user(request: Request) -> dict[str, Any] | None:
    ensure_platform_schema()
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    now = datetime.now(timezone.utc)
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT users.*
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = ?
            """,
            (token,),
        ).fetchone()
        session_row = conn.execute(
            "SELECT expires_at FROM sessions WHERE token = ?",
            (token,),
        ).fetchone()
        if session_row is None:
            return None
        try:
            expires_at = datetime.fromisoformat(session_row["expires_at"])
        except ValueError:
            logout_session(token)
            return None
        if expires_at <= now:
            logout_session(token)
            return None
    if row is None:
        return None
    return _row_to_user_payload(row)


def set_current_user(user: dict[str, Any] | None):
    return _current_user.set(user)


def reset_current_user(token: Any) -> None:
    _current_user.reset(token)


def get_current_user() -> dict[str, Any] | None:
    return _current_user.get()


def require_current_user() -> dict[str, Any]:
    user = get_current_user()
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def assign_project_to_current_user(project_id: str) -> None:
    user = get_current_user()
    if user is None:
        return
    ensure_platform_schema()
    with _connect() as conn:
        existing = conn.execute(
            "SELECT owner_user_id FROM project_memberships WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO project_memberships (project_id, tenant_id, owner_user_id, created_at) VALUES (?, ?, ?, ?)",
                (project_id, user["tenantId"], user["id"], _utc_now()),
            )
        conn.commit()


def list_owned_project_ids(user: dict[str, Any]) -> set[str]:
    ensure_platform_schema()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT project_id FROM project_memberships WHERE tenant_id = ? ORDER BY created_at DESC",
            (user["tenantId"],),
        ).fetchall()
    return {row["project_id"] for row in rows}


def current_user_can_access_project(project_id: str) -> bool:
    user = get_current_user()
    if user is None:
        return True
    ensure_platform_schema()
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM project_memberships WHERE project_id = ? AND tenant_id = ?",
            (project_id, user["tenantId"]),
        ).fetchone()
    return row is not None


def require_current_user_project_access(project_id: str) -> None:
    user = get_current_user()
    if user is None:
        return
    if not current_user_can_access_project(project_id):
        raise HTTPException(status_code=403, detail="This project does not belong to the current tenant")


def _load_owned_project_snapshot(project_id: str) -> dict[str, Any]:
    metadata = project_manager.get_project_metadata(project_id)
    scene = SceneData.model_validate(
        project_manager.load_project_file(project_id, "scene.json")
        or {"store": {}, "furniture": []}
    )
    catalog_raw = project_manager.load_project_file(project_id, "catalog.json") or {"products": []}
    products = catalog_raw.get("products", []) if isinstance(catalog_raw, dict) else []
    planograms_payload = project_manager.load_project_file(project_id, "planograms.json") or {"planograms": []}
    planogram_items = planograms_payload.get("planograms", []) if isinstance(planograms_payload, dict) else []
    settings = ProjectSettings.model_validate(
        project_manager.load_project_file(project_id, "settings.json")
        or ProjectSettings().model_dump(mode="json")
    )
    waypoints = SimulationConfig.model_validate(settings.simulation).waypoints
    return {
        "id": metadata.get("id", project_id),
        "name": metadata.get("name", project_id),
        "createdAt": metadata.get("createdAt"),
        "updatedAt": metadata.get("updatedAt"),
        "catalogProducts": len(products),
        "planograms": len([Planogram.model_validate(item) for item in planogram_items]),
        "furniture": len(scene.furniture),
        "checkoutSimulations": len(waypoints),
    }


def _decode_payload(raw_payload: str) -> dict[str, Any]:
    try:
        return json.loads(raw_payload)
    except json.JSONDecodeError:
        return {}


def get_dashboard() -> dict[str, Any]:
    user = require_current_user()
    ensure_platform_schema()
    project_ids = list_owned_project_ids(user)
    projects = [_load_owned_project_snapshot(project_id) for project_id in sorted(project_ids)]
    projects.sort(key=lambda item: ((item["updatedAt"] or ""), item["name"]), reverse=True)

    with _connect() as conn:
        catalogs = [
            {
                "id": row["id"],
                "name": row["name"],
                "description": row["description"],
                "sourceProjectId": row["source_project_id"],
                "productCount": row["product_count"],
                "payload": _decode_payload(row["payload_json"]),
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in conn.execute(
                """
                SELECT * FROM catalog_workspaces
                WHERE tenant_id = ?
                ORDER BY updated_at DESC, name ASC
                """,
                (user["tenantId"],),
            ).fetchall()
        ]
        simulations = [
            {
                "id": row["id"],
                "name": row["name"],
                "description": row["description"],
                "sourceProjectId": row["source_project_id"],
                "scenarioCount": row["scenario_count"],
                "payload": _decode_payload(row["payload_json"]),
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in conn.execute(
                """
                SELECT * FROM checkout_simulation_lists
                WHERE tenant_id = ?
                ORDER BY updated_at DESC, name ASC
                """,
                (user["tenantId"],),
            ).fetchall()
        ]
        agent_requests = [
            {
                "id": row["id"],
                "provider": row["provider"],
                "targetResourceType": row["target_resource_type"],
                "targetResourceId": row["target_resource_id"],
                "prompt": row["prompt"],
                "implementationNotes": row["implementation_notes"],
                "status": row["status"],
                "createdAt": row["created_at"],
            }
            for row in conn.execute(
                """
                SELECT * FROM agent_requests
                WHERE tenant_id = ?
                ORDER BY created_at DESC
                LIMIT 8
                """,
                (user["tenantId"],),
            ).fetchall()
        ]

    return {
        "user": user,
        "tenant": {
            "id": user["tenantId"],
            "name": f"{user['name']} workspace",
        },
        "stats": {
            "projectCount": len(projects),
            "catalogCount": len(catalogs),
            "simulationCount": len(simulations),
            "agentRequestCount": len(agent_requests),
        },
        "projects": projects,
        "catalogs": catalogs,
        "simulations": simulations,
        "agentRequests": agent_requests,
    }


def create_catalog_workspace(
    name: str,
    description: str = "",
    source_project_id: str | None = None,
    product_count: int = 0,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    user = require_current_user()
    if source_project_id:
        require_current_user_project_access(source_project_id)
    now = _utc_now()
    workspace_id = str(uuid4())
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO catalog_workspaces (
                id, tenant_id, owner_user_id, name, description,
                source_project_id, product_count, payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                workspace_id,
                user["tenantId"],
                user["id"],
                name.strip() or "Catalogue",
                description.strip(),
                source_project_id,
                max(int(product_count), 0),
                json.dumps(payload or {}, ensure_ascii=False),
                now,
                now,
            ),
        )
        conn.commit()
    return {
        "id": workspace_id,
        "name": name.strip() or "Catalogue",
        "description": description.strip(),
        "sourceProjectId": source_project_id,
        "productCount": max(int(product_count), 0),
        "payload": payload or {},
        "createdAt": now,
        "updatedAt": now,
    }


def create_checkout_simulation_list(
    name: str,
    description: str = "",
    source_project_id: str | None = None,
    scenario_count: int = 0,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    user = require_current_user()
    if source_project_id:
        require_current_user_project_access(source_project_id)
    now = _utc_now()
    resource_id = str(uuid4())
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO checkout_simulation_lists (
                id, tenant_id, owner_user_id, name, description,
                source_project_id, scenario_count, payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                resource_id,
                user["tenantId"],
                user["id"],
                name.strip() or "Simulation de caisse",
                description.strip(),
                source_project_id,
                max(int(scenario_count), 0),
                json.dumps(payload or {}, ensure_ascii=False),
                now,
                now,
            ),
        )
        conn.commit()
    return {
        "id": resource_id,
        "name": name.strip() or "Simulation de caisse",
        "description": description.strip(),
        "sourceProjectId": source_project_id,
        "scenarioCount": max(int(scenario_count), 0),
        "payload": payload or {},
        "createdAt": now,
        "updatedAt": now,
    }


def create_agent_request(
    provider: str,
    prompt: str,
    target_resource_type: str,
    target_resource_id: str | None = None,
) -> dict[str, Any]:
    user = require_current_user()
    cleaned_prompt = prompt.strip()
    if not cleaned_prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")
    if target_resource_type not in {"project", "catalog", "simulation", "workspace"}:
        raise HTTPException(status_code=400, detail="Unsupported target resource type")
    if target_resource_type == "project" and target_resource_id:
        require_current_user_project_access(target_resource_id)
    now = _utc_now()
    request_id = str(uuid4())
    notes = (
        "Demande enregistrée. Connectez ensuite un agent MCP/outil-calling à l'endpoint "
        "POST /api/platform/mcp pour lire le dashboard et rappeler l'outil submit_change_request "
        "ou create_project selon le besoin."
    )
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO agent_requests (
                id, tenant_id, owner_user_id, provider, target_resource_type,
                target_resource_id, prompt, implementation_notes, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                request_id,
                user["tenantId"],
                user["id"],
                provider.strip().lower() or "custom-agent",
                target_resource_type,
                target_resource_id,
                cleaned_prompt,
                notes,
                "queued",
                now,
            ),
        )
        conn.commit()
    return {
        "id": request_id,
        "provider": provider.strip().lower() or "custom-agent",
        "targetResourceType": target_resource_type,
        "targetResourceId": target_resource_id,
        "prompt": cleaned_prompt,
        "implementationNotes": notes,
        "status": "queued",
        "createdAt": now,
    }


def get_mcp_server_description() -> dict[str, Any]:
    dashboard = get_dashboard() if get_current_user() is not None else None
    base_url = "http://localhost:8000/api/platform/mcp"
    return {
        "name": "shopai-platform-mcp",
        "transport": "http",
        "endpoint": base_url,
        "serverInfo": {
            "name": "shopai-platform-mcp",
            "version": "1.0.0",
        },
        "tools": [
            {
                "name": "get_dashboard",
                "description": "Retourne le dashboard multi-tenant de l'utilisateur courant.",
            },
            {
                "name": "list_projects",
                "description": "Liste les projets du tenant courant.",
            },
            {
                "name": "create_project",
                "description": "Crée un projet appartenant au tenant courant.",
            },
            {
                "name": "submit_change_request",
                "description": "Enregistre une demande de modification à exécuter par un agent.",
            },
        ],
        "connectionSteps": [
            "Démarrer le backend FastAPI sur le port 8000.",
            "S'authentifier dans l'interface web pour obtenir le cookie de session.",
            "Configurer votre agent en transport HTTP vers POST /api/platform/mcp.",
            "Appeler initialize, puis tools/list, puis tools/call.",
            "Utiliser get_dashboard pour découvrir les ressources, puis submit_change_request pour pousser une demande de modification.",
        ],
        "sampleInitialize": {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2026-06-18",
                "capabilities": {},
                "clientInfo": {"name": "custom-agent", "version": "1.0.0"},
            },
        },
        "sampleToolsCall": {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "submit_change_request",
                "arguments": {
                    "provider": "github-copilot",
                    "targetResourceType": "project",
                    "targetResourceId": dashboard["projects"][0]["id"] if dashboard and dashboard["projects"] else None,
                    "prompt": "Ajoute une vue KPI et un onboarding plus orienté retail."
                },
            },
        },
    }


def handle_mcp_request(payload: dict[str, Any]) -> dict[str, Any]:
    ensure_platform_schema()
    method = payload.get("method")
    request_id = payload.get("id")
    params = payload.get("params") or {}

    def _success(result: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    def _error(code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    try:
        if method == "initialize":
            return _success(
                {
                    "protocolVersion": params.get("protocolVersion", "2026-06-18"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": "shopai-platform-mcp",
                        "version": "1.0.0",
                    },
                }
            )
        if method == "tools/list":
            description = get_mcp_server_description()
            return _success(
                {
                    "tools": [
                        {
                            "name": "get_dashboard",
                            "description": "Return the authenticated user's tenant dashboard.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {},
                            },
                        },
                        {
                            "name": "list_projects",
                            "description": "List tenant-owned projects.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {},
                            },
                        },
                        {
                            "name": "create_project",
                            "description": "Create a new tenant-owned project.",
                            "inputSchema": {
                                "type": "object",
                                "required": ["name"],
                                "properties": {
                                    "name": {"type": "string"},
                                },
                            },
                        },
                        {
                            "name": "submit_change_request",
                            "description": "Store an implementation request for a connected agent.",
                            "inputSchema": {
                                "type": "object",
                                "required": ["provider", "targetResourceType", "prompt"],
                                "properties": {
                                    "provider": {"type": "string"},
                                    "targetResourceType": {"type": "string"},
                                    "targetResourceId": {"type": ["string", "null"]},
                                    "prompt": {"type": "string"},
                                },
                            },
                        },
                    ],
                    "instructions": description["connectionSteps"],
                }
            )
        if method == "tools/call":
            tool_name = params.get("name")
            arguments = params.get("arguments") or {}
            if tool_name == "get_dashboard":
                dashboard = get_dashboard()
                return _success(
                    {
                        "content": [{"type": "text", "text": json.dumps(dashboard, ensure_ascii=False, indent=2)}],
                        "structuredContent": dashboard,
                    }
                )
            if tool_name == "list_projects":
                dashboard = get_dashboard()
                return _success(
                    {
                        "content": [{"type": "text", "text": json.dumps(dashboard["projects"], ensure_ascii=False, indent=2)}],
                        "structuredContent": {"projects": dashboard["projects"]},
                    }
                )
            if tool_name == "create_project":
                name = str(arguments.get("name", "")).strip()
                if not name:
                    raise HTTPException(status_code=400, detail="name is required")
                metadata = project_manager.create_project(str(uuid4()), name)
                assign_project_to_current_user(metadata["id"])
                return _success(
                    {
                        "content": [{"type": "text", "text": f"Project created: {metadata['id']}"}],
                        "structuredContent": metadata,
                    }
                )
            if tool_name == "submit_change_request":
                record = create_agent_request(
                    provider=str(arguments.get("provider", "custom-agent")),
                    prompt=str(arguments.get("prompt", "")),
                    target_resource_type=str(arguments.get("targetResourceType", "workspace")),
                    target_resource_id=arguments.get("targetResourceId"),
                )
                return _success(
                    {
                        "content": [{"type": "text", "text": record["implementationNotes"]}],
                        "structuredContent": record,
                    }
                )
            return _error(-32601, f"Unknown tool: {tool_name}")
        return _error(-32601, f"Unknown method: {method}")
    except HTTPException as exc:
        return _error(exc.status_code, str(exc.detail))

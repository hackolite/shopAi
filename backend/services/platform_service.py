from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import urllib.parse
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from fastapi import HTTPException, Request, Response

import services.project_manager as project_manager
from models.project import Catalog, Planogram, ProjectSettings, SceneData, SimulationConfig
from services.layout_audit import audit_project_layout
from services.reference_templates import (
    REFERENCE_PROJECT_IDS,
    REFERENCE_PROJECT_NAMES,
    load_default_assortment,
    load_reference_template,
)

SESSION_COOKIE_NAME = "shopai_session"
SESSION_DURATION_DAYS = 14
OAUTH_STATE_TTL_SECONDS = 600
_SUPPORTED_OAUTH_PROVIDERS = {"google", "github"}
_current_user: ContextVar[dict[str, Any] | None] = ContextVar(
    "shopai_current_user",
    default=None,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> Path:
    storage_root = Path(project_manager.STORAGE_ROOT)
    storage_root.mkdir(parents=True, exist_ok=True)
    return storage_root / "_platform.sqlite3"


def _oauth_state_secret() -> str:
    return os.getenv("SHOPAI_OAUTH_STATE_SECRET", "shopai-dev-oauth-state-secret-change-me")


def _sanitize_next_path(next_path: str | None) -> str:
    if not next_path or not next_path.startswith("/") or next_path.startswith("//"):
        return "/"
    return next_path


def build_safe_local_redirect_url(request_base_url: str, next_path: str | None) -> str:
    sanitized_path = _sanitize_next_path(next_path)
    parsed_base = urllib.parse.urlsplit(request_base_url)
    if not parsed_base.scheme or not parsed_base.netloc:
        raise HTTPException(status_code=400, detail="Invalid request base URL")
    return urllib.parse.urlunsplit((parsed_base.scheme, parsed_base.netloc, sanitized_path, "", ""))


def _provider_env_prefix(provider: str) -> str:
    return provider.strip().upper()


def oauth_provider_settings(provider: str, request_base_url: str | None = None) -> dict[str, Any]:
    provider_name = provider.strip().lower()
    if provider_name not in _SUPPORTED_OAUTH_PROVIDERS:
        raise HTTPException(status_code=400, detail="Unsupported OAuth provider")

    env_prefix = _provider_env_prefix(provider_name)
    client_id = os.getenv(f"{env_prefix}_CLIENT_ID", "").strip()
    client_secret = os.getenv(f"{env_prefix}_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv(f"{env_prefix}_REDIRECT_URI", "").strip()
    if not redirect_uri and request_base_url:
        redirect_uri = f"{request_base_url.rstrip('/')}/api/platform/auth/oauth/{provider_name}/callback"

    config: dict[str, Any] = {
        "provider": provider_name,
        "clientId": client_id,
        "clientSecret": client_secret,
        "redirectUri": redirect_uri,
        "configured": bool(client_id and client_secret and redirect_uri),
        "startPath": f"/api/platform/auth/oauth/{provider_name}/start",
    }
    if provider_name == "google":
        config.update(
            {
                "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
                "tokenUrl": "https://oauth2.googleapis.com/token",
                "userinfoUrl": "https://openidconnect.googleapis.com/v1/userinfo",
                "scope": "openid email profile",
            }
        )
    else:
        config.update(
            {
                "authorizeUrl": "https://github.com/login/oauth/authorize",
                "tokenUrl": "https://github.com/login/oauth/access_token",
                "userinfoUrl": "https://api.github.com/user",
                "emailUrl": "https://api.github.com/user/emails",
                "scope": "read:user user:email",
            }
        )
    return config


def get_oauth_provider_status(request_base_url: str | None = None) -> list[dict[str, Any]]:
    providers: list[dict[str, Any]] = []
    for provider in sorted(_SUPPORTED_OAUTH_PROVIDERS):
        settings = oauth_provider_settings(provider, request_base_url)
        providers.append(
            {
                "name": provider,
                "configured": settings["configured"],
                "startPath": settings["startPath"],
            }
        )
    return providers


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

            CREATE TABLE IF NOT EXISTS tenant_default_assets (
                tenant_id TEXT NOT NULL,
                asset_key TEXT NOT NULL,
                resource_id TEXT NOT NULL,
                PRIMARY KEY (tenant_id, asset_key)
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


def ensure_tenant_defaults(user: dict[str, Any]) -> None:
    """Provision each asset once, retaining edits, renames and intentional deletions."""
    ensure_platform_schema()
    with _connect() as conn:
        # Serialize concurrent first logins/dashboards before writing project files.
        conn.execute("BEGIN IMMEDIATE")
        existing = {
            row["asset_key"]
            for row in conn.execute(
                "SELECT asset_key FROM tenant_default_assets WHERE tenant_id = ?",
                (user["tenantId"],),
            )
        }
        for source_id in REFERENCE_PROJECT_IDS:
            membership = conn.execute(
                "SELECT 1 FROM project_memberships WHERE project_id = ? AND tenant_id = ?",
                (source_id, user["tenantId"]),
            ).fetchone()
            if membership is None:
                continue
            metadata = project_manager.load_project_file(source_id, "project.json")
            if metadata is None:
                # A deleted legacy reference can leave its old membership behind.
                conn.execute(
                    "DELETE FROM project_memberships WHERE project_id = ? AND tenant_id = ?",
                    (source_id, user["tenantId"]),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO tenant_default_assets VALUES (?, ?, ?)",
                    (user["tenantId"], source_id, source_id),
                )
                existing.add(source_id)
                continue
            # Older installations could claim shipped IDs. Preserve their edits in
            # a private copy, rather than making a canonical source tenant-writable.
            clone = project_manager.duplicate_project(source_id, metadata["name"])
            conn.execute(
                "UPDATE project_memberships SET project_id = ? WHERE project_id = ?",
                (clone["id"], source_id),
            )
            for table in ("catalog_workspaces", "checkout_simulation_lists"):
                conn.execute(
                    f"UPDATE {table} SET source_project_id = ? WHERE tenant_id = ? AND source_project_id = ?",
                    (clone["id"], user["tenantId"], source_id),
                )
            conn.execute(
                "UPDATE agent_requests SET target_resource_id = ? WHERE tenant_id = ? "
                "AND target_resource_type = 'project' AND target_resource_id = ?",
                (clone["id"], user["tenantId"], source_id),
            )
            conn.execute(
                "INSERT OR IGNORE INTO tenant_default_assets VALUES (?, ?, ?)",
                (user["tenantId"], source_id, clone["id"]),
            )
            existing.add(source_id)

        assets = [(source_id, False) for source_id in REFERENCE_PROJECT_IDS]
        assets.extend((source_id, True) for source_id in REFERENCE_PROJECT_IDS[:2])
        for source_id, layout_only in assets:
            asset_key = source_id + ("_layout" if layout_only else "")
            if asset_key in existing:
                continue
            name = REFERENCE_PROJECT_NAMES[source_id] + (" – Implantation seule" if layout_only else "")
            snapshot = load_reference_template(source_id, layout_only=layout_only)
            metadata = project_manager.import_project(snapshot, name)
            project_manager.save_project_file(metadata["id"], "textures.json", snapshot["textures"])
            conn.execute(
                "INSERT INTO project_memberships VALUES (?, ?, ?, ?)",
                (metadata["id"], user["tenantId"], user["id"], _utc_now()),
            )
            conn.execute(
                "INSERT INTO tenant_default_assets VALUES (?, ?, ?)",
                (user["tenantId"], asset_key, metadata["id"]),
            )
        if "assortment" not in existing:
            catalog = load_default_assortment()
            workspace_id = str(uuid4())
            now = _utc_now()
            conn.execute(
                "INSERT INTO catalog_workspaces "
                "(id, tenant_id, owner_user_id, name, description, product_count, payload_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (workspace_id, user["tenantId"], user["id"], "Assortiment Carrefour",
                 "Assortiment Carrefour fourni avec ShopAI", len(catalog["products"]),
                 json.dumps(catalog, ensure_ascii=False), now, now),
            )
            conn.execute(
                "INSERT INTO tenant_default_assets VALUES (?, ?, ?)",
                (user["tenantId"], "assortment", workspace_id),
            )


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


def _provisioned_user_payload(row: sqlite3.Row) -> dict[str, Any]:
    user = _row_to_user_payload(row)
    ensure_tenant_defaults(user)
    return user


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
    return _provisioned_user_payload(row)


def login_user(email: str, password: str) -> dict[str, Any]:
    ensure_platform_schema()
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email.strip().lower(),)).fetchone()
    if row is None or not _verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return _provisioned_user_payload(row)


def _sign_oauth_state(payload_b64: str) -> str:
    return hmac.new(
        _oauth_state_secret().encode("utf-8"),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def build_oauth_state(provider: str, next_path: str | None) -> str:
    payload = {
        "provider": provider.strip().lower(),
        "next": _sanitize_next_path(next_path),
        "nonce": secrets.token_urlsafe(12),
        "issuedAt": int(time.time()),
    }
    payload_b64 = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    return f"{payload_b64}.{_sign_oauth_state(payload_b64)}"


def parse_oauth_state(provider: str, state: str) -> dict[str, Any]:
    payload_b64, _, signature = state.partition(".")
    if not payload_b64 or not signature:
        raise HTTPException(status_code=400, detail="Invalid OAuth state")
    if not hmac.compare_digest(_sign_oauth_state(payload_b64), signature):
        raise HTTPException(status_code=400, detail="Invalid OAuth state signature")
    try:
        payload = json.loads(urllib.parse.unquote(payload_b64))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid OAuth state payload") from exc
    issued_at = int(payload.get("issuedAt", 0))
    if time.time() - issued_at > OAUTH_STATE_TTL_SECONDS:
        raise HTTPException(status_code=400, detail="OAuth state has expired")
    if payload.get("provider") != provider.strip().lower():
        raise HTTPException(status_code=400, detail="OAuth provider mismatch")
    payload["next"] = _sanitize_next_path(str(payload.get("next", "/")))
    return payload


def get_oauth_authorization_url(provider: str, request_base_url: str, next_path: str | None = "/") -> str:
    config = oauth_provider_settings(provider, request_base_url)
    if not config["configured"]:
        raise HTTPException(status_code=503, detail=f"OAuth provider '{provider}' is not configured")
    state = build_oauth_state(provider, next_path)
    query = {
        "client_id": config["clientId"],
        "redirect_uri": config["redirectUri"],
        "response_type": "code",
        "scope": config["scope"],
        "state": state,
    }
    return f"{config['authorizeUrl']}?{urllib.parse.urlencode(query)}"


def _fetch_oauth_profile(provider: str, code: str, request_base_url: str) -> tuple[str, str]:
    config = oauth_provider_settings(provider, request_base_url)
    if not config["configured"]:
        raise HTTPException(status_code=503, detail=f"OAuth provider '{provider}' is not configured")
    with httpx.Client(timeout=30.0, follow_redirects=True) as client:
        token_response = client.post(
            config["tokenUrl"],
            data={
                "client_id": config["clientId"],
                "client_secret": config["clientSecret"],
                "code": code,
                "redirect_uri": config["redirectUri"],
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
        )
        token_response.raise_for_status()
        token_payload = token_response.json()
        access_token = token_payload.get("access_token")
        if not access_token:
            raise HTTPException(status_code=502, detail=f"OAuth token exchange failed for {provider}")

        if provider == "google":
            profile_response = client.get(
                config["userinfoUrl"],
                headers={"Authorization": " ".join(["Bearer", str(access_token)])},
            )
            profile_response.raise_for_status()
            profile = profile_response.json()
            email = str(profile.get("email") or "").strip().lower()
            name = str(profile.get("name") or profile.get("given_name") or email.split("@", 1)[0]).strip()
            if not email:
                raise HTTPException(status_code=502, detail="Google OAuth response did not include an email")
            return email, name

        user_response = client.get(
            config["userinfoUrl"],
            headers={
                "Authorization": f"token {access_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        user_response.raise_for_status()
        user_payload = user_response.json()
        email = str(user_payload.get("email") or "").strip().lower()
        if not email:
            email_response = client.get(
                config["emailUrl"],
                headers={
                    "Authorization": f"token {access_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            email_response.raise_for_status()
            emails = email_response.json()
            primary = next(
                (
                    item
                    for item in emails
                    if item.get("email") and item.get("verified") and item.get("primary")
                ),
                None,
            ) or next((item for item in emails if item.get("email") and item.get("verified")), None)
            email = str(primary.get("email") if primary else "").strip().lower()
        if not email:
            raise HTTPException(status_code=502, detail="GitHub OAuth response did not include a verified email")
        name = str(user_payload.get("name") or user_payload.get("login") or email.split("@", 1)[0]).strip()
        return email, name


def complete_oauth_sign_in(
    provider: str,
    code: str,
    state: str,
    request_base_url: str,
) -> tuple[dict[str, Any], str]:
    parsed_state = parse_oauth_state(provider, state)
    email, name = _fetch_oauth_profile(provider.strip().lower(), code, request_base_url)
    user = oauth_sign_in(provider, email, name)
    return user, parsed_state["next"]


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
            return _provisioned_user_payload(row)

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
    return _provisioned_user_payload(row)


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
    if project_id in REFERENCE_PROJECT_IDS:
        raise HTTPException(status_code=403, detail="Reference templates cannot be owned")
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
    ensure_tenant_defaults(user)
    with _connect() as conn:
        rows = conn.execute(
            "SELECT project_id FROM project_memberships WHERE tenant_id = ? ORDER BY created_at DESC",
            (user["tenantId"],),
        ).fetchall()
    return {
        row["project_id"] for row in rows
        if row["project_id"] not in REFERENCE_PROJECT_IDS
        and project_manager.load_project_file(row["project_id"], "project.json") is not None
    }


def current_user_can_access_project(project_id: str) -> bool:
    if project_id in REFERENCE_PROJECT_IDS:
        return False
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
    if project_id in REFERENCE_PROJECT_IDS:
        raise HTTPException(status_code=403, detail="Reference templates are read-only; use a tenant copy")
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
        "oauthProviders": get_oauth_provider_status(),
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


def get_agent_capability_report(project_id: str | None = None) -> dict[str, Any]:
    user = require_current_user()
    report: dict[str, Any] = {
        "tenantId": user["tenantId"],
        "oauthProviders": get_oauth_provider_status(),
        "apiAutomation": get_agent_api_description(),
        "agentPilot": {
            "script": "scripts/astra_build_store.py",
            "supportsAgentGeneratedLayout": True,
            "supportsSuppliedLayout": True,
            "supportsStoreDimensioning": True,
            "supportsFurniturePlacement": True,
            "supportsCatalogImport": True,
            "supportsProductPlacement": True,
            "supportsAbsolutePositionVerification": True,
        },
    }
    if project_id is None:
        return report
    require_current_user_project_access(project_id)
    metadata = project_manager.get_project_metadata(project_id)
    scene = SceneData.model_validate(
        project_manager.load_project_file(project_id, "scene.json")
        or {"store": {}, "furniture": []}
    )
    catalog = project_manager.load_project_file(project_id, "catalog.json") or {"products": []}
    planograms_raw = project_manager.load_project_file(project_id, "planograms.json") or {"planograms": []}
    report["projectAudit"] = audit_project_layout(
        metadata=metadata,
        scene=scene,
        catalog=Catalog.model_validate(catalog),
        planograms=[Planogram.model_validate(item) for item in planograms_raw.get("planograms", [])],
    )
    return report


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
        "Demande enregistrée. Connectez ensuite un agent à l'API REST du dépôt "
        "(openapi.json + endpoints /api/platform et /api/cad/projects) pour lire le dashboard, "
        "vérifier le projet et appliquer les changements nécessaires."
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


def get_agent_api_description(base_url: str | None = None) -> dict[str, Any]:
    root = base_url.rstrip("/") if base_url else "http://localhost:8000"
    return {
        "name": "shopai-agent-rest-guide",
        "openApiUrl": f"{root}/openapi.json",
        "dashboardUrl": f"{root}/api/platform/dashboard",
        "capabilityUrl": f"{root}/api/platform/agent-capabilities",
        "changeRequestUrl": f"{root}/api/platform/agent-requests",
        "workflowSteps": [
            "Démarrer le backend FastAPI sur le port 8000.",
            "S'authentifier dans l'interface web pour obtenir le cookie de session.",
            "Donner à l'agent le schéma OpenAPI /openapi.json ou des tool calls REST équivalents.",
            "Lister les projets via /api/platform/dashboard.",
            "Vérifier un projet via /api/platform/agent-capabilities?projectId=...",
            "Pousser une demande via /api/platform/agent-requests si vous gardez une inbox utilisateur.",
        ],
        "sampleRequests": {
            "dashboard": {
                "method": "GET",
                "url": f"{root}/api/platform/dashboard",
            },
            "verifyProject": {
                "method": "GET",
                "url": f"{root}/api/platform/agent-capabilities?projectId=<project-id>",
            },
            "submitChangeRequest": {
                "method": "POST",
                "url": f"{root}/api/platform/agent-requests",
                "json": {
                    "provider": "github-copilot",
                    "targetResourceType": "project",
                    "targetResourceId": "<project-id>",
                    "prompt": "Ajoute une vue KPI et un onboarding plus orienté retail.",
                },
            },
        },
    }

"""Proxy the studio chat prompt to an externally-orchestrated LLM agent.

This module never talks to any LLM provider itself and never stores a
provider API key. It only forwards the free-text prompt to a webhook URL
that is configured **server-side only**, via the ``STUDIO_LLM_WEBHOOK_URL``
environment variable — never accepted from a client payload, to avoid
SSRF. The external orchestrator is expected to:

1. receive ``{"projectId", "prompt", "confirm"}`` ;
2. call back into this same backend's REST API (``/openapi.json``,
   ``/api/cad/projects/...``), authenticated with the forwarded ShopAI
   session, exactly as documented in ``scripts/README.md`` ;
3. reply with the same JSON contract as the built-in assistant
   (``message``, ``requiresConfirmation``, ``changed``, ``projectId``,
   ``steps``).

The reply is strictly validated (unknown fields rejected) before being
relayed to the frontend, and any reported write is re-audited from the
persisted project files before being trusted — an external agent's
self-reported success is never taken at face value.
"""
from __future__ import annotations

import os
from typing import Any

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, ValidationError

from services import platform_service, project_manager
from services.studio_assistant import audit_persisted_project

_WEBHOOK_URL_ENV = "STUDIO_LLM_WEBHOOK_URL"
_WEBHOOK_TOKEN_ENV = "STUDIO_LLM_WEBHOOK_TOKEN"
_WEBHOOK_TIMEOUT_ENV = "STUDIO_LLM_WEBHOOK_TIMEOUT_SECONDS"
_DEFAULT_TIMEOUT_SECONDS = 30.0
_MIN_TIMEOUT_SECONDS = 1.0
_MAX_TIMEOUT_SECONDS = 120.0
_SESSION_HEADER = "X-ShopAI-Session"


class _WebhookResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str
    requiresConfirmation: bool
    changed: bool
    projectId: str | None = None
    steps: list[str] = []


def llm_assistant_enabled() -> bool:
    """True when a server operator configured an external agent webhook."""
    return bool(os.environ.get(_WEBHOOK_URL_ENV, "").strip())


def _timeout_seconds() -> float:
    raw = os.environ.get(_WEBHOOK_TIMEOUT_ENV, "").strip()
    try:
        value = float(raw) if raw else _DEFAULT_TIMEOUT_SECONDS
    except ValueError:
        value = _DEFAULT_TIMEOUT_SECONDS
    return max(_MIN_TIMEOUT_SECONDS, min(value, _MAX_TIMEOUT_SECONDS))


def run_llm_assistant(
    project_id: str,
    prompt: str,
    *,
    confirm: bool,
    session_cookie: str | None = None,
) -> dict[str, Any]:
    platform_service.require_current_user()
    platform_service.require_current_user_project_access(project_id)
    project_manager.ensure_project_exists(project_id)

    webhook_url = os.environ.get(_WEBHOOK_URL_ENV, "").strip()
    if not webhook_url:
        raise HTTPException(
            status_code=503,
            detail=(
                "Aucun agent LLM externe configuré côté serveur "
                f"({_WEBHOOK_URL_ENV} absent). Utilisez l'assistant local "
                "ou demandez à un administrateur de brancher un orchestrateur."
            ),
        )

    headers = {"Content-Type": "application/json"}
    webhook_token = os.environ.get(_WEBHOOK_TOKEN_ENV, "").strip()
    if webhook_token:
        headers["Authorization"] = "Bearer " + webhook_token
    if session_cookie:
        headers[_SESSION_HEADER] = session_cookie

    payload = {"projectId": project_id, "prompt": prompt, "confirm": confirm}
    try:
        response = httpx.post(webhook_url, json=payload, headers=headers, timeout=_timeout_seconds())
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Agent LLM externe injoignable : {exc}") from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Agent LLM externe a répondu HTTP {response.status_code}",
        )

    try:
        validated = _WebhookResponse.model_validate(response.json())
    except (ValueError, ValidationError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Réponse de l'agent LLM externe invalide : {exc}",
        ) from exc

    result = validated.model_dump(mode="json", exclude_none=True)

    if validated.changed and validated.projectId:
        # Mandatory post-write check: never trust an external agent's
        # self-reported success without re-reading and auditing the actual
        # persisted state it claims to have written.
        try:
            audit = audit_persisted_project(validated.projectId)
        except (ValueError, KeyError, TypeError, OSError, ValidationError):
            result["steps"] = [
                *result.get("steps", []),
                "Audit post-écriture impossible : état du projet introuvable ou invalide "
                "après l'action de l'agent externe.",
            ]
        else:
            if not audit["ok"]:
                issues = [issue for check in audit["checks"].values() for issue in check["issues"]]
                result["steps"] = [
                    *result.get("steps", []),
                    f"Audit post-écriture : {audit['issueCount']} anomalie(s) détectée(s) "
                    "dans le projet modifié par l'agent externe.",
                    *issues[:20],
                ]
    return result

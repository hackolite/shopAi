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
import logging
import time
from typing import Any

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, StrictBool, ValidationError, model_validator

from services import platform_service, project_manager
from services.studio_assistant import audit_persisted_project

_log = logging.getLogger("uvicorn.error.shopai.llm_proxy")
_WEBHOOK_URL_ENV = "STUDIO_LLM_WEBHOOK_URL"
_WEBHOOK_TIMEOUT_ENV = "STUDIO_LLM_WEBHOOK_TIMEOUT_SECONDS"
_DEFAULT_TIMEOUT_SECONDS = 30.0
_MIN_TIMEOUT_SECONDS = 1.0
_MAX_TIMEOUT_SECONDS = 120.0
_SESSION_HEADER = "X-ShopAI-Session"
_STATUS_TIMEOUT_SECONDS = 5.0


class _WebhookResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str
    requiresConfirmation: StrictBool
    changed: StrictBool
    projectId: str | None = None
    steps: list[str] = []
    confirmationToken: str | None = None

    @model_validator(mode="after")
    def validate_write_result(self):
        if self.changed and (not self.projectId or self.requiresConfirmation):
            raise ValueError("A write requires a projectId and cannot request confirmation")
        return self


def llm_assistant_enabled() -> bool:
    """True when a server operator configured an external agent webhook."""
    return bool(os.environ.get(_WEBHOOK_URL_ENV, "").strip())


def llm_assistant_status() -> dict[str, Any]:
    """Return a preflight status for the external LLM webhook."""
    webhook_url = os.environ.get(_WEBHOOK_URL_ENV, "").strip()
    if not webhook_url:
        return {
            "enabled": False,
            "reachable": False,
            "status": "missing",
            "message": (
                "Provider LLM introuvable : variable serveur "
                f"{_WEBHOOK_URL_ENV} absente."
            ),
        }
    try:
        response = httpx.get(webhook_url, timeout=min(_timeout_seconds(), _STATUS_TIMEOUT_SECONDS))
    except httpx.HTTPError as exc:
        _log.warning("External LLM preflight failed error_class=%s", type(exc).__name__)
        return {
            "enabled": True,
            "reachable": False,
            "status": "unreachable",
            "message": (
                "Provider LLM configuré mais injoignable. Vérifiez l'orchestrateur, "
                "le réseau et l'URL du webhook."
            ),
        }
    if response.status_code in (200, 202, 204, 401, 403, 405, 409, 422, 429):
        return {
            "enabled": True,
            "reachable": True,
            "status": "ready",
            "message": "Provider LLM détecté et joignable.",
        }
    _log.warning("External LLM preflight returned unexpected status=%d", response.status_code)
    return {
        "enabled": True,
        "reachable": False,
        "status": "error",
        "message": (
            "Provider LLM détecté mais le prétest a échoué "
            f"(HTTP {response.status_code})."
        ),
    }


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
    category: str | None = None,
    confirmation_token: str | None = None,
) -> dict[str, Any]:
    started = time.monotonic()
    platform_service.require_current_user()
    platform_service.require_current_user_project_access(project_id)
    project_manager.ensure_project_exists(project_id)
    _log.info(
        "External LLM request started confirm=%s",
        confirm,
    )

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
    if not session_cookie or not session_cookie.strip():
        raise HTTPException(status_code=401, detail="Session ShopAI requise pour contacter l'agent LLM.")
    headers[_SESSION_HEADER] = session_cookie

    payload = {"projectId": project_id, "prompt": prompt, "confirm": confirm}
    if category is not None:
        payload["category"] = category
    if confirmation_token is not None:
        payload["confirmationToken"] = confirmation_token
    try:
        response = httpx.post(webhook_url, json=payload, headers=headers, timeout=_timeout_seconds())
    except httpx.HTTPError as exc:
        _log.warning(
            "External LLM transport failure error_class=%s duration_ms=%.0f",
            type(exc).__name__, (time.monotonic() - started) * 1000,
        )
        raise HTTPException(
            status_code=502,
            detail="Agent LLM externe injoignable : vérifiez qu'il est démarré et que son URL et son délai sont corrects.",
        ) from exc

    _log.info(
        "External LLM response received status=%d duration_ms=%.0f",
        response.status_code, (time.monotonic() - started) * 1000,
    )
    if response.status_code >= 400:
        _log.warning("External LLM returned error status=%d", response.status_code)
        explanations = {
            401: "Session ShopAI absente, invalide ou expirée. Reconnectez-vous puis demandez un nouvel aperçu.",
            403: "Accès au projet refusé. Vérifiez le compte et l'organisation sélectionnés.",
            404: "Projet ou route de l'agent introuvable. Vérifiez le projet et l'URL du webhook côté serveur.",
            422: "Plan ou demande non exécutable. Vérifiez la configuration du fournisseur et reformulez la demande.",
            429: "Agent ou fournisseur temporairement limité. Réessayez plus tard.",
            502: "L'agent ne peut pas joindre le backend ou le fournisseur LLM. Consultez leurs logs.",
            503: "Agent ou backend temporairement indisponible. Vérifiez les services et leur configuration.",
            504: "Le délai de l'agent ou du fournisseur LLM a été dépassé. Réessayez plus tard.",
        }
        if response.status_code == 409:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Confirmation refusée : aperçu expiré, déjà utilisé, ou projet modifié. "
                    "Demandez un nouvel aperçu avant de confirmer."
                ),
            )
        raise HTTPException(
            status_code=response.status_code if response.status_code in explanations else 502,
            detail=explanations.get(response.status_code, "L'agent LLM externe a échoué. Consultez les logs du service."),
        )

    try:
        validated = _WebhookResponse.model_validate(response.json())
    except (ValueError, ValidationError) as exc:
        _log.warning(
            "External LLM returned invalid payload error_class=%s",
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="Réponse de l'agent LLM externe invalide : contrat de réponse non respecté.",
        ) from exc

    result = validated.model_dump(mode="json", exclude_none=True)

    if validated.projectId:
        platform_service.require_current_user_project_access(validated.projectId)
    if validated.changed and not confirm:
        raise HTTPException(status_code=502, detail="L'agent a signalé une écriture sans confirmation.")

    if validated.changed and validated.projectId:
        # Mandatory post-write check: never trust an external agent's
        # self-reported success without re-reading and auditing the actual
        # persisted state it claims to have written.
        try:
            _log.info("Post-write audit started")
            audit = audit_persisted_project(validated.projectId)
        except (ValueError, KeyError, TypeError, OSError, ValidationError, HTTPException) as exc:
            _log.warning("Post-write audit failed error_class=%s", type(exc).__name__)
            result["message"] = (
                "L'agent a signalé des modifications, mais leur validation a échoué. "
                "Le résultat ne peut pas être considéré comme réussi."
            )
            result["steps"] = [
                *result.get("steps", []),
                "Audit post-écriture impossible : état du projet introuvable ou invalide "
                "après l'action de l'agent externe.",
            ]
        else:
            _log.info("Post-write audit completed ok=%s", audit["ok"])
            if not audit["ok"]:
                result["message"] = (
                    "Des modifications ont été enregistrées, mais l'audit a détecté des anomalies. "
                    "Le résultat ne peut pas être considéré comme réussi."
                )
                _log.warning(
                    "Post-write audit detected issues issue_count=%s",
                    audit.get("issueCount"),
                )
                issues = [issue for check in audit["checks"].values() for issue in check["issues"]]
                result["steps"] = [
                    *result.get("steps", []),
                    f"Audit post-écriture : {audit['issueCount']} anomalie(s) détectée(s) "
                    "dans le projet modifié par l'agent externe.",
                    *issues[:20],
                ]
    _log.info(
        "External LLM request completed changed=%s confirmation_required=%s duration_ms=%.0f",
        validated.changed, validated.requiresConfirmation, (time.monotonic() - started) * 1000,
    )
    return result

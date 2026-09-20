from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import HTTPException

from .config import Settings
from .llm import LLMPlanner
from .schemas import WebhookRequest, WebhookResponse
from .tools import BackendApiError, BackendTools
from .workflow import Operation, compile_operations, fingerprint, planner_context, read_state


@dataclass(frozen=True)
class PendingPlan:
    expires: int
    binding: str
    state_hash: str
    create: bool
    project_name: str
    operations: list[Operation]


# Intentionally fail closed across process restarts/workers: a missing preview must
# be regenerated, never reconstructed by asking the LLM a second time.
_pending: dict[str, PendingPlan] = {}
_guard = threading.Lock()
_TTL = 600
_MAX_PENDING = 128
_SIGNING_KEY = secrets.token_bytes(32)
_log = logging.getLogger("uvicorn.error.shopai.agent")


def _binding(payload: WebhookRequest, session: str) -> str:
    data = json.dumps([payload.projectId, payload.prompt, payload.category, session], ensure_ascii=False)
    return hmac.new(_SIGNING_KEY, data.encode(), hashlib.sha256).hexdigest()


class ShopAIOrchestrator:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.planner = LLMPlanner(settings)

    async def run(self, payload: WebhookRequest, session_cookie: str | None = None) -> WebhookResponse:
        if not session_cookie or not session_cookie.strip():
            raise HTTPException(401, "Session utilisateur requise.")
        binding = _binding(payload, session_cookie)
        tools = BackendTools(self.settings, session_cookie=session_cookie)
        if payload.confirm:
            token = payload.confirmationToken or ""
            with _guard:
                pending = _pending.get(token)
                if not pending or pending.expires <= time.time() or not hmac.compare_digest(pending.binding, binding):
                    raise HTTPException(409, "Confirmation absente, expirée ou invalide. Génère un nouvel aperçu.")
                del _pending[token]
            return await self._execute(payload, tools, pending)
        if payload.confirmationToken:
            raise HTTPException(422, "Le jeton de confirmation s'utilise uniquement avec confirm=true.")
        try:
            _log.info("Reading authorized project before planning")
            state = await read_state(tools, payload.projectId)
            _log.info("Project access validated")
            library = {item["id"]: item for item in (await tools.get_furniture_library())["furniture"]}
            context = planner_context(state, library)
            if len(json.dumps(context)) > 500_000:
                raise ValueError("Contexte trop volumineux pour une planification bornée.")
            started = time.monotonic()
            _log.info("Planning started provider=%s", self.settings.llm_provider)
            plan = await self.planner.build_plan(payload.prompt, payload.category, context)
            _log.info("Planning completed provider=%s duration_ms=%.0f", self.settings.llm_provider, (time.monotonic() - started) * 1000)
            if plan.intent == "other":
                return WebhookResponse(
                    message="Demande hors du périmètre implantation/assortiment; aucune écriture.",
                    requiresConfirmation=False,
                    changed=False,
                    projectId=payload.projectId,
                )
            create, operations = compile_operations(tools, plan, state, library)
        except BackendApiError as exc:
            _log.warning("Project read rejected status=%d", exc.status_code)
            raise HTTPException(exc.status_code, "Impossible de lire le projet pour préparer le plan.") from exc
        except httpx.HTTPError as exc:
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else "unavailable"
            try:
                request_url = str(exc.request.url)
            except RuntimeError:
                request_url = "unavailable"
            _log.warning(
                "Provider request failed provider=%s error_class=%s status=%s request_url=%s",
                self.settings.llm_provider, type(exc).__name__,
                status,
                request_url,
            )
            raise HTTPException(502, "Le fournisseur LLM est indisponible; aucun plan de remplacement exécuté.") from exc
        except (ValueError, KeyError, TypeError, OSError) as exc:
            _log.warning("Plan rejected error_class=%s", type(exc).__name__)
            raise HTTPException(422, "Plan non exécutable : vérifiez la configuration du fournisseur et la demande.") from exc
        expires = int(time.time()) + _TTL
        nonce = secrets.token_urlsafe(24)
        signature = hmac.new(_SIGNING_KEY, f"{nonce}.{expires}.{binding}".encode(), hashlib.sha256).hexdigest()
        token = f"{nonce}.{expires}.{signature}"
        with _guard:
            for key in list(_pending):
                if _pending[key].expires <= time.time():
                    del _pending[key]
            if len(_pending) >= _MAX_PENDING:
                raise HTTPException(503, "Trop d'aperçus en attente; réessaie plus tard.")
            _pending[token] = PendingPlan(
                expires=expires,
                binding=binding,
                state_hash=fingerprint(state),
                create=create,
                project_name=plan.project_name,
                operations=operations,
            )
        target = f"nouveau projet « {plan.project_name} »" if create else f"projet courant {payload.projectId}"
        mode = " Mode déterministe sans LLM." if self.settings.llm_provider == "none" else ""
        _log.info("Preview ready operations=%d create=%s", len(operations), create)
        return WebhookResponse(
            message=f"Aperçu: {target}; {len(operations)} opérations. Confirme sous 10 minutes.{mode}",
            requiresConfirmation=True,
            changed=False,
            projectId=payload.projectId,
            confirmationToken=token,
            steps=(
                ([f"Créer un nouveau projet « {plan.project_name} »."] if create else [])
                + [operation.description for operation in operations]
            ),
        )

    async def _execute(self, payload: WebhookRequest, tools: BackendTools, pending: PendingPlan) -> WebhookResponse:
        project_id = payload.projectId
        changed = False
        writing = False
        steps: list[str] = []
        _log.info("Confirmation: revalidating project access and state")
        try:
            state = await read_state(tools, project_id)
        except BackendApiError as exc:
            _log.warning("Confirmation project read rejected status=%d", exc.status_code)
            raise HTTPException(exc.status_code, "Accès au projet refusé lors de la confirmation.") from exc
        except (ValueError, KeyError, TypeError) as exc:
            _log.warning("Confirmation state invalid error_class=%s", type(exc).__name__)
            raise HTTPException(422, "État du projet invalide; génère un nouvel aperçu après vérification.") from exc
        if fingerprint(state) != pending.state_hash:
            raise HTTPException(409, "Le projet a changé depuis l'aperçu. Génère un nouvel aperçu.")
        _log.info("Confirmed execution started operations=%d", len(pending.operations))
        try:
            if pending.create:
                writing = True
                project: dict[str, Any] = await tools.create_project(pending.project_name)
                changed = True
                project_id = str(project["id"])
                steps.append(f"Projet créé: {project_id}")
            for operation in pending.operations:
                writing = True
                await tools._request(
                    operation.method,
                    f"/api/cad/projects/{project_id}{operation.path}",
                    operation.payload,
                )
                changed = True
                steps.append(operation.description)
            writing = False
            await tools.export_retail_layout(project_id)
            _log.info("Confirmed execution completed changed=%s", changed)
            steps.append("Export retail-layout relu; audit métier effectué par le backend appelant.")
            return WebhookResponse(
                message="Plan confirmé exécuté.",
                requiresConfirmation=False,
                changed=changed,
                projectId=project_id,
                steps=steps,
            )
        except (BackendApiError, ValueError, KeyError, TypeError) as exc:
            _log.warning(
                "Confirmed execution interrupted error_class=%s status=%s",
                type(exc).__name__, exc.status_code if isinstance(exc, BackendApiError) else "unavailable",
            )
            uncertain = writing and (not isinstance(exc, BackendApiError) or exc.status_code >= 500)
            steps.append("Exécution interrompue. Les écritures précédentes ne sont pas annulées.")
            steps.append(
                "Résultat de la dernière écriture incertain; vérifie le projet avant tout nouvel essai."
                if uncertain else "Une opération a été refusée; vérifie le projet et la validité de la session."
            )
            return WebhookResponse(
                message="Échec du plan confirmé; aucune relance automatique. Génère un nouvel aperçu après vérification.",
                requiresConfirmation=False,
                changed=changed or uncertain,
                projectId=project_id,
                steps=steps,
            )

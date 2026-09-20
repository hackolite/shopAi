from __future__ import annotations

import logging
import time

from fastapi import Depends, FastAPI, Header, HTTPException

from .agent import ShopAIOrchestrator
from .config import Settings, load_settings
from .schemas import WebhookRequest, WebhookResponse

app = FastAPI(title="ShopAI Orchestrator", version="1.0.0")
_log = logging.getLogger("uvicorn.error.shopai.orchestrator")



def get_settings() -> Settings:
    return load_settings()



@app.get("/")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "shopai-orchestrator"}


@app.post("/webhook/llm", response_model=WebhookResponse, response_model_exclude_none=True)
async def llm_webhook(
    payload: WebhookRequest,
    shopai_session: str | None = Header(default=None, alias="X-ShopAI-Session"),
    settings: Settings = Depends(get_settings),
) -> WebhookResponse:
    started = time.monotonic()
    status_code = 500
    _log.info("LLM webhook started provider=%s confirm=%s", settings.llm_provider, payload.confirm)
    try:
        if not shopai_session or not shopai_session.strip():
            raise HTTPException(401, "Session ShopAI requise.")
        agent = ShopAIOrchestrator(settings)
        result = await agent.run(payload, session_cookie=shopai_session)
        status_code = 200
        return result
    except HTTPException as exc:
        status_code = exc.status_code
        _log.warning("LLM webhook rejected status=%d", status_code)
        raise
    finally:
        _log.info("LLM webhook completed status=%d duration_ms=%.0f", status_code, (time.monotonic() - started) * 1000)

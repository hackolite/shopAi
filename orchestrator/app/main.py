from __future__ import annotations

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .agent import ShopAIOrchestrator
from .config import Settings, load_settings
from .schemas import WebhookRequest, WebhookResponse

app = FastAPI(title="ShopAI Orchestrator", version="1.0.0")



def get_settings() -> Settings:
    return load_settings()



def _verify_webhook_token(authorization: str | None, settings: Settings) -> None:
    expected = settings.webhook_auth_token
    if not expected:
        return
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing webhook token")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or token.strip() != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid webhook token")


@app.get("/")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "shopai-orchestrator"}


@app.post("/webhook/llm", response_model=WebhookResponse, response_model_exclude_none=True)
async def llm_webhook(
    payload: WebhookRequest,
    authorization: str | None = Header(default=None),
    shopai_session: str | None = Header(default=None, alias="X-ShopAI-Session"),
    settings: Settings = Depends(get_settings),
) -> WebhookResponse:
    _verify_webhook_token(authorization, settings)
    agent = ShopAIOrchestrator(settings)
    return await agent.run(payload, session_cookie=shopai_session)

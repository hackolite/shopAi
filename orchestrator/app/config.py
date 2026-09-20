from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal


Provider = Literal["none", "openai", "anthropic", "xai", "openrouter"]


@dataclass(frozen=True)
class Settings:
    backend_base_url: str
    llm_provider: Provider
    openai_api_key: str | None
    anthropic_api_key: str | None
    xai_api_key: str | None
    openrouter_api_key: str | None
    openai_model: str
    anthropic_model: str
    xai_model: str
    openrouter_model: str
    openrouter_http_referer: str | None
    openrouter_app_title: str | None
    request_timeout_seconds: float
    max_retries: int
    collision_max_retries: int
    collision_offset_cm: float
    webhook_auth_token: str | None
    catalog_json_path: str | None



def _read_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default



def _read_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default



def load_settings() -> Settings:
    provider = os.getenv("LLM_PROVIDER", "none").strip().lower() or "none"
    if provider not in {"none", "openai", "anthropic", "xai", "openrouter"}:
        raise ValueError("Unsupported LLM_PROVIDER")

    webhook_auth_token = (
        os.getenv("WEBHOOK_AUTH_TOKEN", "").strip()
        or os.getenv("STUDIO_LLM_WEBHOOK_TOKEN", "").strip()
        or None
    )

    return Settings(
        backend_base_url=os.getenv("BACKEND_BASE_URL", "http://localhost:8000").strip().rstrip("/"),
        llm_provider=provider,
        openai_api_key=os.getenv("OPENAI_API_KEY", "").strip() or None,
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", "").strip() or None,
        xai_api_key=os.getenv("XAI_API_KEY", "").strip() or None,
        openrouter_api_key=os.getenv("OPENROUTER_API_KEY", "").strip() or None,
        openai_model=os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip(),
        anthropic_model=os.getenv("ANTHROPIC_MODEL", "claude-3-5-sonnet-latest").strip(),
        xai_model=os.getenv("XAI_MODEL", "grok-4").strip(),
        openrouter_model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini").strip(),
        openrouter_http_referer=os.getenv("OPENROUTER_HTTP_REFERER", "").strip() or None,
        openrouter_app_title=os.getenv("OPENROUTER_APP_TITLE", "").strip() or None,
        request_timeout_seconds=max(1.0, min(_read_float("REQUEST_TIMEOUT_SECONDS", 30.0), 120.0)),
        max_retries=max(1, min(_read_int("MAX_RETRIES", 3), 8)),
        collision_max_retries=max(1, min(_read_int("COLLISION_MAX_RETRIES", 6), 16)),
        collision_offset_cm=max(1.0, _read_float("COLLISION_OFFSET_CM", 20.0)),
        webhook_auth_token=webhook_auth_token,
        catalog_json_path=os.getenv("CATALOG_JSON_PATH", "").strip() or None,
    )

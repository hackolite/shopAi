from __future__ import annotations

from pydantic import BaseModel, ConfigDict, StrictBool, StringConstraints
from typing_extensions import Annotated


class WebhookRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projectId: str
    prompt: Annotated[
        str,
        StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=2000),
    ]
    confirm: StrictBool = False


class WebhookResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str
    requiresConfirmation: bool
    changed: bool
    projectId: str | None = None
    steps: list[str] = []


class StoreDimensions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    width: float = 3000.0
    depth: float = 2000.0
    height: float = 400.0


class OrchestrationPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: str = "build_complete_store"
    project_name: str = "Magasin IA"
    store: StoreDimensions = StoreDimensions()
    max_products: int = 200

"""Gondola engine — Python counterpart to frontend/src/engine/gondola.ts.

Pydantic models for the boundary-based planogram representation (§2).
Used for backend storage and the adaptation layer (§6).
"""
from __future__ import annotations

from typing import Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


class GondolaSeparator(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    id: str
    position_cm: float
    type: Literal["virtual", "physical"] = "virtual"
    movable: bool = True


class GondolaProductPlacement(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    productId: str
    shelfId: str
    leftSeparatorId: str
    rightSeparatorId: str
    rotation: Literal[0, 90, 180, 270] = 0
    cellId: Optional[str] = None


class GondolaShelf(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    id: str
    height_cm: float
    separators: list[GondolaSeparator] = Field(default_factory=list)


class GondolaData(BaseModel):
    """Gondola — boundary-based planogram internal model (§2).

    shelves[0] = bottom-most shelf, shelves[-1] = top-most shelf.
    height_cm is always fixed (never resized).
    """
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    id: str
    width_cm: float
    height_cm: float
    depth_cm: float = 45.0
    shelves: list[GondolaShelf] = Field(default_factory=list)
    productPlacements: list[GondolaProductPlacement] = Field(default_factory=list)

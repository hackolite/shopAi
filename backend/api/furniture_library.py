from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException

from models.project import FurnitureDefinition

router = APIRouter(prefix="/api/furniture-library", tags=["furniture-library"])

_LIBRARY_PATH = Path(__file__).resolve().parent.parent / "storage" / "furniture_library.json"


def _load_library() -> list[FurnitureDefinition]:
    if not _LIBRARY_PATH.exists():
        raise HTTPException(status_code=500, detail="Furniture library not found")
    with _LIBRARY_PATH.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    return [FurnitureDefinition.model_validate(item) for item in payload.get("furniture", [])]


@router.get("/")
def list_furniture_definitions():
    return {"furniture": [item.model_dump(mode="json") for item in _load_library()]}


@router.get("/{furniture_type}")
def get_furniture_definition(furniture_type: str):
    for item in _load_library():
        if item.type == furniture_type:
            return item.model_dump(mode="json")
    raise HTTPException(status_code=404, detail=f"Furniture type '{furniture_type}' not found")

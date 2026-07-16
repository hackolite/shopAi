from __future__ import annotations

from fastapi import APIRouter, HTTPException, UploadFile, File

from services.planogram_loader import (
    load_json,
    save_json,
    list_projects,
    build_ean_index,
)
from services.voxel_generator import generate_voxels
from services.ean_search import search_ean

import json

router = APIRouter(prefix="/api/projects", tags=["projects"])


# ── List projects ──────────────────────────────────────────────────────────────
@router.get("")
def get_projects():
    return {"projects": list_projects()}


# ── Store metadata ─────────────────────────────────────────────────────────────
@router.get("/{project_id}/store")
def get_store(project_id: str):
    try:
        data = load_json(project_id, "store.json")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if data is None:
        raise HTTPException(404, f"Project '{project_id}' not found")
    return data


# ── Product catalogue ──────────────────────────────────────────────────────────
@router.get("/{project_id}/products")
def get_products(project_id: str):
    try:
        data = load_json(project_id, "products.json")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if data is None:
        raise HTTPException(404, "products.json not found")
    return {"products": data}


# ── Planogram + voxels ─────────────────────────────────────────────────────────
@router.get("/{project_id}/planogram")
def get_planogram(project_id: str):
    try:
        planogram = load_json(project_id, "planogram.json")
        products = load_json(project_id, "products.json") or []
    except ValueError as e:
        raise HTTPException(400, str(e))
    if planogram is None:
        raise HTTPException(404, "planogram.json not found")
    voxels = generate_voxels(planogram, products)
    return {"planogram": planogram, "voxels": voxels}


# ── EAN index ─────────────────────────────────────────────────────────────────
@router.get("/{project_id}/ean-index")
def get_ean_index(project_id: str):
    try:
        data = load_json(project_id, "ean_index.json")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if data is None:
        raise HTTPException(404, "ean_index.json not found")
    return data


# ── EAN search ────────────────────────────────────────────────────────────────
@router.get("/{project_id}/search")
def ean_search(project_id: str, ean: str):
    try:
        result = search_ean(project_id, ean)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if result is None:
        raise HTTPException(404, f"EAN '{ean}' not found in project '{project_id}'")
    return result


# ── Analytics ─────────────────────────────────────────────────────────────────
@router.get("/{project_id}/analytics")
def get_analytics(project_id: str):
    try:
        data = load_json(project_id, "analytics.json")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if data is None:
        raise HTTPException(404, "analytics.json not found")
    return data


@router.get("/{project_id}/analytics/{instance_id}")
def get_instance_analytics(project_id: str, instance_id: str):
    try:
        data = load_json(project_id, "analytics.json") or {}
    except ValueError as e:
        raise HTTPException(400, str(e))
    if instance_id not in data:
        raise HTTPException(404, f"Instance '{instance_id}' not found in analytics")
    return {"instance_id": instance_id, **data[instance_id]}


# ── Import store JSON ─────────────────────────────────────────────────────────
@router.post("/{project_id}/import/store")
async def import_store(project_id: str, file: UploadFile = File(...)):
    content = await file.read()
    try:
        data = json.loads(content)
        save_json(project_id, "store.json", data)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"Invalid JSON: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"message": "store.json imported", "project_id": project_id}


# ── Import planogram JSON ─────────────────────────────────────────────────────
@router.post("/{project_id}/import/planogram")
async def import_planogram(project_id: str, file: UploadFile = File(...)):
    content = await file.read()
    try:
        data = json.loads(content)
        save_json(project_id, "planogram.json", data)
        index = build_ean_index(project_id)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"Invalid JSON: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {
        "message": "planogram.json imported and EAN index rebuilt",
        "project_id": project_id,
        "ean_count": len(index),
    }


# ── Import products JSON ──────────────────────────────────────────────────────
@router.post("/{project_id}/import/products")
async def import_products(project_id: str, file: UploadFile = File(...)):
    content = await file.read()
    try:
        data = json.loads(content)
        save_json(project_id, "products.json", data)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"Invalid JSON: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"message": "products.json imported", "project_id": project_id}

    return {"message": "products.json imported", "project_id": project_id}

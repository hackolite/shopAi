from __future__ import annotations

import base64
import re
import threading
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Body, Form, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel

from models.project import Catalog, FurnitureInstance, Material, Planogram, Product, ProjectSettings, SceneData, Store
from models.gondola import GondolaData
from services.gondola_adapter import gondola_to_legacy_cells, legacy_cells_to_gondola
from services.project_manager import (
    create_project,
    delete_project,
    duplicate_project,
    ensure_project_exists,
    export_project_zip,
    get_project_metadata,
    import_project,
    import_project_from_zip,
    list_cad_projects,
    load_project_file,
    save_project_file,
)

MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB
ALLOWED_IMAGE_TYPES = frozenset({
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"
})

router = APIRouter(prefix="/api/cad/projects", tags=["cad-projects"])

# Per-project mutex: FastAPI runs sync handlers in a thread pool, so concurrent
# POST /planograms requests for the same project must not race on planograms.json.
_project_locks: dict[str, threading.Lock] = {}
_project_locks_guard = threading.Lock()


def _get_project_lock(project_id: str) -> threading.Lock:
    """Return (creating if needed) a per-project threading.Lock."""
    with _project_locks_guard:
        if project_id not in _project_locks:
            _project_locks[project_id] = threading.Lock()
        return _project_locks[project_id]


class CreateProjectPayload(BaseModel):
    name: str


class DuplicateProjectPayload(BaseModel):
    name: str


class ImportProjectPayload(BaseModel):
    name: str
    snapshot: dict[str, Any]


class NamedResourcePayload(BaseModel):
    name: str


def _load_scene(project_id: str) -> SceneData:
    ensure_project_exists(project_id)
    return SceneData.model_validate(load_project_file(project_id, "scene.json") or {
        "store": {
            "id": project_id,
            "name": project_id,
            "position": [0.0, 0.0, 0.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 5000.0, "depth": 3000.0, "height": 400.0},
            "walls": [],
        },
        "furniture": [],
    })


def _save_scene(project_id: str, scene: SceneData) -> None:
    save_project_file(project_id, "scene.json", scene.model_dump(mode="json"))


def _load_catalog(project_id: str) -> Catalog:
    ensure_project_exists(project_id)
    return Catalog.model_validate(load_project_file(project_id, "catalog.json") or {"products": []})


def _save_catalog(project_id: str, catalog: Catalog) -> None:
    save_project_file(project_id, "catalog.json", catalog.model_dump(mode="json"))


def _load_planograms(project_id: str) -> list[Planogram]:
    ensure_project_exists(project_id)
    payload = load_project_file(project_id, "planograms.json") or {"planograms": []}
    return [Planogram.model_validate(item) for item in payload.get("planograms", [])]


def _save_planograms(project_id: str, planograms: list[Planogram]) -> None:
    save_project_file(project_id, "planograms.json", {"planograms": [item.model_dump(mode="json") for item in planograms]})


def _load_materials(project_id: str) -> list[Material]:
    ensure_project_exists(project_id)
    payload = load_project_file(project_id, "materials.json") or {"materials": []}
    return [Material.model_validate(item) for item in payload.get("materials", [])]


def _save_materials(project_id: str, materials: list[Material]) -> None:
    save_project_file(project_id, "materials.json", {"materials": [item.model_dump(mode="json") for item in materials]})


def _load_settings(project_id: str) -> ProjectSettings:
    ensure_project_exists(project_id)
    return ProjectSettings.model_validate(load_project_file(project_id, "settings.json") or ProjectSettings().model_dump(mode="json"))


def _save_settings(project_id: str, settings: ProjectSettings) -> None:
    save_project_file(project_id, "settings.json", settings.model_dump(mode="json"))


def _find_index(items: list[Any], attr: str, value: str) -> int:
    for index, item in enumerate(items):
        if getattr(item, attr) == value:
            return index
    raise HTTPException(status_code=404, detail=f"Resource '{value}' not found")


def _merge_model(model_cls, current: Any, payload: dict[str, Any]) -> Any:
    data = current.model_dump(mode="json")
    data.update(payload)
    return model_cls.model_validate(data)


@router.get("/")
def get_projects() -> dict[str, Any]:
    return {"projects": [{"id": item["id"], "name": item["name"]} for item in list_cad_projects()]}


@router.post("/")
def post_project(payload: CreateProjectPayload):
    project_id = str(uuid4())
    return create_project(project_id, payload.name)


@router.get("/{project_id}")
def get_project(project_id: str):
    return get_project_metadata(project_id)


@router.get("/{project_id}/export")
def export_project_endpoint(project_id: str):
    """Export the project as a ZIP archive containing all JSON files."""
    zip_bytes = export_project_zip(project_id)
    metadata = get_project_metadata(project_id)
    safe_name = re.sub(r"[^\w\-]", "_", metadata.get("name", project_id))
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.zip"'},
    )


@router.delete("/{project_id}")
def remove_project(project_id: str):
    delete_project(project_id)
    return {"deleted": True, "id": project_id}


@router.post("/{project_id}/duplicate")
def duplicate_project_endpoint(project_id: str, payload: DuplicateProjectPayload):
    return duplicate_project(project_id, payload.name)


@router.post("/import")
def import_project_endpoint(payload: ImportProjectPayload):
    return import_project(payload.snapshot, payload.name)


@router.post("/import/zip")
async def import_project_zip_endpoint(
    file: UploadFile = File(...),
    name: str = Form(...),
):
    """Import a project from a ZIP archive (multipart: file + name field)."""
    zip_bytes = await file.read()
    return import_project_from_zip(zip_bytes, name.strip())


@router.get("/{project_id}/scene")
def get_scene(project_id: str):
    return _load_scene(project_id).model_dump(mode="json")


@router.put("/{project_id}/scene/store")
def update_store(project_id: str, payload: dict[str, Any] = Body(...)):
    scene = _load_scene(project_id)
    scene.store = _merge_model(Store, scene.store, payload)
    _save_scene(project_id, scene)
    return scene.store.model_dump(mode="json")


@router.post("/{project_id}/scene/furniture")
def add_furniture(project_id: str, payload: dict[str, Any] = Body(...)):
    scene = _load_scene(project_id)
    data = dict(payload)
    data.setdefault("id", str(uuid4()))
    data.setdefault("childIds", [])
    data.setdefault("faces", {face: None for face in ["front", "back", "left", "right", "top", "bottom"]})
    furniture = FurnitureInstance.model_validate(data)
    if any(item.id == furniture.id for item in scene.furniture):
        raise HTTPException(status_code=409, detail=f"Furniture '{furniture.id}' already exists")
    scene.furniture.append(furniture)
    _save_scene(project_id, scene)
    return furniture.model_dump(mode="json")


@router.put("/{project_id}/scene/furniture/{furniture_id}")
def update_furniture(project_id: str, furniture_id: str, payload: dict[str, Any] = Body(...)):
    scene = _load_scene(project_id)
    index = _find_index(scene.furniture, "id", furniture_id)
    updated = _merge_model(FurnitureInstance, scene.furniture[index], {**payload, "id": furniture_id})
    scene.furniture[index] = updated
    _save_scene(project_id, scene)
    return updated.model_dump(mode="json")


@router.delete("/{project_id}/scene/furniture/{furniture_id}")
def remove_furniture(project_id: str, furniture_id: str):
    scene = _load_scene(project_id)
    index = _find_index(scene.furniture, "id", furniture_id)
    planograms = _load_planograms(project_id)
    remaining_planograms = [planogram for planogram in planograms if planogram.furnitureId != furniture_id]
    scene.furniture.pop(index)
    _save_scene(project_id, scene)
    _save_planograms(project_id, remaining_planograms)
    return {"deleted": True, "id": furniture_id}


@router.get("/{project_id}/catalog")
def get_catalog(project_id: str):
    return _load_catalog(project_id).model_dump(mode="json")


@router.post("/{project_id}/catalog/products")
def add_product(project_id: str, payload: dict[str, Any] = Body(...)):
    catalog = _load_catalog(project_id)
    product = Product.model_validate(payload)
    if any(item.ean == product.ean for item in catalog.products):
        raise HTTPException(status_code=409, detail=f"Product '{product.ean}' already exists")
    catalog.products.append(product)
    _save_catalog(project_id, catalog)
    return product.model_dump(mode="json")


@router.put("/{project_id}/catalog/products/{ean}")
def update_product(project_id: str, ean: str, payload: dict[str, Any] = Body(...)):
    catalog = _load_catalog(project_id)
    index = _find_index(catalog.products, "ean", ean)
    updated = _merge_model(Product, catalog.products[index], {**payload, "ean": ean})
    catalog.products[index] = updated
    _save_catalog(project_id, catalog)
    return updated.model_dump(mode="json")


@router.delete("/{project_id}/catalog/products/{ean}")
def remove_product(project_id: str, ean: str):
    catalog = _load_catalog(project_id)
    index = _find_index(catalog.products, "ean", ean)
    catalog.products.pop(index)
    _save_catalog(project_id, catalog)

    planograms = _load_planograms(project_id)
    updated_planograms = []
    for planogram in planograms:
        updated_planograms.append(Planogram.model_validate({
            **planogram.model_dump(mode="json"),
            "cells": [cell.model_dump(mode="json") for cell in planogram.cells if cell.ean != ean],
        }))
    _save_planograms(project_id, updated_planograms)
    return {"deleted": True, "ean": ean}


@router.post("/{project_id}/catalog/products/{ean}/image")
async def upload_product_image(project_id: str, ean: str, file: UploadFile = File(...)):
    """Accept an image upload and store it as a base64 data-URL in the product's imageUrl field."""
    content_type = file.content_type or "image/png"
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported image type: {content_type}")
    contents = await file.read()
    if len(contents) > MAX_IMAGE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail=f"Image too large (max {MAX_IMAGE_SIZE_BYTES // (1024 * 1024)} MB)")
    b64 = base64.b64encode(contents).decode("ascii")
    data_url = f"data:{content_type};base64,{b64}"
    catalog = _load_catalog(project_id)
    index = _find_index(catalog.products, "ean", ean)
    catalog.products[index] = catalog.products[index].model_copy(update={"imageUrl": data_url})
    _save_catalog(project_id, catalog)
    return {"ean": ean, "imageUrl": data_url}


@router.get("/{project_id}/catalog/search")
def search_catalog(project_id: str, q: str):
    query = q.strip().lower()
    products = _load_catalog(project_id).products
    if not query:
        return {"products": [product.model_dump(mode="json") for product in products]}
    matched = [
        product.model_dump(mode="json")
        for product in products
        if query in product.name.lower()
        or query in product.brand.lower()
        or query in product.category.lower()
        or query in product.ean.lower()
    ]
    return {"products": matched}


@router.get("/{project_id}/planograms")
def list_planograms_endpoint(project_id: str):
    return {
        "planograms": [
            {
                "id": planogram.id,
                "name": planogram.name,
                "furnitureId": planogram.furnitureId,
                "face": planogram.face.value,
                "rows": planogram.rows,
                "cols": planogram.cols,
                "cellCount": len(planogram.cells),
                "widthCm": planogram.widthCm,
                "heightCm": planogram.heightCm,
            }
            for planogram in _load_planograms(project_id)
        ]
    }


@router.post("/{project_id}/planograms")
def add_planogram(project_id: str, payload: dict[str, Any] = Body(...)):
    # Validate and build the planogram object before acquiring the lock so that
    # invalid payloads fail fast without blocking other requests.
    data = dict(payload)
    data.setdefault("id", str(uuid4()))
    data["cells"] = [
        {**cell, "id": cell.get("id", str(uuid4()))}
        for cell in data.get("cells", [])
    ]
    planogram = Planogram.model_validate(data)

    # Hold a per-project lock for the read-modify-write on planograms.json and
    # scene.json.  FastAPI executes synchronous route handlers in a thread pool,
    # so without this lock, concurrent POST /planograms requests for the same
    # project can read the same stale planograms list, both append their
    # planogram, and the last writer silently discards the first one.
    with _get_project_lock(project_id):
        scene = _load_scene(project_id)
        planograms = _load_planograms(project_id)
        if any(item.id == planogram.id for item in planograms):
            raise HTTPException(status_code=409, detail=f"Planogram '{planogram.id}' already exists")
        planograms.append(planogram)
        furniture_index = _find_index(scene.furniture, "id", planogram.furnitureId)
        scene.furniture[furniture_index].faces[planogram.face.value] = planogram.id
        _save_planograms(project_id, planograms)
        _save_scene(project_id, scene)
    return planogram.model_dump(mode="json")


@router.get("/{project_id}/planograms/{planogram_id}")
def get_planogram(project_id: str, planogram_id: str):
    planograms = _load_planograms(project_id)
    index = _find_index(planograms, "id", planogram_id)
    planogram = planograms[index]
    # §6: if gondola is the source of truth, derive legacy cells before returning
    if planogram.gondola:
        try:
            gondola = GondolaData.model_validate(planogram.gondola)
            planogram = gondola_to_legacy_cells(gondola, planogram)
        except Exception:
            pass  # fall back to stored cells if parsing fails
    return planogram.model_dump(mode="json")


@router.put("/{project_id}/planograms/{planogram_id}")
def update_planogram(project_id: str, planogram_id: str, payload: dict[str, Any] = Body(...)):
    scene = _load_scene(project_id)
    planograms = _load_planograms(project_id)
    index = _find_index(planograms, "id", planogram_id)
    data = dict(payload)
    if "cells" in data:
        data["cells"] = [{**cell, "id": cell.get("id", str(uuid4()))} for cell in data["cells"]]
    updated = _merge_model(Planogram, planograms[index], {**data, "id": planogram_id})

    original = planograms[index]
    if original.furnitureId != updated.furnitureId or original.face != updated.face:
        for furniture in scene.furniture:
            for face, linked_planogram_id in furniture.faces.items():
                if linked_planogram_id == planogram_id:
                    furniture.faces[face] = None
        furniture_index = _find_index(scene.furniture, "id", updated.furnitureId)
        scene.furniture[furniture_index].faces[updated.face.value] = updated.id
        _save_scene(project_id, scene)

    planograms[index] = updated
    _save_planograms(project_id, planograms)
    return updated.model_dump(mode="json")


@router.delete("/{project_id}/planograms/{planogram_id}")
def remove_planogram(project_id: str, planogram_id: str):
    scene = _load_scene(project_id)
    planograms = _load_planograms(project_id)
    index = _find_index(planograms, "id", planogram_id)
    planograms.pop(index)
    for furniture in scene.furniture:
        for face, linked_planogram_id in furniture.faces.items():
            if linked_planogram_id == planogram_id:
                furniture.faces[face] = None
    _save_planograms(project_id, planograms)
    _save_scene(project_id, scene)
    return {"deleted": True, "id": planogram_id}


@router.get("/{project_id}/materials")
def get_materials(project_id: str):
    return {"materials": [item.model_dump(mode="json") for item in _load_materials(project_id)]}


@router.post("/{project_id}/materials")
def add_material(project_id: str, payload: dict[str, Any] = Body(...)):
    materials = _load_materials(project_id)
    data = dict(payload)
    data.setdefault("id", str(uuid4()))
    material = Material.model_validate(data)
    if any(item.id == material.id for item in materials):
        raise HTTPException(status_code=409, detail=f"Material '{material.id}' already exists")
    materials.append(material)
    _save_materials(project_id, materials)
    return material.model_dump(mode="json")


@router.put("/{project_id}/materials/{material_id}")
def update_material(project_id: str, material_id: str, payload: dict[str, Any] = Body(...)):
    materials = _load_materials(project_id)
    index = _find_index(materials, "id", material_id)
    updated = _merge_model(Material, materials[index], {**payload, "id": material_id})
    materials[index] = updated
    _save_materials(project_id, materials)
    return updated.model_dump(mode="json")


@router.delete("/{project_id}/materials/{material_id}")
def remove_material(project_id: str, material_id: str):
    materials = _load_materials(project_id)
    index = _find_index(materials, "id", material_id)
    materials.pop(index)
    _save_materials(project_id, materials)
    return {"deleted": True, "id": material_id}


@router.get("/{project_id}/settings")
def get_settings(project_id: str):
    return _load_settings(project_id).model_dump(mode="json")


@router.put("/{project_id}/settings")
def update_settings(project_id: str, payload: dict[str, Any] = Body(...)):
    settings = _merge_model(ProjectSettings, _load_settings(project_id), payload)
    _save_settings(project_id, settings)
    return settings.model_dump(mode="json")

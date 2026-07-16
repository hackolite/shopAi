from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from models.project import ProjectSettings

STORAGE_ROOT = Path(__file__).resolve().parent.parent / "storage" / "projects"
_ALLOWED_FILENAMES = frozenset({
    "project.json",
    "scene.json",
    "catalog.json",
    "planograms.json",
    "materials.json",
    "settings.json",
    "textures.json",
})
_SAFE_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_project_id(project_id: str) -> None:
    if not _SAFE_PROJECT_ID_RE.fullmatch(project_id):
        raise HTTPException(status_code=400, detail="Invalid project_id")


def _validate_filename(filename: str) -> None:
    if filename not in _ALLOWED_FILENAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported file: {filename}")


def _ensure_storage_root() -> None:
    STORAGE_ROOT.mkdir(parents=True, exist_ok=True)


def _find_existing_project(project_id: str) -> Path | None:
    _validate_project_id(project_id)
    if not STORAGE_ROOT.exists():
        return None
    for entry in STORAGE_ROOT.iterdir():
        if entry.is_dir() and entry.name == project_id and (entry / "project.json").exists():
            return entry
    return None


def _normalize_data(data: Any) -> Any:
    if hasattr(data, "model_dump"):
        return data.model_dump(mode="json")
    return data


def _read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path: Path, data: Any) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(_normalize_data(data), handle, indent=2, ensure_ascii=False)


def _touch_project_metadata(project_id: str) -> None:
    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        return
    metadata_path = project_dir / "project.json"
    if not metadata_path.exists():
        return
    metadata = _read_json(metadata_path)
    metadata["updatedAt"] = _utc_now()
    _write_json(metadata_path, metadata)


def load_project_file(project_id: str, filename: str) -> Any:
    _validate_filename(filename)
    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        return None
    file_path = project_dir / filename
    if not file_path.exists():
        return None
    return _read_json(file_path)


def save_project_file(project_id: str, filename: str, data: Any) -> None:
    _validate_filename(filename)
    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    _write_json(project_dir / filename, data)
    if filename != "project.json":
        _touch_project_metadata(project_id)


def list_cad_projects() -> list[dict[str, Any]]:
    if not STORAGE_ROOT.exists():
        return []
    projects: list[dict[str, Any]] = []
    for entry in STORAGE_ROOT.iterdir():
        if not entry.is_dir():
            continue
        metadata_path = entry / "project.json"
        if not metadata_path.exists():
            continue
        try:
            metadata = _read_json(metadata_path)
        except json.JSONDecodeError:
            continue
        projects.append({
            "id": metadata.get("id", entry.name),
            "name": metadata.get("name", entry.name),
            "createdAt": metadata.get("createdAt"),
            "updatedAt": metadata.get("updatedAt"),
        })
    projects.sort(key=lambda item: item["name"].lower())
    return projects


def get_project_metadata(project_id: str) -> dict[str, Any]:
    ensure_project_exists(project_id)
    metadata = load_project_file(project_id, "project.json")
    if metadata is None:
        raise HTTPException(status_code=404, detail=f"Metadata for project '{project_id}' not found")
    return metadata


def create_project(id: str, name: str) -> dict[str, Any]:
    _validate_project_id(id)
    _ensure_storage_root()
    project_dir = STORAGE_ROOT / id
    resolved_root = STORAGE_ROOT.resolve()
    resolved_dir = project_dir.resolve()
    if resolved_dir.parent != resolved_root:
        raise HTTPException(status_code=400, detail="Invalid project path")
    if project_dir.exists():
        raise HTTPException(status_code=409, detail=f"Project '{id}' already exists")

    project_dir.mkdir(parents=False, exist_ok=False)
    timestamp = _utc_now()
    metadata = {"id": id, "name": name, "createdAt": timestamp, "updatedAt": timestamp}
    defaults = {
        "project.json": metadata,
        "scene.json": {
            "store": {
                "id": str(uuid4()),
                "name": name,
                "position": [0.0, 0.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": 5000.0, "depth": 3000.0, "height": 400.0},
                "walls": [],
            },
            "furniture": [],
        },
        "catalog.json": {"products": []},
        "planograms.json": {"planograms": []},
        "materials.json": {"materials": []},
        "settings.json": ProjectSettings().model_dump(mode="json"),
        "textures.json": {"textures": []},
    }
    for filename, payload in defaults.items():
        _write_json(project_dir / filename, payload)
    return metadata


def ensure_project_exists(project_id: str) -> None:
    if _find_existing_project(project_id) is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")


def delete_project(project_id: str) -> None:
    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    shutil.rmtree(project_dir)

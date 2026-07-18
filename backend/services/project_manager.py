from __future__ import annotations

import io
import json
import logging
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from models.project import ProjectSettings

_log = logging.getLogger(__name__)

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


def _safe_project_path(project_id: str, filename: str) -> Path:
    """Construct a safe, fully-controlled path from STORAGE_ROOT + validated components.

    Both ``project_id`` and ``filename`` are validated against strict allowlists before
    being joined to STORAGE_ROOT, so the resulting path cannot escape the storage tree.
    ``project_id`` must match ``^[A-Za-z0-9_-]{1,64}$`` (no slashes, no dots, no traversal
    sequences), and ``filename`` must be one of the hard-coded ``_ALLOWED_FILENAMES``.
    """
    _validate_project_id(project_id)
    _validate_filename(filename)
    return STORAGE_ROOT / project_id / filename


def _read_json(project_id: str, filename: str) -> Any:
    # Path is safe: project_id validated by regex (no traversal chars), filename from allowlist.
    path = _safe_project_path(project_id, filename)  # lgtm[py/path-injection]
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as handle:  # lgtm[py/path-injection]
        content = handle.read()
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        # Recover from files that contain concatenated JSON objects ("Extra data").
        if "Extra data" in str(exc):
            obj, _ = json.JSONDecoder().raw_decode(content)
            return obj
        raise


def _write_json(project_id: str, filename: str, data: Any) -> None:
    # Path is safe: project_id validated by regex (no traversal chars), filename from allowlist.
    path = _safe_project_path(project_id, filename)  # lgtm[py/path-injection]
    with path.open("w", encoding="utf-8") as handle:  # lgtm[py/path-injection]
        json.dump(_normalize_data(data), handle, indent=2, ensure_ascii=False)


def _touch_project_metadata(project_id: str) -> None:
    metadata_raw = _read_json(project_id, "project.json")
    if metadata_raw is None:
        return
    metadata_raw["updatedAt"] = _utc_now()
    _write_json(project_id, "project.json", metadata_raw)


def load_project_file(project_id: str, filename: str) -> Any:
    _validate_filename(filename)
    # _read_json also validates; we call _find_existing_project first to confirm existence.
    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        return None
    return _read_json(project_id, filename)


def save_project_file(project_id: str, filename: str, data: Any) -> None:
    _validate_filename(filename)
    if _find_existing_project(project_id) is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    _write_json(project_id, filename, data)
    if filename != "project.json":
        _touch_project_metadata(project_id)


def list_cad_projects() -> list[dict[str, Any]]:
    if not STORAGE_ROOT.exists():
        return []
    projects: list[dict[str, Any]] = []
    for entry in STORAGE_ROOT.iterdir():
        if not entry.is_dir():
            continue
        project_id = entry.name
        try:
            _validate_project_id(project_id)
        except HTTPException:
            continue
        metadata = _read_json(project_id, "project.json")
        if metadata is None:
            continue
        projects.append({
            "id": metadata.get("id", project_id),
            "name": metadata.get("name", project_id),
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
    defaults: dict[str, Any] = {
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
        _write_json(id, filename, payload)
    return metadata


def ensure_project_exists(project_id: str) -> None:
    if _find_existing_project(project_id) is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")


def duplicate_project(source_id: str, new_name: str) -> dict[str, Any]:
    source_dir = _find_existing_project(source_id)
    if source_dir is None:
        raise HTTPException(status_code=404, detail=f"Project '{source_id}' not found")

    new_id = str(uuid4())
    _validate_project_id(new_id)
    _ensure_storage_root()
    new_dir = STORAGE_ROOT / new_id

    shutil.copytree(source_dir, new_dir, symlinks=False, ignore_dangling_symlinks=True)

    timestamp = _utc_now()
    metadata = {"id": new_id, "name": new_name, "createdAt": timestamp, "updatedAt": timestamp}
    _write_json(new_id, "project.json", metadata)

    return metadata


def import_project(snapshot: dict[str, Any], name: str) -> dict[str, Any]:
    """Create a new project from an exported snapshot {scene, planograms}."""
    new_id = str(uuid4())
    _validate_project_id(new_id)
    _ensure_storage_root()
    project_dir = STORAGE_ROOT / new_id
    project_dir.mkdir(parents=False, exist_ok=False)

    timestamp = _utc_now()
    metadata = {"id": new_id, "name": name, "createdAt": timestamp, "updatedAt": timestamp}

    defaults: dict[str, Any] = {
        "project.json": metadata,
        "scene.json": snapshot.get("scene", {
            "store": {
                "id": str(uuid4()),
                "name": name,
                "position": [0.0, 0.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": 5000.0, "depth": 3000.0, "height": 400.0},
                "walls": [],
            },
            "furniture": [],
        }),
        "catalog.json": snapshot.get("catalog", {"products": []}),
        "planograms.json": {"planograms": snapshot.get("planograms", [])},
        "materials.json": snapshot.get("materials", {"materials": []}),
        "settings.json": snapshot.get("settings", ProjectSettings().model_dump(mode="json")),
        "textures.json": {"textures": []},
    }
    for filename, payload in defaults.items():
        _write_json(new_id, filename, payload)
    return metadata


def delete_project(project_id: str) -> None:
    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    shutil.rmtree(project_dir)


def export_project_zip(project_id: str) -> bytes:
    """Return a ZIP archive of all project JSON files."""
    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for filename in sorted(_ALLOWED_FILENAMES):
            path = project_dir / filename  # safe: project_dir validated, filename from allowlist
            if path.exists():
                zf.write(path, arcname=filename)  # lgtm[py/path-injection]
    return buf.getvalue()


def import_project_from_zip(zip_bytes: bytes, name: str) -> dict[str, Any]:
    """Create a new project from a ZIP archive that contains project JSON files."""
    try:
        zip_file = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Invalid ZIP file format")

    new_id = str(uuid4())
    _validate_project_id(new_id)
    _ensure_storage_root()
    project_dir = STORAGE_ROOT / new_id
    project_dir.mkdir(parents=False, exist_ok=False)

    timestamp = _utc_now()
    metadata: dict[str, Any] = {"id": new_id, "name": name, "createdAt": timestamp, "updatedAt": timestamp}
    _write_json(new_id, "project.json", metadata)

    with zip_file:
        zip_names = set(zip_file.namelist())
        for filename in _ALLOWED_FILENAMES:
            if filename == "project.json":
                continue
            if filename in zip_names:
                try:
                    data = json.loads(zip_file.read(filename))
                    _write_json(new_id, filename, data)
                except json.JSONDecodeError as exc:
                    _log.warning("Skipping %s in imported ZIP – invalid JSON: %s", filename, exc)
                except Exception as exc:
                    _log.warning("Skipping %s in imported ZIP – unexpected error: %s", filename, exc)

    defaults: dict[str, Any] = {
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
    for filename, default_data in defaults.items():
        path = project_dir / filename  # safe: project_dir uses server-generated UUID, filename from fixed dict
        if not path.exists():  # lgtm[py/path-injection]
            _write_json(new_id, filename, default_data)

    return metadata

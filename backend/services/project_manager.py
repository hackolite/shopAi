from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError

from models.project import CADBaseModel, Planogram, ProjectSettings, SceneData
from services.reference_templates import REFERENCE_PROJECT_IDS

_log = logging.getLogger(__name__)

STORAGE_ROOT = Path(__file__).resolve().parent.parent / "storage" / "projects"
_DEFAULT_CATALOG_PATH = Path(__file__).resolve().parent.parent / "storage" / "default_catalog.json"
_ALLOWED_FILENAMES = frozenset({
    "project.json",
    "scene.json",
    "catalog.json",
    "planograms.json",
    "materials.json",
    "settings.json",
    "textures.json",
    "pedestrians.json",
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
    """Select an existing storage directory and an allowlisted filename for writing."""
    _validate_project_id(project_id)
    _validate_filename(filename)
    root = STORAGE_ROOT.resolve()
    for directory in STORAGE_ROOT.iterdir():
        if directory.name != project_id or not directory.is_dir():
            continue
        resolved = directory.resolve()
        if directory.is_symlink() or resolved.parent != root:
            raise HTTPException(status_code=400, detail="Invalid project path")
        # Use filesystem entries and literal allowlist values, not request paths.
        for allowed_filename in _ALLOWED_FILENAMES:
            if allowed_filename == filename:
                return resolved / allowed_filename
    raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")


def _json_error_location(exc: json.JSONDecodeError) -> str:
    return f"line={exc.lineno} column={exc.colno} pos={exc.pos}"


def _read_json(project_id: str, filename: str) -> Any:
    _validate_filename(filename)
    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        return None
    path = project_dir / filename
    if not path.exists():
        return None
    try:
        with path.open(encoding="utf-8-sig") as handle:
            content = handle.read()
    except (OSError, UnicodeDecodeError) as exc:
        _log.warning("Failed to read %s/%s (%s): %s", project_id, filename, path, exc)
        return None
    if not content.strip():
        _log.debug("Empty JSON file in %s/%s (%s)", project_id, filename, path)
        return None
    try:
        parsed = json.loads(content)
        if filename == "project.json" and not isinstance(parsed, dict):
            _log.warning("Invalid metadata type in %s/%s: expected object", project_id, filename)
            return None
        return parsed
    except json.JSONDecodeError as exc:
        # Recover from files that contain concatenated JSON objects ("Extra data").
        if "Extra data" in str(exc):
            try:
                stripped = content.lstrip()
                obj, end = json.JSONDecoder().raw_decode(stripped)
                suffix = stripped[end:].lstrip()
                if not suffix:
                    if filename == "project.json" and not isinstance(obj, dict):
                        _log.warning("Invalid metadata type in %s/%s: expected object", project_id, filename)
                        return None
                    return obj
                try:
                    json.loads(suffix)
                except json.JSONDecodeError:
                    _log.warning(
                        "Invalid concatenated JSON suffix in %s/%s (%s): suffix_len=%d",
                        project_id,
                        filename,
                        path,
                        len(suffix),
                    )
                    return None
                if filename == "project.json" and not isinstance(obj, dict):
                    _log.warning("Invalid metadata type in %s/%s: expected object", project_id, filename)
                    return None
                return obj
            except json.JSONDecodeError as fallback_exc:
                _log.warning(
                    "Invalid concatenated JSON in %s/%s (%s): %s (%s, content_len=%d)",
                    project_id,
                    filename,
                    path,
                    fallback_exc,
                    _json_error_location(fallback_exc),
                    len(content),
                )
                return None
        _log.warning(
            "Invalid JSON in %s/%s (%s): %s (%s, content_len=%d)",
            project_id,
            filename,
            path,
            exc,
            _json_error_location(exc),
            len(content),
        )
        return None


def _write_json(project_id: str, filename: str, data: Any) -> None:
    path = _safe_project_path(project_id, filename)
    content = json.dumps(_normalize_data(data), indent=2, ensure_ascii=False, allow_nan=False)
    temporary_path: Path | None = None
    try:
        # Replace only a complete file; close it first for Windows compatibility.
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


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
        # Legacy template symlinks can be checked out as plain text on Windows.
        # Templates are not tenant projects and are loaded from storage/templates.
        if project_id in REFERENCE_PROJECT_IDS:
            continue
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


def _load_default_catalog() -> dict[str, Any]:
    """Return the 200-product default catalog, or an empty catalog as fallback."""
    if _DEFAULT_CATALOG_PATH.exists():
        try:
            with _DEFAULT_CATALOG_PATH.open(encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            _log.warning("Failed to load default catalog from %s", _DEFAULT_CATALOG_PATH)
    return {"products": []}


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
        "catalog.json": _load_default_catalog(),
        "planograms.json": {"planograms": []},
        "materials.json": {"materials": []},
        "settings.json": ProjectSettings().model_dump(mode="json"),
        "textures.json": {"textures": []},
    }
    for filename, payload in defaults.items():
        _write_json(id, filename, payload)
    return metadata


def _default_scene_payload(name: str) -> dict[str, Any]:
    return {
        "store": {
            "id": str(uuid4()),
            "name": name,
            "position": [0.0, 0.0, 0.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 5000.0, "depth": 3000.0, "height": 400.0},
            "walls": [],
        },
        "furniture": [],
    }


def normalize_scene_snapshot(scene: Any, name: str) -> dict[str, Any]:
    base = _default_scene_payload(name)
    if not isinstance(scene, dict):
        scene = {}
    store_raw = scene.get("store")
    if isinstance(store_raw, dict):
        merged_store = dict(base["store"])
        merged_store.update(store_raw)
    else:
        merged_store = dict(base["store"])
    normalized_scene = dict(base)
    normalized_scene.update(scene)
    normalized_scene["store"] = merged_store
    normalized_scene["furniture"] = scene.get("furniture", [])
    return SceneData.model_validate(normalized_scene).model_dump()


def _canonicalize_scene_aliases(scene: Any) -> Any:
    if not isinstance(scene, dict):
        return scene
    canonical = json.loads(json.dumps(scene))
    store = canonical.get("store")
    if isinstance(store, dict) and isinstance(store.get("dimensions"), dict):
        store["dimensions"] = CADBaseModel._validate_dimensions(store["dimensions"])
    for item in canonical.get("furniture", []) or []:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("dimensions"), dict):
            item["dimensions"] = CADBaseModel._validate_dimensions(item["dimensions"])
        if isinstance(item.get("faces"), dict):
            faces: dict[str, Any] = {}
            for face_name, planogram_id in item["faces"].items():
                canonical_face = CADBaseModel._normalize_face_name(face_name)
                if canonical_face in faces and faces[canonical_face] != planogram_id:
                    raise ValueError(f"Duplicate furniture face alias for {canonical_face}")
                faces[canonical_face] = planogram_id
            item["faces"] = faces
    return canonical


def _canonicalize_planogram_aliases(planograms: Any) -> Any:
    if not isinstance(planograms, list):
        return planograms
    canonical = json.loads(json.dumps(planograms))
    for item in canonical:
        if isinstance(item, dict) and "face" in item:
            item["face"] = CADBaseModel._normalize_face_name(item["face"])
    return canonical


def _project_validated_shape(validated: Any, template: Any) -> Any:
    if isinstance(validated, dict) and isinstance(template, dict):
        return {
            key: _project_validated_shape(validated.get(key), value)
            for key, value in template.items()
            if key in validated
        }
    if isinstance(validated, list) and isinstance(template, list) and len(validated) == len(template):
        return [_project_validated_shape(valid_item, template_item) for valid_item, template_item in zip(validated, template)]
    return validated


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

    scene_snapshot = snapshot.get("scene", _default_scene_payload(name))
    planogram_snapshot = snapshot.get("planograms", [])
    scene_snapshot = _canonicalize_scene_aliases(scene_snapshot)
    try:
        validated_scene = SceneData.model_validate(scene_snapshot).model_dump(mode="json")
        scene_snapshot = _project_validated_shape(validated_scene, scene_snapshot)
    except (TypeError, ValidationError) as exc:
        try:
            scene_snapshot = normalize_scene_snapshot(scene_snapshot, name)
        except (TypeError, ValidationError) as normalized_exc:
            raise HTTPException(status_code=422, detail=f"Invalid project snapshot: {normalized_exc}") from normalized_exc
    try:
        planogram_snapshot = _canonicalize_planogram_aliases(planogram_snapshot)
        validated_planograms = [Planogram.model_validate(item) for item in planogram_snapshot]
        if not all(isinstance(item, dict) for item in planogram_snapshot):
            planogram_snapshot = [
                item.model_dump(mode="json", exclude_none=True)
                for item in validated_planograms
            ]
    except (TypeError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid project snapshot: {exc}") from exc

    defaults: dict[str, Any] = {
        "project.json": metadata,
        "scene.json": scene_snapshot,
        "catalog.json": snapshot.get("catalog", {"products": []}),
        "planograms.json": {"planograms": planogram_snapshot},
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

    metadata = load_project_file(project_id, "project.json") or {"id": project_id, "name": project_id}
    scene_raw = load_project_file(project_id, "scene.json") or {"store": {}, "furniture": []}
    planograms_raw = load_project_file(project_id, "planograms.json") or {"planograms": []}

    from services.retail_layout import build_retail_layout

    retail_layout = build_retail_layout(
        project_id=project_id,
        scene=scene_raw,
        planograms=planograms_raw.get("planograms", []),
        metadata=metadata,
    )
    retail_layout["exportedAt"] = metadata.get("updatedAt") or metadata.get("createdAt") or retail_layout.get("exportedAt")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for filename in sorted(_ALLOWED_FILENAMES):
            path = project_dir / filename  # safe: project_dir validated, filename from allowlist
            if path.exists():
                zf.write(path, arcname=filename)  # lgtm[py/path-injection]
        info = zipfile.ZipInfo("retail-layout.json")
        info.compress_type = zipfile.ZIP_DEFLATED
        info.date_time = (1980, 1, 1, 0, 0, 0)
        zf.writestr(info, json.dumps(retail_layout, indent=2, ensure_ascii=False))
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

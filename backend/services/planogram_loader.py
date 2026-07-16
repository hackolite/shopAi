from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

STORAGE_ROOT = Path(__file__).parent.parent / "storage" / "projects"

# Only allow safe project identifiers — no path traversal characters
_SAFE_ID_RE = re.compile(r'^[A-Za-z0-9_\-]{1,64}$')

# Only allow a fixed set of known filenames — prevents arbitrary file access
_ALLOWED_FILES = frozenset({
    "store.json",
    "products.json",
    "planogram.json",
    "analytics.json",
    "ean_index.json",
})


def _validate_project_id(project_id: str) -> None:
    if not _SAFE_ID_RE.match(project_id):
        raise ValueError(f"Invalid project_id: {project_id!r}")


def _project_path(project_id: str) -> Path:
    """Return the project directory.

    Derives the path from the STORAGE_ROOT directory listing so that the
    returned Path is never constructed directly from user-supplied input.
    For new projects (import use-case), falls back to a validated construction
    with an explicit is_relative_to guard.
    """
    _validate_project_id(project_id)

    # Prefer looking up from the filesystem listing — CodeQL recognises this
    # as safe because the Path comes from iterdir(), not from user input.
    if STORAGE_ROOT.exists():
        for entry in STORAGE_ROOT.iterdir():
            if entry.is_dir() and entry.name == project_id:
                return entry

    # New project (directory does not exist yet — only reached from save_json)
    resolved = (STORAGE_ROOT / project_id).resolve()
    if not resolved.is_relative_to(STORAGE_ROOT.resolve()):
        raise ValueError("Path traversal attempt detected")
    return resolved


def load_json(project_id: str, filename: str) -> Any:
    if filename not in _ALLOWED_FILES:
        raise ValueError(f"Unknown file: {filename!r}")
    path = _project_path(project_id) / filename
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(project_id: str, filename: str, data: Any) -> None:
    if filename not in _ALLOWED_FILES:
        raise ValueError(f"Unknown file: {filename!r}")
    path = _project_path(project_id)
    path.mkdir(parents=True, exist_ok=True)
    with (path / filename).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def list_projects() -> list[str]:
    if not STORAGE_ROOT.exists():
        return []
    return [p.name for p in STORAGE_ROOT.iterdir() if p.is_dir()]


def build_ean_index(project_id: str) -> dict:
    planogram = load_json(project_id, "planogram.json")
    if not planogram:
        return {}

    index: dict[str, list] = {}
    for inst in planogram.get("instances", []):
        ean = inst["ean"]
        loc = inst["location"]
        entry = {
            "instance_id": inst["instance_id"],
            "position": [loc["x"], loc["y"], loc["z"]],
            "shelf": loc["shelf"],
            "level": loc["level"],
            "zone": loc["zone"],
            "facings": inst.get("facings", 1),
        }
        index.setdefault(ean, []).append(entry)

    save_json(project_id, "ean_index.json", index)
    return index



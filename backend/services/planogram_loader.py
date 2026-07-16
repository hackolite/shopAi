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
    "project.json",
    "scene.json",
    "catalog.json",
    "planograms.json",
    "materials.json",
    "settings.json",
    "textures.json",
})


def _validate_project_id(project_id: str) -> None:
    if not _SAFE_ID_RE.match(project_id):
        raise ValueError(f"Invalid project_id: {project_id!r}")


def _find_existing_project(project_id: str) -> Path | None:
    """Return the Path for an existing project directory.

    Derives the path entirely from the filesystem listing so that no
    user-provided string is directly concatenated with a path.
    Returns None when the project does not exist.
    """
    _validate_project_id(project_id)
    if not STORAGE_ROOT.exists():
        return None
    for entry in STORAGE_ROOT.iterdir():
        if entry.is_dir() and entry.name == project_id:
            return entry
    return None


def load_json(project_id: str, filename: str) -> Any:
    """Load a JSON file from a project directory using a filesystem-derived path."""
    if filename not in _ALLOWED_FILES:
        raise ValueError(f"Unknown file: {filename!r}")
    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        return None
    # project_dir came from iterdir() — not constructed from user input
    file_path = project_dir / filename
    if not file_path.exists():
        return None
    with file_path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(project_id: str, filename: str, data: Any) -> None:
    """Persist data as JSON into an existing project directory.

    The project directory must already exist on disk.  Creating new project
    directories is an admin-level operation (done by placing the project
    folder under storage/projects/) and is intentionally not exposed through
    this function to keep all path operations filesystem-derived rather than
    user-input-derived.
    """
    if filename not in _ALLOWED_FILES:
        raise ValueError(f"Unknown file: {filename!r}")

    project_dir = _find_existing_project(project_id)
    if project_dir is None:
        raise ValueError(
            f"Project '{project_id}' does not exist.  "
            "Create the project directory under storage/projects/ first."
        )

    # project_dir is from iterdir() — not constructed from user input
    with (project_dir / filename).open("w", encoding="utf-8") as f:
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



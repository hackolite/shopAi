from __future__ import annotations

import json
from pathlib import Path
from typing import Any

STORAGE_ROOT = Path(__file__).parent.parent / "storage" / "projects"


def _project_path(project_id: str) -> Path:
    return STORAGE_ROOT / project_id


def load_json(project_id: str, filename: str) -> Any:
    path = _project_path(project_id) / filename
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(project_id: str, filename: str, data: Any) -> None:
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

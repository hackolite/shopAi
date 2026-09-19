from __future__ import annotations

import json

import services.project_manager as pm


def test_list_cad_projects_skips_invalid_project_json(tmp_path) -> None:
    storage_root = tmp_path / "projects"
    storage_root.mkdir(parents=True)

    valid_dir = storage_root / "valid-project"
    valid_dir.mkdir()
    (valid_dir / "project.json").write_text(
        json.dumps({"id": "valid-project", "name": "Valid Project"}),
        encoding="utf-8",
    )

    invalid_dir = storage_root / "invalid-project"
    invalid_dir.mkdir()
    (invalid_dir / "project.json").write_text("not-json", encoding="utf-8")

    previous_root = pm.STORAGE_ROOT
    pm.STORAGE_ROOT = storage_root
    try:
        projects = pm.list_cad_projects()
    finally:
        pm.STORAGE_ROOT = previous_root

    assert [project["id"] for project in projects] == ["valid-project"]

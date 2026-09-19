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


def test_list_cad_projects_skips_non_utf8_project_json(tmp_path) -> None:
    storage_root = tmp_path / "projects"
    storage_root.mkdir(parents=True)

    valid_dir = storage_root / "valid-project"
    valid_dir.mkdir()
    (valid_dir / "project.json").write_text(
        json.dumps({"id": "valid-project", "name": "Valid Project"}),
        encoding="utf-8",
    )

    invalid_encoding_dir = storage_root / "invalid-encoding-project"
    invalid_encoding_dir.mkdir()
    (invalid_encoding_dir / "project.json").write_bytes(b"\xff\xfe\x00\x00")

    previous_root = pm.STORAGE_ROOT
    pm.STORAGE_ROOT = storage_root
    try:
        projects = pm.list_cad_projects()
    finally:
        pm.STORAGE_ROOT = previous_root

    assert [project["id"] for project in projects] == ["valid-project"]


def test_list_cad_projects_skips_non_object_metadata(tmp_path) -> None:
    storage_root = tmp_path / "projects"
    storage_root.mkdir(parents=True)

    valid_dir = storage_root / "valid-project"
    valid_dir.mkdir()
    (valid_dir / "project.json").write_text(
        json.dumps({"id": "valid-project", "name": "Valid Project"}),
        encoding="utf-8",
    )

    invalid_type_dir = storage_root / "invalid-type-project"
    invalid_type_dir.mkdir()
    (invalid_type_dir / "project.json").write_text('["not-an-object"]', encoding="utf-8")

    previous_root = pm.STORAGE_ROOT
    pm.STORAGE_ROOT = storage_root
    try:
        projects = pm.list_cad_projects()
    finally:
        pm.STORAGE_ROOT = previous_root

    assert [project["id"] for project in projects] == ["valid-project"]


def test_list_cad_projects_recovers_concatenated_metadata_with_leading_whitespace(tmp_path) -> None:
    storage_root = tmp_path / "projects"
    storage_root.mkdir(parents=True)

    valid_dir = storage_root / "valid-project"
    valid_dir.mkdir()
    (valid_dir / "project.json").write_text(
        json.dumps({"id": "valid-project", "name": "Valid Project"}),
        encoding="utf-8",
    )

    recovered_dir = storage_root / "recovered-project"
    recovered_dir.mkdir()
    (recovered_dir / "project.json").write_text(
        '  {"id":"recovered-project","name":"Recovered"}{"extra":1}',
        encoding="utf-8",
    )

    previous_root = pm.STORAGE_ROOT
    pm.STORAGE_ROOT = storage_root
    try:
        projects = pm.list_cad_projects()
    finally:
        pm.STORAGE_ROOT = previous_root

    assert [project["id"] for project in projects] == ["recovered-project", "valid-project"]

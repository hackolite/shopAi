from __future__ import annotations

import json

import pytest

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


def test_list_cad_projects_skips_invalid_concatenated_metadata_suffix(tmp_path) -> None:
    storage_root = tmp_path / "projects"
    storage_root.mkdir(parents=True)

    valid_dir = storage_root / "valid-project"
    valid_dir.mkdir()
    (valid_dir / "project.json").write_text(
        json.dumps({"id": "valid-project", "name": "Valid Project"}),
        encoding="utf-8",
    )

    invalid_suffix_dir = storage_root / "invalid-suffix-project"
    invalid_suffix_dir.mkdir()
    (invalid_suffix_dir / "project.json").write_text(
        '{"id":"invalid-suffix-project","name":"Broken"} trailing-garbage',
        encoding="utf-8",
    )

    previous_root = pm.STORAGE_ROOT
    pm.STORAGE_ROOT = storage_root
    try:
        projects = pm.list_cad_projects()
    finally:
        pm.STORAGE_ROOT = previous_root

    assert [project["id"] for project in projects] == ["valid-project"]


def test_list_cad_projects_recovers_with_json_array_suffix(tmp_path) -> None:
    storage_root = tmp_path / "projects"
    storage_root.mkdir(parents=True)

    valid_dir = storage_root / "valid-project"
    valid_dir.mkdir()
    (valid_dir / "project.json").write_text(
        json.dumps({"id": "valid-project", "name": "Valid Project"}),
        encoding="utf-8",
    )

    recovered_dir = storage_root / "recovered-array-suffix-project"
    recovered_dir.mkdir()
    (recovered_dir / "project.json").write_text(
        '{"id":"recovered-array-suffix-project","name":"Recovered"}[]',
        encoding="utf-8",
    )

    previous_root = pm.STORAGE_ROOT
    pm.STORAGE_ROOT = storage_root
    try:
        projects = pm.list_cad_projects()
    finally:
        pm.STORAGE_ROOT = previous_root

    assert [project["id"] for project in projects] == [
        "recovered-array-suffix-project",
        "valid-project",
    ]


def test_windows_template_link_placeholders_are_not_projects(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path)
    for project_id in pm.REFERENCE_PROJECT_IDS:
        directory = tmp_path / project_id
        directory.mkdir()
        (directory / "project.json").write_text(
            f"../../templates/{project_id}/project.json", encoding="utf-8",
        )
    pm.create_project("owned", "Mon projet")
    assert [item["id"] for item in pm.list_cad_projects()] == ["owned"]
    assert "Invalid JSON" not in caplog.text


def test_metadata_accepts_windows_utf8_bom(tmp_path, monkeypatch):
    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path)
    pm.create_project("owned", "Mon projet")
    (tmp_path / "owned" / "project.json").write_text(
        json.dumps({"id": "owned", "name": "Mon projet"}), encoding="utf-8-sig",
    )
    assert pm.get_project_metadata("owned")["name"] == "Mon projet"


def test_invalid_save_preserves_previous_json(tmp_path, monkeypatch):
    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path)
    pm.create_project("owned", "Mon projet")
    path = tmp_path / "owned" / "scene.json"
    previous = path.read_bytes()
    with pytest.raises(TypeError):
        pm.save_project_file("owned", "scene.json", {"invalid": object()})
    assert path.read_bytes() == previous
    assert not list(path.parent.glob("*.tmp"))


def test_failed_replace_preserves_previous_json(tmp_path, monkeypatch):
    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path)
    pm.create_project("owned", "Mon projet")
    path = tmp_path / "owned" / "scene.json"
    previous = path.read_bytes()

    def fail_replace(*args):
        raise OSError("File locked")

    monkeypatch.setattr(pm.os, "replace", fail_replace)
    with pytest.raises(OSError, match="File locked"):
        pm.save_project_file("owned", "scene.json", {"store": {}})
    assert path.read_bytes() == previous
    assert not list(path.parent.glob("*.tmp"))

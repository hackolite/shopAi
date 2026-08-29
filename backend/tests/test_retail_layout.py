"""Unit + integration tests for the retail layout export/import round-trip.

Round-trip invariant: split(build(scene, planograms)) reproduces the original
scene and planograms with all IDs preserved.

Integration tests use the FastAPI TestClient against an isolated temp storage
directory, mirroring the pattern used in test_scene_concurrency.py.
"""
from __future__ import annotations

import json
import sys
import os
import tempfile
from pathlib import Path
from uuid import uuid4

import pytest

# ---------------------------------------------------------------------------
# Isolate storage before importing anything that touches the filesystem.
# ---------------------------------------------------------------------------
_tmp_storage = tempfile.mkdtemp(prefix="shopai_retail_test_")

import services.project_manager as pm

pm.STORAGE_ROOT = Path(_tmp_storage)

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402
from services.retail_layout import build_retail_layout, split_retail_layout  # noqa: E402

client = TestClient(app, raise_server_exceptions=True)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_FURNITURE_ID = str(uuid4())
_PLANO_ID = str(uuid4())
_CELL_ID = str(uuid4())
_EAN = "3017620422003"

_SCENE: dict = {
    "store": {
        "id": str(uuid4()),
        "name": "Test Store",
        "position": [0.0, 0.0, 0.0],
        "rotation": [0.0, 0.0, 0.0],
        "dimensions": {"width": 5000.0, "depth": 3000.0, "height": 400.0},
        "walls": [],
    },
    "furniture": [
        {
            "id": _FURNITURE_ID,
            "name": "Gondole A1",
            "type": "gondola",
            "libraryId": "gondola-standard",
            "position": [100.0, 0.0, 200.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 120.0, "depth": 60.0, "height": 180.0},
            "materialId": None,
            "visible": True,
            "locked": False,
            "mounted": True,
            "parentId": None,
            "childIds": [],
            "faces": {"front": _PLANO_ID, "back": None, "left": None, "right": None, "top": None, "bottom": None},
        }
    ],
}

_PLANOGRAMS: list[dict] = [
    {
        "id": _PLANO_ID,
        "name": "Plano front A1",
        "furnitureId": _FURNITURE_ID,
        "face": "front",
        "rows": 3,
        "cols": 4,
        "widthCm": 120.0,
        "heightCm": 180.0,
        "cells": [
            {"id": _CELL_ID, "ean": _EAN, "row": 0, "col": 0, "rotation": 0},
            {"id": str(uuid4()), "ean": "5000112548167", "row": 1, "col": 2, "rotation": 0},
        ],
    }
]


# ---------------------------------------------------------------------------
# Unit tests: build_retail_layout
# ---------------------------------------------------------------------------

def test_build_retail_layout_structure() -> None:
    layout = build_retail_layout("proj-1", _SCENE, _PLANOGRAMS)

    assert layout["version"] == "1.0"
    assert layout["projectId"] == "proj-1"
    assert layout["unit"] == "cm"
    assert "exportedAt" in layout

    assert len(layout["furniture"]) == 1
    furn = layout["furniture"][0]
    assert furn["id"] == _FURNITURE_ID
    assert furn["position"] == {"x": 100.0, "y": 0.0, "z": 200.0}

    assert len(furn["placements"]) == 1
    placement = furn["placements"][0]
    assert placement["face"] == "front"
    assert placement["planogramId"] == _PLANO_ID
    assert len(placement["slots"]) == 2


def test_build_retail_layout_slot_ean() -> None:
    layout = build_retail_layout("proj-1", _SCENE, _PLANOGRAMS)
    slots = layout["furniture"][0]["placements"][0]["slots"]
    eans = [s["ean"] for s in slots]
    assert _EAN in eans


def test_build_retail_layout_absolute_position_front_face() -> None:
    """Front-face slot at row=0, col=0 should have z == furniture pz (200 cm)."""
    layout = build_retail_layout("proj-1", _SCENE, _PLANOGRAMS)
    slot_0 = next(
        s for s in layout["furniture"][0]["placements"][0]["slots"]
        if s["ean"] == _EAN
    )
    abs_pos = slot_0["absolutePositionCm"]
    # z should equal furniture pz (200.0) for a front-face slot
    assert abs_pos["z"] == pytest.approx(200.0, abs=0.5)
    # x should be within [100, 220] (furniture x range)
    assert 100.0 <= abs_pos["x"] <= 220.0


def test_build_retail_layout_no_planograms() -> None:
    layout = build_retail_layout("proj-2", _SCENE, [])
    assert layout["furniture"][0]["placements"] == []


def test_build_retail_layout_empty_scene() -> None:
    scene = {"store": {"id": "s1", "name": "Empty", "dimensions": {}}, "furniture": []}
    layout = build_retail_layout("proj-3", scene, [])
    assert layout["furniture"] == []


# ---------------------------------------------------------------------------
# Unit tests: split_retail_layout
# ---------------------------------------------------------------------------

def test_split_retail_layout_round_trip_ids() -> None:
    """IDs must survive the build → split round-trip."""
    layout = build_retail_layout("proj-rt", _SCENE, _PLANOGRAMS)
    scene_out, planograms_out = split_retail_layout(layout)

    assert len(scene_out["furniture"]) == 1
    assert scene_out["furniture"][0]["id"] == _FURNITURE_ID
    assert scene_out["furniture"][0]["faces"]["front"] == _PLANO_ID

    assert len(planograms_out) == 1
    plano_out = planograms_out[0]
    assert plano_out["id"] == _PLANO_ID
    assert plano_out["furnitureId"] == _FURNITURE_ID
    assert plano_out["face"] == "front"


def test_split_retail_layout_round_trip_cells() -> None:
    layout = build_retail_layout("proj-rt2", _SCENE, _PLANOGRAMS)
    _, planograms_out = split_retail_layout(layout)

    cells_out = planograms_out[0]["cells"]
    assert len(cells_out) == 2
    eans = {c["ean"] for c in cells_out}
    assert _EAN in eans
    # absolutePositionCm must NOT be present in cells (it's derived)
    for c in cells_out:
        assert "absolutePositionCm" not in c


def test_split_retail_layout_preserves_dimensions() -> None:
    layout = build_retail_layout("proj-rt3", _SCENE, _PLANOGRAMS)
    scene_out, _ = split_retail_layout(layout)

    pos = scene_out["furniture"][0]["position"]
    assert pos == [100.0, 0.0, 200.0]

    dims = scene_out["furniture"][0]["dimensions"]
    assert dims["width"] == pytest.approx(120.0)


def test_split_retail_layout_name_override() -> None:
    layout = build_retail_layout("proj-name", _SCENE, _PLANOGRAMS)
    scene_out, _ = split_retail_layout(layout, project_name="Nouveau Magasin")
    assert scene_out["store"]["name"] == "Nouveau Magasin"


# ---------------------------------------------------------------------------
# Integration tests via FastAPI TestClient
# ---------------------------------------------------------------------------

def _create_project_with_furniture_and_planogram() -> str:
    # Create project
    resp = client.post("/api/cad/projects/", json={"name": "retail-layout-test"})
    assert resp.status_code == 200, resp.text
    project_id = resp.json()["id"]

    # Add furniture
    furn_payload = {
        "id": _FURNITURE_ID,
        "name": "Gondole A1",
        "type": "gondola",
        "libraryId": "gondola-standard",
        "position": [100.0, 0.0, 200.0],
        "rotation": [0.0, 0.0, 0.0],
        "dimensions": {"width": 120.0, "depth": 60.0, "height": 180.0},
    }
    resp = client.post(f"/api/cad/projects/{project_id}/scene/furniture", json=furn_payload)
    assert resp.status_code == 200, resp.text

    # Add planogram
    plano_payload = {
        "id": _PLANO_ID,
        "name": "Plano front A1",
        "furnitureId": _FURNITURE_ID,
        "face": "front",
        "rows": 3,
        "cols": 4,
        "widthCm": 120.0,
        "heightCm": 180.0,
        "cells": [
            {"id": _CELL_ID, "ean": _EAN, "row": 0, "col": 0, "rotation": 0},
        ],
    }
    resp = client.post(f"/api/cad/projects/{project_id}/planograms", json=plano_payload)
    assert resp.status_code == 200, resp.text

    return project_id


def test_export_retail_layout_endpoint_returns_json() -> None:
    project_id = _create_project_with_furniture_and_planogram()
    resp = client.get(f"/api/cad/projects/{project_id}/export/retail-layout")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    data = resp.json()
    assert data["projectId"] == project_id
    assert data["version"] == "1.0"


def test_export_retail_layout_contains_ean() -> None:
    project_id = _create_project_with_furniture_and_planogram()
    resp = client.get(f"/api/cad/projects/{project_id}/export/retail-layout")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    all_eans = [
        s["ean"]
        for furn in data["furniture"]
        for placement in furn["placements"]
        for s in placement["slots"]
    ]
    assert _EAN in all_eans


def test_export_retail_layout_404_for_unknown_project() -> None:
    resp = client.get("/api/cad/projects/nonexistent-xyz/export/retail-layout")
    assert resp.status_code == 404


def test_import_retail_layout_creates_project() -> None:
    project_id = _create_project_with_furniture_and_planogram()

    # Export
    resp = client.get(f"/api/cad/projects/{project_id}/export/retail-layout")
    assert resp.status_code == 200
    layout = resp.json()

    # Re-import
    resp2 = client.post(
        "/api/cad/projects/import/retail-layout",
        json={"name": "Imported Layout", "layout": layout},
    )
    assert resp2.status_code == 200, resp2.text
    new_id = resp2.json()["id"]
    assert new_id != project_id

    # Verify scene has furniture with correct ID
    resp3 = client.get(f"/api/cad/projects/{new_id}/scene")
    assert resp3.status_code == 200, resp3.text
    scene = resp3.json()
    furn_ids = [f["id"] for f in scene["furniture"]]
    assert _FURNITURE_ID in furn_ids

    # Verify planogram link is preserved
    furn = next(f for f in scene["furniture"] if f["id"] == _FURNITURE_ID)
    assert furn["faces"]["front"] == _PLANO_ID


def test_import_retail_layout_planogram_preserved() -> None:
    project_id = _create_project_with_furniture_and_planogram()
    resp = client.get(f"/api/cad/projects/{project_id}/export/retail-layout")
    layout = resp.json()

    resp2 = client.post(
        "/api/cad/projects/import/retail-layout",
        json={"name": "Imported Layout 2", "layout": layout},
    )
    new_id = resp2.json()["id"]

    resp3 = client.get(f"/api/cad/projects/{new_id}/planograms/{_PLANO_ID}")
    assert resp3.status_code == 200, resp3.text
    plano = resp3.json()
    assert plano["id"] == _PLANO_ID
    eans = [c["ean"] for c in plano["cells"]]
    assert _EAN in eans

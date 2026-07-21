"""Integration test: concurrent write-write race on scene.json.

Two requests targeting the same project — one updating the store, the other
updating a furniture item — are fired in parallel via the FastAPI TestClient
(which uses a real thread pool, matching production behaviour).  After both
requests complete, we verify that BOTH mutations are visible in scene.json,
i.e. neither write silently overwrote the other.
"""
from __future__ import annotations

import concurrent.futures
import sys
import os
import tempfile
import threading
import time
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Point the storage layer at a temporary directory so tests are isolated and
# do not touch the real storage/projects tree.
# ---------------------------------------------------------------------------
_tmp_storage = tempfile.mkdtemp(prefix="shopai_test_")

import services.project_manager as pm
pm.STORAGE_ROOT = Path(_tmp_storage)

from main import app  # noqa: E402 – must import after patching STORAGE_ROOT

client = TestClient(app, raise_server_exceptions=True)


def _create_project() -> str:
    resp = client.post("/api/cad/projects/", json={"name": "test-concurrency"})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _add_furniture(project_id: str) -> str:
    furniture_id = str(uuid4())
    payload = {
        "id": furniture_id,
        "name": "Gondola",
        "type": "gondola",
        "libraryId": "gondola-standard",
        "position": [0.0, 0.0, 0.0],
        "rotation": [0.0, 0.0, 0.0],
        "dimensions": {"width": 120.0, "depth": 60.0, "height": 200.0},
    }
    resp = client.post(f"/api/cad/projects/{project_id}/scene/furniture", json=payload)
    assert resp.status_code == 200, resp.text
    return furniture_id


# ---------------------------------------------------------------------------
# Test: concurrent update_store + update_furniture — no lost update
# ---------------------------------------------------------------------------

def test_concurrent_store_and_furniture_update_no_lost_write() -> None:
    """Both concurrent mutations must survive; neither may silently overwrite the other."""
    project_id = _create_project()
    furniture_id = _add_furniture(project_id)

    target_rotation = [0.0, 1.5707963267948966, 0.0]  # π/2 around Y
    target_store_name = "Updated Store Name"

    barrier = threading.Barrier(2)
    results: dict[str, int] = {}

    def do_update_furniture() -> None:
        barrier.wait()
        resp = client.put(
            f"/api/cad/projects/{project_id}/scene/furniture/{furniture_id}",
            json={"rotation": target_rotation},
        )
        results["furniture_status"] = resp.status_code

    def do_update_store() -> None:
        barrier.wait()
        resp = client.put(
            f"/api/cad/projects/{project_id}/scene/store",
            json={"name": target_store_name},
        )
        results["store_status"] = resp.status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(do_update_furniture),
            pool.submit(do_update_store),
        ]
        for f in concurrent.futures.as_completed(futures):
            f.result()  # re-raises any exception from the thread

    assert results["furniture_status"] == 200, "update_furniture should succeed"
    assert results["store_status"] == 200, "update_store should succeed"

    # Verify the final state contains BOTH mutations.
    resp = client.get(f"/api/cad/projects/{project_id}/scene")
    assert resp.status_code == 200
    scene = resp.json()

    assert scene["store"]["name"] == target_store_name, (
        f"Store name was not persisted (lost update?): {scene['store']['name']!r}"
    )

    furniture_item = next(
        (f for f in scene["furniture"] if f["id"] == furniture_id), None
    )
    assert furniture_item is not None, "Furniture item missing from scene"
    assert furniture_item["rotation"] == target_rotation, (
        f"Furniture rotation was lost (race condition?): {furniture_item['rotation']}"
    )


# ---------------------------------------------------------------------------
# Test: concurrent update_furniture calls on two different furniture items
# ---------------------------------------------------------------------------

def test_concurrent_furniture_updates_no_lost_write() -> None:
    """Two concurrent furniture updates on the same project must both survive."""
    project_id = _create_project()
    furniture_id_a = _add_furniture(project_id)
    furniture_id_b = _add_furniture(project_id)

    rotation_a = [0.0, 1.5707963267948966, 0.0]
    rotation_b = [0.0, 3.141592653589793, 0.0]

    barrier = threading.Barrier(2)
    results: dict[str, int] = {}

    def update_a() -> None:
        barrier.wait()
        resp = client.put(
            f"/api/cad/projects/{project_id}/scene/furniture/{furniture_id_a}",
            json={"rotation": rotation_a},
        )
        results["a_status"] = resp.status_code

    def update_b() -> None:
        barrier.wait()
        resp = client.put(
            f"/api/cad/projects/{project_id}/scene/furniture/{furniture_id_b}",
            json={"rotation": rotation_b},
        )
        results["b_status"] = resp.status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(update_a), pool.submit(update_b)]
        for f in concurrent.futures.as_completed(futures):
            f.result()

    assert results["a_status"] == 200
    assert results["b_status"] == 200

    resp = client.get(f"/api/cad/projects/{project_id}/scene")
    assert resp.status_code == 200
    scene = resp.json()

    item_a = next(f for f in scene["furniture"] if f["id"] == furniture_id_a)
    item_b = next(f for f in scene["furniture"] if f["id"] == furniture_id_b)

    assert item_a["rotation"] == rotation_a, (
        f"Furniture A rotation lost: {item_a['rotation']}"
    )
    assert item_b["rotation"] == rotation_b, (
        f"Furniture B rotation lost: {item_b['rotation']}"
    )

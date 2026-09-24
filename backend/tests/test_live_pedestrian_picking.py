"""Live-simulation integration: pedestrian CSV import driving per-agent picking.

Covers step 3 of the CSV-driven simulation feature: once a pedestrian CSV is
imported and loaded into a running live session, spawning follows the CSV
schedule (instead of Poisson arrivals), each resolved EAN gets a dedicated
pickup stop with a variable 1s-4s retention, frames expose the agent's
current pick in progress, and completed pickups are reported as events and
reflected in the per-pedestrian basket endpoint.
"""

from __future__ import annotations

import io
import tempfile
from pathlib import Path

import services.project_manager as pm

pm.STORAGE_ROOT = Path(tempfile.mkdtemp(prefix="shopai_live_pedestrian_test_"))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app, raise_server_exceptions=True)


def _setup_project_with_product() -> tuple[str, dict]:
    project = client.post("/api/cad/projects/", json={"name": "live-pedestrian-test"})
    assert project.status_code == 200, project.text
    project_id = project.json()["id"]

    furniture = client.post(
        f"/api/cad/projects/{project_id}/scene/furniture",
        json={
            "name": "Gondole test",
            "type": "gondola",
            "libraryId": "lib-gondola",
            "position": [2500.0, 0.0, 1500.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 100.0, "depth": 40.0, "height": 180.0},
        },
    )
    assert furniture.status_code == 200, furniture.text
    furniture_id = furniture.json()["id"]

    product = client.post(
        f"/api/cad/projects/{project_id}/catalog/products",
        json={
            "ean": "TESTEAN0",
            "name": "Eau minérale",
            "brand": "Test",
            "category": "Boissons",
            "widthCm": 6.0,
            "depthCm": 6.0,
            "heightCm": 20.0,
            "weightG": 500.0,
            "priceSellEur": 1.5,
            "priceBuyEur": 0.8,
        },
    )
    assert product.status_code == 200, product.text

    planogram = client.post(
        f"/api/cad/projects/{project_id}/planograms",
        json={
            "name": "Face avant",
            "furnitureId": furniture_id,
            "face": "front",
            "rows": 1,
            "cols": 2,
            "widthCm": 100.0,
            "heightCm": 180.0,
            "cells": [{"ean": "TESTEAN0", "row": 0, "col": 0}],
        },
    )
    assert planogram.status_code == 200, planogram.text

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    return project_id, scene_response.json()


def _live_config() -> dict:
    return {
        "arrivalRatePerSecond": 0.6,
        "maxCustomers": 20,
        "randomSeed": 9,
        "waypoints": [
            {
                "id": "entry-main",
                "type": "entry",
                "label": "Entrée",
                "x": 2500.0,
                "z": 200.0,
                "radiusCm": 120.0,
                "optional": False,
                "visitProbability": 1.0,
                "retentionSeconds": 0.0,
                "visionAngleDeg": 70.0,
                "visionRangeCm": 220.0,
            },
            {
                "id": "exit-main",
                "type": "exit",
                "label": "Sortie",
                "x": 2500.0,
                "z": 2800.0,
                "radiusCm": 120.0,
                "optional": False,
                "visitProbability": 1.0,
                "retentionSeconds": 0.0,
                "visionAngleDeg": 70.0,
                "visionRangeCm": 220.0,
            },
        ],
    }


def test_live_simulation_follows_pedestrian_csv_schedule_and_reports_pickups() -> None:
    project_id, scene = _setup_project_with_product()

    csv_bytes = (
        b"pedestrian_id,start_unix_ts,speed_mps,profile_json,ean\n"
        b"1,0,1.2,,TESTEAN0\n"
        b"2,15,1.2,,TESTEAN0\n"
    )
    import_response = client.post(
        f"/api/cad/projects/{project_id}/simulation/import-pedestrians",
        files={"file": ("pedestrians.csv", io.BytesIO(csv_bytes), "text/csv")},
    )
    assert import_response.status_code == 200, import_response.text
    assert import_response.json()["plans"][0]["items"][0]["found"] is True

    start = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/start",
        json={"scene": scene, "config": _live_config()},
    )
    assert start.status_code == 200, start.text
    session_id = start.json()["sessionId"]

    load = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/load-pedestrians"
    )
    assert load.status_code == 200, load.text
    assert load.json()["pedestrianCount"] == 2

    picked_up = False
    saw_picking_field = False
    agent_id = None
    for _ in range(400):
        tick = client.post(
            f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
            json={"steps": 1},
        )
        assert tick.status_code == 200, tick.text
        result = tick.json()["result"]
        if result["frames"]:
            for agent in result["frames"][-1]["agents"]:
                if agent.get("pickingEan"):
                    saw_picking_field = True
                    agent_id = agent["id"]
        if result.get("pickupEvents"):
            picked_up = True
            agent_id = result["pickupEvents"][0]["agentId"]
            assert result["pickupEvents"][0]["ean"] == "TESTEAN0"
            assert result["pickupEvents"][0]["pedestrianId"] in (1, 2)
            break

    assert saw_picking_field, "agent frame should expose the product being picked"
    assert picked_up, "the pedestrian's single product should eventually be picked"

    basket = client.get(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/agents/{agent_id}/basket"
    )
    assert basket.status_code == 200, basket.text
    basket_body = basket.json()
    assert basket_body["changed"] is True
    assert basket_body["basket"]["pedestrianId"] in (1, 2)
    assert basket_body["basket"]["items"][0]["ean"] == "TESTEAN0"
    assert basket_body["basket"]["items"][0]["picked"] is True

    baskets = client.get(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/baskets"
    )
    assert baskets.status_code == 200, baskets.text
    baskets_body = baskets.json()
    assert baskets_body["full"] is True
    all_baskets = baskets_body["baskets"]
    assert any(basket["items"][0]["picked"] for basket in all_baskets)

    no_change = client.get(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/agents/{agent_id}/basket",
        params={"sinceSeq": basket_body["seq"]},
    )
    assert no_change.status_code == 200, no_change.text
    assert no_change.json() == {"seq": basket_body["seq"], "changed": False}

    basket_delta = client.get(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/baskets",
        params={"sinceSeq": baskets_body["seq"]},
    )
    assert basket_delta.status_code == 200, basket_delta.text
    assert basket_delta.json()["full"] is False
    assert basket_delta.json()["baskets"] == []

    delta_seq = baskets_body["seq"]
    delta_change_seen = False
    for _ in range(200):
        tick = client.post(
            f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
            json={"steps": 1},
        )
        assert tick.status_code == 200, tick.text
        delta = client.get(
            f"/api/cad/projects/{project_id}/simulation/live/{session_id}/baskets",
            params={"sinceSeq": delta_seq},
        )
        assert delta.status_code == 200, delta.text
        delta_body = delta.json()
        delta_seq = delta_body["seq"]
        if delta_body["full"] is False and delta_body["baskets"]:
            delta_change_seen = True
            break
    assert delta_change_seen, "basket delta should eventually include only updated baskets"

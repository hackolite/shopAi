from __future__ import annotations

import tempfile
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

import services.project_manager as pm

pm.STORAGE_ROOT = Path(tempfile.mkdtemp(prefix="shopai_sim_test_"))

from main import app  # noqa: E402

client = TestClient(app, raise_server_exceptions=True)


def _create_project() -> str:
    response = client.post("/api/cad/projects/", json={"name": "simulation-test"})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_run_simulation_with_waypoints_and_queue_metrics() -> None:
    project_id = _create_project()

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    scene["store"]["zones"] = [
        {
            "id": str(uuid4()),
            "type": "entrance",
            "label": "Entrée",
            "x": 2200.0,
            "z": 0.0,
            "width": 300.0,
            "depth": 180.0,
        },
        {
            "id": str(uuid4()),
            "type": "exit",
            "label": "Sortie",
            "x": 200.0,
            "z": 2820.0,
            "width": 300.0,
            "depth": 180.0,
        },
    ]
    scene["furniture"] = [
        {
            "id": str(uuid4()),
            "name": "Caisse A",
            "type": "register",
            "libraryId": "register",
            "position": [4200.0, 0.0, 600.0],
            "rotation": [0.0, 180.0, 0.0],
            "dimensions": {"width": 80.0, "depth": 60.0, "height": 90.0},
            "materialId": "plastic_black",
            "visible": True,
            "locked": False,
            "mounted": True,
            "parentId": None,
            "childIds": [],
            "faces": {"front": None, "back": None, "left": None, "right": None, "top": None, "bottom": None},
        }
    ]

    response = client.post(
        f"/api/cad/projects/{project_id}/simulation/run",
        json={
            "scene": scene,
            "config": {
                "arrivalRatePerSecond": 0.35,
                "durationSeconds": 20,
                "maxCustomers": 12,
                "randomSeed": 7,
                "serviceTimeSeconds": 4,
                "serviceTimeJitterSeconds": 0.5,
                "waypoints": [
                    {
                        "id": "wp-main",
                        "label": "Promo",
                        "x": 2600.0,
                        "z": 1400.0,
                        "radiusCm": 150.0,
                        "optional": False,
                        "visitProbability": 1.0,
                        "visionAngleDeg": 60.0,
                        "visionRangeCm": 180.0,
                    }
                ],
            },
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()

    assert payload["frames"], "simulation should emit frames"
    assert payload["checkouts"], "simulation should emit checkout metrics"
    assert payload["summary"]["spawnedCustomers"] > 0
    assert payload["checkouts"][0]["samples"], "checkout chart samples should be present"

    populated_frame = next(frame for frame in payload["frames"] if frame["agents"])
    first_agent = populated_frame["agents"][0]
    assert first_agent["visionAngleDeg"] == 60.0
    assert first_agent["visionRangeCm"] == 180.0

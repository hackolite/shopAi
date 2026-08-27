from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

import services.project_manager as pm

pm.STORAGE_ROOT = Path(tempfile.mkdtemp(prefix="shopai_sim_test_"))

from main import app  # noqa: E402

client = TestClient(app, raise_server_exceptions=True)


def _create_project() -> str:
    response = client.post("/api/cad/projects/", json={"name": "simulation-test"})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_run_simulation_with_entry_exit_and_retention_waypoints() -> None:
    project_id = _create_project()

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    scene["store"]["zones"] = []
    scene["furniture"] = []

    response = client.post(
        f"/api/cad/projects/{project_id}/simulation/run",
        json={
            "scene": scene,
            "config": {
                "arrivalRatePerSecond": 0.35,
                "durationSeconds": 20,
                "maxCustomers": 12,
                "randomSeed": 7,
                "waypoints": [
                    {
                        "id": "entry-main",
                        "type": "entry",
                        "label": "Entrée Nord",
                        "x": 2500.0,
                        "z": 200.0,
                        "radiusCm": 130.0,
                        "optional": False,
                        "visitProbability": 1.0,
                        "retentionSeconds": 0.0,
                        "visionAngleDeg": 70.0,
                        "visionRangeCm": 220.0,
                    },
                    {
                        "id": "wp-main",
                        "type": "transit",
                        "label": "Promo",
                        "x": 2600.0,
                        "z": 1400.0,
                        "radiusCm": 150.0,
                        "optional": False,
                        "visitProbability": 1.0,
                        "retentionSeconds": 2.0,
                        "visionAngleDeg": 60.0,
                        "visionRangeCm": 180.0,
                    },
                    {
                        "id": "exit-main",
                        "type": "exit",
                        "label": "Sortie Sud",
                        "x": 2500.0,
                        "z": 2800.0,
                        "radiusCm": 160.0,
                        "optional": False,
                        "visitProbability": 1.0,
                        "retentionSeconds": 0.0,
                        "visionAngleDeg": 70.0,
                        "visionRangeCm": 220.0,
                    }
                ],
            },
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()

    assert payload["frames"], "simulation should emit frames"
    assert payload["waypoints"], "simulation should emit waypoint metrics"
    assert payload["summary"]["spawnedCustomers"] > 0
    assert payload["summary"]["averageConfiguredRetentionSeconds"] >= 0
    assert payload["waypoints"][0]["samples"], "waypoint samples should be present"

    populated_frame = next(frame for frame in payload["frames"] if frame["agents"])
    first_agent = populated_frame["agents"][0]
    assert first_agent["visionAngleDeg"] == 60.0
    assert first_agent["visionRangeCm"] == 180.0

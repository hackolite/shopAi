from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Point, Polygon

import services.project_manager as pm
import services.simulation as simulation_service

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
    assert payload["summary"]["completedCustomers"] > 0
    assert payload["summary"]["activeCustomers"] < payload["summary"]["spawnedCustomers"]
    assert payload["summary"]["averageConfiguredRetentionSeconds"] >= 0
    assert payload["waypoints"][0]["samples"], "waypoint samples should be present"

    populated_frame = next(frame for frame in payload["frames"] if frame["agents"])
    first_agent = populated_frame["agents"][0]
    assert first_agent["visionAngleDeg"] == 60.0
    assert first_agent["visionRangeCm"] == 180.0


def test_exit_polygon_uses_compact_hidden_removal_radius() -> None:
    waypoint = simulation_service.SimulationWaypoint(
        id="exit-main",
        type="exit",
        label="Sortie",
        x=2500.0,
        z=1800.0,
        radiusCm=120.0,
        optional=False,
        visitProbability=1.0,
        retentionSeconds=0.0,
        visionAngleDeg=70.0,
        visionRangeCm=220.0,
    )
    walkable = Polygon([(0.0, 0.0), (50.0, 0.0), (50.0, 30.0), (0.0, 30.0)])

    polygon = simulation_service._waypoint_exit_polygon(waypoint, walkable)

    centroid = polygon.centroid
    assert centroid.x == pytest.approx(25.0)
    assert centroid.y == pytest.approx(18.0)
    min_x, min_y, max_x, max_y = polygon.bounds
    assert max_x - min_x == pytest.approx(0.8, abs=1e-6)
    assert max_y - min_y == pytest.approx(0.8, abs=1e-6)


def test_run_simulation_with_default_waypoints() -> None:
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
                "arrivalRatePerSecond": 0.2,
                "durationSeconds": 10,
                "maxCustomers": 4,
                "randomSeed": 5,
                "waypoints": [],
            },
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["summary"]["spawnedCustomers"] > 0
    assert any(waypoint["waypointType"] == "exit" for waypoint in payload["waypoints"])


def test_run_simulation_reports_closest_waypoint_correction() -> None:
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
                "arrivalRatePerSecond": 0.1,
                "durationSeconds": 10,
                "maxCustomers": 2,
                "randomSeed": 3,
                "waypoints": [
                    {
                        "id": "entry-edge",
                        "type": "entry",
                        "label": "Entrée mur",
                        "x": 10.0,
                        "z": 120.0,
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
            },
        },
    )
    assert response.status_code == 422, response.text
    payload = response.json()["detail"]

    assert payload["waypointId"] == "entry-edge"
    assert payload["waypointLabel"] == "Entrée mur"
    assert payload["currentXcm"] == 10.0
    assert payload["suggestedXcm"] > payload["currentXcm"]
    assert payload["suggestedZcm"] == 120.0


def test_run_simulation_raises_error_when_no_exit_waypoint_configured() -> None:
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
                "arrivalRatePerSecond": 0.1,
                "durationSeconds": 10,
                "maxCustomers": 2,
                "randomSeed": 1,
                "waypoints": [
                    {
                        "id": "entry-only",
                        "type": "entry",
                        "label": "Entrée",
                        "x": 2500.0,
                        "z": 300.0,
                        "radiusCm": 120.0,
                        "optional": False,
                        "visitProbability": 1.0,
                        "retentionSeconds": 0.0,
                        "visionAngleDeg": 70.0,
                        "visionRangeCm": 220.0,
                    },
                    {
                        "id": "transit-only",
                        "type": "transit",
                        "label": "Point 1",
                        "x": 2500.0,
                        "z": 1500.0,
                        "radiusCm": 120.0,
                        "optional": False,
                        "visitProbability": 1.0,
                        "retentionSeconds": 0.0,
                        "visionAngleDeg": 70.0,
                        "visionRangeCm": 220.0,
                    },
                ],
            },
        },
    )
    assert response.status_code == 422, response.text
    payload = response.json()["detail"]
    assert "Sortie" in payload["message"]


def test_distinct_waypoint_correction_falls_back_when_projection_matches_input(monkeypatch) -> None:
    point = (0.25, 0.5)
    walkable = Polygon([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)])

    monkeypatch.setattr(simulation_service, "_closest_walkable_point", lambda *_args: point)

    suggested = simulation_service._suggest_distinct_walkable_point(point, walkable)

    assert suggested is not None
    assert suggested != point
    assert walkable.contains(Point(suggested)) or walkable.touches(Point(suggested))


def test_run_simulation_allows_transit_waypoint_with_large_radius_in_accessible_aisle() -> None:
    project_id = _create_project()

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    scene["store"]["zones"] = []
    scene["furniture"] = [
        {
            "id": "shelf-left",
            "name": "Shelf Left",
            "type": "gondola",
            "libraryId": "fixture-left",
            "position": [2350.0, 0.0, 1500.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 100.0, "depth": 1000.0, "height": 200.0},
            "visible": True,
            "mounted": True,
            "locked": False,
            "childIds": [],
            "faces": {},
        },
        {
            "id": "shelf-right",
            "name": "Shelf Right",
            "type": "gondola",
            "libraryId": "fixture-right",
            "position": [2650.0, 0.0, 1500.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 100.0, "depth": 1000.0, "height": 200.0},
            "visible": True,
            "mounted": True,
            "locked": False,
            "childIds": [],
            "faces": {},
        },
    ]

    response = client.post(
        f"/api/cad/projects/{project_id}/simulation/run",
        json={
            "scene": scene,
            "config": {
                "arrivalRatePerSecond": 0.1,
                "durationSeconds": 10,
                "maxCustomers": 3,
                "randomSeed": 11,
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
                        "id": "transit-aisle",
                        "type": "transit",
                        "label": "Allée centrale",
                        "x": 2500.0,
                        "z": 2000.0,
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
            },
        },
    )

    assert response.status_code == 200, response.text


def test_simultaneous_spawn_no_agent_overlap() -> None:
    """Several agents spawned from the same entry must not overlap."""
    import math
    import services.simulation as sim_svc

    walkable = sim_svc._build_walkable_geometry(
        sim_svc.SceneData.model_validate(
            {
                "store": {
                    "id": "s1",
                    "name": "Test",
                    "dimensions": {"width": 5000, "depth": 5000, "height": 300},
                    "zones": [],
                    "walls": [],
                },
                "furniture": [],
                "walls": [],
            }
        )
    )
    entry = sim_svc.SimulationWaypoint(
        id="e1",
        label="Entrée",
        type="entry",
        x=2500.0,
        z=200.0,
        radiusCm=120.0,
    )
    rng = __import__("random").Random(0)
    n_agents = 8
    positions: list[tuple[float, float]] = []
    for _ in range(n_agents):
        pos = sim_svc._spawn_from_entry(entry, walkable, rng, positions)
        positions.append(pos)

    min_dist_m = sim_svc._cm_to_m(sim_svc.SPAWN_SPACING_CM)
    for i, a in enumerate(positions):
        for j, b in enumerate(positions):
            if i >= j:
                continue
            dist = math.hypot(a[0] - b[0], a[1] - b[1])
            assert dist >= min_dist_m - 1e-6, (
                f"Agents {i} and {j} too close: {dist:.4f} m < {min_dist_m:.4f} m"
            )


def test_live_simulation_lifecycle_pause_and_hot_update() -> None:
    project_id = _create_project()
    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    scene["store"]["zones"] = []
    scene["furniture"] = []
    config = {
        "arrivalRatePerSecond": 0.6,
        "durationSeconds": 60,
        "maxCustomers": 20,
        "randomSeed": 9,
        "waypoints": [
            {
                "id": "entry-main",
                "type": "entry",
                "label": "Entrée",
                "x": 2500.0,
                "z": 220.0,
                "radiusCm": 120.0,
                "optional": False,
                "visitProbability": 1.0,
                "retentionSeconds": 0.0,
                "visionAngleDeg": 70.0,
                "visionRangeCm": 220.0,
            },
            {
                "id": "transit-main",
                "type": "transit",
                "label": "Allée",
                "x": 2500.0,
                "z": 1700.0,
                "radiusCm": 120.0,
                "optional": False,
                "visitProbability": 1.0,
                "retentionSeconds": 1.0,
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

    start = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/start",
        json={"scene": scene, "config": config},
    )
    assert start.status_code == 200, start.text
    start_payload = start.json()
    session_id = start_payload["sessionId"]
    assert start_payload["paused"] is False
    assert start_payload["result"]["frames"], "live start should return an initial frame"

    tick = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
        json={"steps": 10},
    )
    assert tick.status_code == 200, tick.text
    tick_payload = tick.json()
    assert tick_payload["result"]["summary"]["spawnedCustomers"] >= 1
    assert tick_payload["result"]["frames"][-1]["timeSeconds"] > 0

    pause = client.post(f"/api/cad/projects/{project_id}/simulation/live/{session_id}/pause")
    assert pause.status_code == 200, pause.text
    assert pause.json()["paused"] is True

    paused_tick = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
        json={"steps": 5},
    )
    assert paused_tick.status_code == 200, paused_tick.text
    paused_payload = paused_tick.json()
    assert paused_payload["result"]["frames"][-1]["timeSeconds"] == tick_payload["result"]["frames"][-1]["timeSeconds"]

    scene["furniture"] = [
        {
            "id": "block-1",
            "name": "Bloc",
            "type": "gondola",
            "libraryId": "fixture-block",
            "position": [2450.0, 0.0, 1400.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 100.0, "depth": 300.0, "height": 200.0},
            "visible": True,
            "mounted": True,
            "locked": False,
            "childIds": [],
            "faces": {},
        }
    ]
    config["arrivalRatePerSecond"] = 0.2
    config["maxCustomers"] = 10
    update = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/update",
        json={"scene": scene, "config": config},
    )
    assert update.status_code == 200, update.text
    update_payload = update.json()
    assert update_payload["result"]["summary"]["activeCustomers"] >= 0

    resume = client.post(f"/api/cad/projects/{project_id}/simulation/live/{session_id}/resume")
    assert resume.status_code == 200, resume.text
    assert resume.json()["paused"] is False

    tick_after_resume = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
        json={"steps": 5},
    )
    assert tick_after_resume.status_code == 200, tick_after_resume.text
    resumed_payload = tick_after_resume.json()
    assert resumed_payload["result"]["frames"][-1]["timeSeconds"] > paused_payload["result"]["frames"][-1]["timeSeconds"]
    assert resumed_payload["result"]["summary"]["spawnedCustomers"] >= update_payload["result"]["summary"]["spawnedCustomers"]

    stop = client.post(f"/api/cad/projects/{project_id}/simulation/live/{session_id}/stop")
    assert stop.status_code == 200, stop.text
    assert stop.json()["stopped"] is True

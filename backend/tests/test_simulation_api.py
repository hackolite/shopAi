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


def test_exit_polygon_stays_anchored_when_furniture_moves_near() -> None:
    """Moving furniture *near* an exit must not relocate its removal zone.

    Regression: the removal disc used to be re-snapped with a large clearance,
    so a shelf placed near (not onto) the exit shifted the removal zone away
    from the marker. Agents would reach the unchanged approach waypoint, then
    divert to the relocated zone and vanish there — "as if the exit had moved".
    """
    waypoint = simulation_service.SimulationWaypoint(
        id="exit-main",
        type="exit",
        label="Sortie",
        x=900.0,
        z=500.0,
        radiusCm=40.0,
        optional=False,
        visitProbability=1.0,
        retentionSeconds=0.0,
        visionAngleDeg=70.0,
        visionRangeCm=220.0,
    )
    store = Polygon([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)])

    # Without furniture the removal zone is centred on the exit marker (9, 5).
    baseline = simulation_service._waypoint_exit_polygon(waypoint, store)
    assert baseline.centroid.x == pytest.approx(9.0)
    assert baseline.centroid.y == pytest.approx(5.0)

    # A shelf placed close to — but not covering — the exit centre.
    obstacle = Polygon([(8.2, 4.5), (8.8, 4.5), (8.8, 5.5), (8.2, 5.5)])
    walkable = store.difference(obstacle)

    polygon = simulation_service._waypoint_exit_polygon(waypoint, walkable)

    # The removal zone must remain essentially co-located with the marker
    # (only a small bite is taken out by the shelf), never jumping ~1 m away.
    assert polygon.centroid.x == pytest.approx(9.0, abs=0.15)
    assert polygon.centroid.y == pytest.approx(5.0, abs=0.15)
    # It must be a valid, hole-free polygon fully inside the walkable area.
    assert not list(polygon.interiors)
    assert walkable.covers(polygon)


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
        json={"steps": 1},
    )
    assert tick.status_code == 200, tick.text
    tick_payload = tick.json()
    assert tick_payload["result"]["frames"][-1]["timeSeconds"] > 0
    assert tick_payload["result"]["summary"]["spawnedCustomers"] > 0

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
            "position": [500.0, 0.0, 500.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 100.0, "depth": 100.0, "height": 200.0},
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
    assert resumed_payload["result"]["summary"]["activeCustomers"] >= 0

    stop = client.post(f"/api/cad/projects/{project_id}/simulation/live/{session_id}/stop")
    assert stop.status_code == 200, stop.text
    assert stop.json()["stopped"] is True


def test_live_simulation_allows_multiple_customer_exits() -> None:
    project_id = _create_project()

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    scene["store"]["zones"] = []
    scene["furniture"] = []
    config = {
        "arrivalRatePerSecond": 1.2,
        "maxCustomers": 25,
        "randomSeed": 17,
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
    session_id = start.json()["sessionId"]

    tick = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
        json={"steps": 450},
    )
    assert tick.status_code == 200, tick.text
    summary = tick.json()["result"]["summary"]
    assert summary["spawnedCustomers"] > 3
    assert summary["completedCustomers"] > 1
    assert summary["activeCustomers"] < summary["spawnedCustomers"]

def test_live_simulation_tick_response_frames_stay_bounded() -> None:
    from services.live_simulation import LIVE_RESPONSE_FRAME_WINDOW

    project_id = _create_project()

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    scene["store"]["zones"] = []
    scene["furniture"] = []
    config = {
        "arrivalRatePerSecond": 1.2,
        "maxCustomers": 25,
        "randomSeed": 17,
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
    session_id = start.json()["sessionId"]

    frame_counts: list[int] = []
    last_time = 0.0
    for _ in range(LIVE_RESPONSE_FRAME_WINDOW + 20):
        tick = client.post(
            f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
            json={"steps": 1},
        )
        assert tick.status_code == 200, tick.text
        frames = tick.json()["result"]["frames"]
        frame_counts.append(len(frames))
        # The newest frame time keeps advancing even though the payload is capped.
        assert frames[-1]["timeSeconds"] > last_time
        last_time = frames[-1]["timeSeconds"]

    # The per-tick payload never grows without bound.
    assert max(frame_counts) <= LIVE_RESPONSE_FRAME_WINDOW
    # After enough ticks the window is fully populated (constant-size responses).
    assert frame_counts[-1] == LIVE_RESPONSE_FRAME_WINDOW


def test_live_simulation_hot_update_keeps_agents_when_furniture_covers_them() -> None:
    """Moving furniture on top of existing agents must never wipe them all.

    A hot-update re-places carried agents onto the new walkable area. If an agent
    lands flush against freshly moved furniture, ``add_agent`` can reject it; that
    single failure must not abort the whole update and make every pedestrian
    disappear.
    """
    project_id = _create_project()

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    scene["store"]["zones"] = []
    scene["furniture"] = []
    config = {
        "arrivalRatePerSecond": 1.5,
        "maxCustomers": 25,
        "randomSeed": 5,
        "waypoints": [
            {
                "id": "entry-main",
                "type": "entry",
                "label": "Entrée",
                "x": 2500.0,
                "z": 220.0,
                "radiusCm": 200.0,
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

    start = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/start",
        json={"scene": scene, "config": config},
    )
    assert start.status_code == 200, start.text
    session_id = start.json()["sessionId"]

    # Populate the store with several agents.
    for _ in range(60):
        tick = client.post(
            f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
            json={"steps": 1},
        )
        assert tick.status_code == 200, tick.text
    active_before = tick.json()["result"]["summary"]["activeCustomers"]
    assert active_before > 0, "expected agents to be walking before the furniture move"

    # Drop a large furniture block across the middle of the store, right on top of
    # the corridor the agents are travelling through.
    store_width = scene["store"]["dimensions"]["width"]
    scene["furniture"] = [
        {
            "id": "block-mid",
            "name": "Bloc central",
            "type": "gondola",
            "libraryId": "fixture-block",
            "position": [store_width / 2 - 900.0, 0.0, 900.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 1800.0, "depth": 1200.0, "height": 200.0},
            "visible": True,
            "mounted": True,
            "locked": False,
            "childIds": [],
            "faces": {},
        }
    ]
    update = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/update",
        json={"scene": scene, "config": config},
    )
    assert update.status_code == 200, update.text
    active_after = update.json()["result"]["summary"]["activeCustomers"]
    # Agents are re-placed, not annihilated: the population survives the move.
    assert active_after > 0, "furniture move must never wipe every pedestrian"

    # The session keeps ticking normally afterwards.
    tick_after = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
        json={"steps": 3},
    )
    assert tick_after.status_code == 200, tick_after.text
    assert tick_after.json()["result"]["summary"]["activeCustomers"] >= 0

    stop = client.post(f"/api/cad/projects/{project_id}/simulation/live/{session_id}/stop")
    assert stop.status_code == 200, stop.text


def test_live_simulation_exposes_analytics_and_queue_wait_times() -> None:
    project_id = _create_project()
    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    scene["store"]["zones"] = []
    scene["furniture"] = []
    config = {
        "arrivalRatePerSecond": 0.8,
        "maxCustomers": 12,
        "randomSeed": 5,
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
                "id": "queue-main",
                "type": "transit",
                "label": "Caisse",
                "x": 2500.0,
                "z": 1500.0,
                "radiusCm": 120.0,
                "optional": False,
                "visitProbability": 1.0,
                "retentionSeconds": 2.0,
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
    session_id = start.json()["sessionId"]

    tick = None
    for _ in range(120):
        tick = client.post(
            f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
            json={"steps": 4},
        )
        assert tick.status_code == 200, tick.text
    assert tick is not None
    queue_metrics = next(
        item for item in tick.json()["result"]["waypoints"] if item["waypointId"] == "queue-main"
    )
    assert queue_metrics["completedWaits"] > 0, "agents must be released from the retention queue"
    assert queue_metrics["averageWaitSeconds"] >= 2.0
    assert queue_metrics["maxWaitSeconds"] >= queue_metrics["averageWaitSeconds"]

    analytics_response = client.get(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/analytics"
    )
    assert analytics_response.status_code == 200, analytics_response.text
    analytics = analytics_response.json()["analytics"]
    heatmap = analytics["heatmap"]
    assert heatmap["cols"] > 0 and heatmap["rows"] > 0
    assert len(heatmap["counts"]) == heatmap["cols"] * heatmap["rows"]
    assert heatmap["maxCount"] > 0, "agents walking the store must heat up the grid"
    assert analytics["trajectories"], "agent trajectories must be recorded"
    assert all(len(item["pointsCm"]) % 2 == 0 for item in analytics["trajectories"])

    missing = client.get(
        f"/api/cad/projects/{project_id}/simulation/live/unknown-session/analytics"
    )
    assert missing.status_code == 404

    stop = client.post(f"/api/cad/projects/{project_id}/simulation/live/{session_id}/stop")
    assert stop.status_code == 200, stop.text

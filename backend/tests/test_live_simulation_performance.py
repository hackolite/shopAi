from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import services.simulation as simsvc
from api.cad_projects import router
from models.project import PedestrianPickupPlan, SceneData, SimulationConfig
from services.live_simulation import (
    MAX_LIVE_FRAMES,
    MAX_WAYPOINT_SAMPLES,
    LiveSimulationSession,
    _LiveAgentRoute,
    live_simulation_manager,
)


def _session(agent_count: int = 0) -> LiveSimulationSession:
    scene = SceneData.model_validate({
        "store": {
            "id": "store", "name": "Store",
            "dimensions": {"width": 5000, "depth": 5000, "height": 300},
        },
        "furniture": [],
    })
    config = SimulationConfig.model_validate({
        "arrivalRatePerSecond": 0,
        "maxCustomers": max(100, agent_count),
        "randomSeed": 7,
        "waypoints": [
            {"id": "entry", "type": "entry", "x": 200, "z": 200},
            {"id": "queue", "type": "transit", "x": 2500, "z": 3000, "retentionSeconds": 1},
            {"id": "exit", "type": "exit", "x": 4800, "z": 4800},
        ],
    })
    session = LiveSimulationSession("performance-test", scene, config)
    if agent_count:
        session._init_runtime([
            (
                _LiveAgentRoute(i + 1, 1.2, ["queue", "exit", "exit_hidden:exit"]),
                (2 + (i % 30), 2 + (i // 30)),
            )
            for i in range(agent_count)
        ])
        session.spawned = agent_count
        # Replace the constructor's empty t=0 frame after fixture-only agent injection.
        session.frames.clear()
        session._capture_frame()
    return session


def _navmesh_session() -> LiveSimulationSession:
    scene = SceneData.model_validate({
        "store": {
            "id": "nav-store",
            "name": "Store",
            "dimensions": {"width": 3000, "depth": 2000, "height": 300},
            "zones": [
                {
                    "id": "block",
                    "type": "forbidden",
                    "label": "Blocker",
                    "x": 1200,
                    "z": 0,
                    "width": 400,
                    "depth": 1500,
                }
            ],
        },
        "furniture": [],
    })
    config = SimulationConfig.model_validate({
        "arrivalRatePerSecond": 10.0,
        "durationSeconds": 5,
        "maxCustomers": 2,
        "randomSeed": 7,
        "waypoints": [
            {"id": "entry", "type": "entry", "x": 200, "z": 200},
            {"id": "exit", "type": "exit", "x": 2800, "z": 1800},
        ],
    })
    return LiveSimulationSession("navmesh-test", scene, config)


@pytest.mark.parametrize("frame_window", [8, 16])
def test_one_hundred_real_agents_have_identical_batched_physics_frames_and_statistics(frame_window) -> None:
    batched, sequential = _session(100), _session(100)
    assert batched.active_agents == sequential.active_agents == 100
    for _ in range(5):
        result = batched.tick(10, include_waypoint_metrics=False, frame_window=frame_window)
        for _ in range(10):
            sequential.tick(include_waypoint_metrics=False)
        assert batched.frames == sequential.frames
        assert batched.analytics() == sequential.analytics()
        assert batched.snapshot() == sequential.snapshot()
        assert len(result.frames) == min(frame_window, len(batched.frames))
        assert [round(b.timeSeconds - a.timeSeconds, 2) for a, b in zip(result.frames, result.frames[1:])] == [0.1] * (len(result.frames) - 1)
    assert len(batched.analytics_recorder._trajectories) == 40
    assert len(batched.analytics().customers) == 100


def test_batched_pickups_preserve_retention_events_and_csv_schedule() -> None:
    batched, sequential = _session(), _session()
    plans = [
        PedestrianPickupPlan.model_validate({
            "pedestrianId": i + 1, "startUnixTs": i * 2, "speedMps": 1.2,
            "items": [{"ean": f"product-{i}", "found": True, "xCm": 400, "zCm": 400, "pickupDurationSeconds": 1.5}],
        })
        for i in range(2)
    ]
    for session in (batched, sequential):
        session.load_pedestrian_plans(plans)
    all_events = []
    for _ in range(20):
        result = batched.tick(10)
        events = []
        for _ in range(10):
            events.extend(sequential.tick().pickupEvents)
        assert result.pickupEvents == events
        assert batched.frames == sequential.frames
        assert batched.analytics() == sequential.analytics()
        assert batched.waypoint_metrics_snapshot() == sequential.waypoint_metrics_snapshot()
        all_events.extend(events)
    assert len(all_events) == 2
    assert batched.list_baskets() == sequential.list_baskets()
    for event in all_events:
        picking_frames = [
            frame for frame in batched.frames
            if any(agent.id == event.agentId and agent.pickingEan == event.ean for agent in frame.agents)
        ]
        assert picking_frames
        picking = next(agent for agent in picking_frames[0].agents if agent.id == event.agentId)
        assert picking.pickingDurationSeconds == 1.5
        assert event.timeSeconds - picking.pickingStartedAtSeconds >= 1.5 - 1e-9


def test_capture_retention_limits_and_pause_do_not_duplicate_samples() -> None:
    session = _session()
    for _ in range(25):
        session.tick(50)
    assert len(session.frames) == MAX_LIVE_FRAMES
    assert all(len(samples) == MAX_WAYPOINT_SAMPLES for samples in session.waypoint_series.values())
    assert session.average_load_samples == 1251
    seq = session.analytics_recorder.seq
    session.set_paused(True)
    result = session.tick(50, frame_window=8)
    assert len(result.frames) == 8
    assert session.analytics_recorder.seq == seq
    assert session.average_load_samples == 1251


def test_live_runtime_expands_routes_through_hidden_navmesh_tokens_and_caches_segments() -> None:
    session = _navmesh_session()

    session.tick(1, include_waypoint_metrics=False)

    assert session.agent_routes
    route = next(iter(session.agent_routes.values()))
    hidden_tokens = [token for token in route.route_tokens if token.startswith("nav-live:")]
    assert hidden_tokens
    assert session.route_planner is not None
    assert session.route_planner._segment_token_cache
    assert session.route_planner._flow_field_cache

    cached_before = dict(session.route_planner._segment_token_cache)
    flow_cached_before = dict(session.route_planner._flow_field_cache)
    session.tick(1, include_waypoint_metrics=False)
    assert dict(session.route_planner._segment_token_cache) == cached_before
    assert dict(session.route_planner._flow_field_cache) == flow_cached_before


def test_position_spatial_hash_matches_linear_clearance_checks() -> None:
    positions = [(1.0, 1.0), (2.0, 1.0), (5.0, 5.0)]
    index = simsvc.PositionSpatialHash(cell_size_m=simsvc._cm_to_m(simsvc.SPAWN_SPACING_CM))
    for position in positions:
        index.insert(position)

    near_candidate = (1.2, 1.0)
    far_candidate = (8.0, 8.0)

    assert simsvc._candidate_clears_occupied(near_candidate, positions) is False
    assert simsvc._candidate_clears_occupied(near_candidate, index) is False
    assert simsvc._candidate_clears_occupied(far_candidate, positions) is True
    assert simsvc._candidate_clears_occupied(far_candidate, index) is True


@pytest.mark.parametrize("frame_window", [8, 16])
def test_tick_response_uses_typed_json_without_fastapi_recursive_encoding(monkeypatch, frame_window) -> None:
    import fastapi.encoders
    import fastapi.routing

    session = _session(100)
    monkeypatch.setitem(live_simulation_manager._sessions, session.id, session)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    session.tick(20)
    session.set_paused(True)
    expected = {"sessionId": session.id, "result": session.snapshot(False, frame_window).model_dump(mode="json"), "paused": True}

    def unexpected_encoding(*args, **kwargs):
        raise AssertionError("tick response must not traverse jsonable_encoder")

    monkeypatch.setattr(fastapi.encoders, "jsonable_encoder", unexpected_encoding)
    monkeypatch.setattr(fastapi.routing, "jsonable_encoder", unexpected_encoding)
    response = client.post(
        f"/api/cad/projects/{session.project_id}/simulation/live/{session.id}/tick",
        json={"steps": 1, "includeWaypointMetrics": False, "frameWindow": frame_window},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.json() == expected
    assert response.json()["result"]["frames"][-1]["agents"][0]["pickingEan"] is None
    assert len(json.loads(session.snapshot().model_dump_json())["frames"]) == 20


def test_one_hundred_agents_keep_using_analytics_deltas_at_one_hertz(monkeypatch) -> None:
    session = _session(100)
    monkeypatch.setitem(live_simulation_manager._sessions, session.id, session)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    url = f"/api/cad/projects/{session.project_id}/simulation/live/{session.id}"
    initial = client.get(f"{url}/analytics").json()
    assert initial["full"] is True
    seq = initial["seq"]
    for _ in range(5):
        response = client.post(f"{url}/tick", json={"steps": 10, "frameWindow": 8, "includeWaypointMetrics": False})
        assert response.status_code == 200
        assert len(response.json()["result"]["frames"]) == 8
        response = client.get(f"{url}/analytics", params={"sinceSeq": seq})
        assert response.status_code == 200
        update = response.json()
        assert update["full"] is False
        assert "analytics" not in update
        assert len(update["analyticsDelta"]["customerUpdates"]) == 100
        seq = update["seq"]


@pytest.mark.parametrize("payload", [
    {"steps": 0}, {"steps": 51}, {"steps": 1.5}, {"steps": True},
    {"frameWindow": 7}, {"frameWindow": 21}, {"frameWindow": 8.5},
])
def test_invalid_tick_work_is_rejected_before_advancing(payload, monkeypatch) -> None:
    session = _session()
    monkeypatch.setitem(live_simulation_manager._sessions, session.id, session)
    app = FastAPI()
    app.include_router(router)
    response = TestClient(app).post(
        f"/api/cad/projects/{session.project_id}/simulation/live/{session.id}/tick", json=payload,
    )
    assert response.status_code == 422
    assert session.time_seconds == 0

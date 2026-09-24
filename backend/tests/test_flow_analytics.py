from __future__ import annotations

from models.project import (
    SceneData,
    SimulationAgentFrame,
    SimulationFrame,
    SimulationWaypoint,
)
from services.flow_analytics import FlowAnalyticsRecorder, build_analytics
from services.simulation import _WaypointRuntime, _tick_queue_runtime, queue_wait_metrics


def _scene(width: float = 1000.0, depth: float = 800.0) -> SceneData:
    return SceneData.model_validate(
        {
            "store": {
                "id": "store-1",
                "name": "Store",
                "position": [0.0, 0.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": width, "depth": depth, "height": 300.0},
            },
            "furniture": [],
        }
    )


def _frame(time_seconds: float, positions: list[tuple[int, float, float]]) -> SimulationFrame:
    return SimulationFrame(
        timeSeconds=time_seconds,
        agents=[
            SimulationAgentFrame(id=agent_id, xCm=x_cm, zCm=z_cm)
            for agent_id, x_cm, z_cm in positions
        ],
    )


class _FakeQueueStage:
    def __init__(self) -> None:
        self.queue: list[int] = []

    def enqueued(self) -> list[int]:
        return list(self.queue)

    def pop(self, count: int) -> None:
        del self.queue[:count]


def test_heatmap_counts_agent_occupancy_per_cell() -> None:
    recorder = FlowAnalyticsRecorder(_scene(), cell_size_cm=100.0)
    recorder.record_frame(_frame(0.0, [(1, 50.0, 50.0), (2, 50.0, 50.0)]))
    recorder.record_frame(_frame(0.1, [(1, 60.0, 60.0)]))

    heatmap = recorder.heatmap()
    assert heatmap.cols == 11 and heatmap.rows == 9
    assert len(heatmap.counts) == heatmap.cols * heatmap.rows
    assert heatmap.counts[0] == 3
    assert heatmap.maxCount == 3


def test_heatmap_ignores_positions_outside_the_store_grid() -> None:
    recorder = FlowAnalyticsRecorder(_scene(), cell_size_cm=100.0)
    recorder.record_frame(_frame(0.0, [(1, -500.0, 50.0), (2, 50.0, 90000.0)]))

    assert recorder.heatmap().maxCount == 0


def test_visit_heatmap_counts_cell_entries_not_samples() -> None:
    recorder = FlowAnalyticsRecorder(_scene(), cell_size_cm=100.0)
    # Agent 1 stays three ticks in the same cell, then moves to the next one.
    recorder.record_frame(_frame(0.0, [(1, 50.0, 50.0), (2, 50.0, 50.0)]))
    recorder.record_frame(_frame(0.1, [(1, 60.0, 60.0), (2, 50.0, 50.0)]))
    recorder.record_frame(_frame(0.2, [(1, 150.0, 50.0), (2, 50.0, 50.0)]))

    visits = recorder.visit_heatmap()
    assert visits.cols == recorder.heatmap().cols
    # Two agents entered the first cell once each, one entered the next cell.
    assert visits.counts[0] == 2
    assert visits.counts[1] == 1
    assert visits.maxCount == 2


def test_visit_heatmap_counts_a_new_visit_when_an_agent_comes_back() -> None:
    recorder = FlowAnalyticsRecorder(_scene(), cell_size_cm=100.0)
    recorder.record_frame(_frame(0.0, [(1, 50.0, 50.0)]))
    recorder.record_frame(_frame(0.1, [(1, 150.0, 50.0)]))
    recorder.record_frame(_frame(0.2, [(1, 50.0, 50.0)]))

    assert recorder.visit_heatmap().counts[0] == 2


def test_trajectories_record_moving_agents_only() -> None:
    recorder = FlowAnalyticsRecorder(_scene(), cell_size_cm=100.0)
    recorder.record_frame(_frame(0.0, [(1, 100.0, 100.0), (2, 300.0, 300.0)]))
    recorder.record_frame(_frame(0.1, [(1, 200.0, 100.0), (2, 300.0, 300.0)]))
    recorder.record_frame(_frame(0.2, [(1, 300.0, 100.0)]))

    trajectories = {item.agentId: item for item in recorder.trajectories()}
    # Agent 2 never moved: it has a single point and is not exported.
    assert set(trajectories) == {1}
    assert trajectories[1].pointsCm == [100.0, 100.0, 200.0, 100.0, 300.0, 100.0]
    assert trajectories[1].active is True


def test_recorder_resets_grid_when_store_geometry_changes() -> None:
    recorder = FlowAnalyticsRecorder(_scene(), cell_size_cm=100.0)
    recorder.record_frame(_frame(0.0, [(1, 50.0, 50.0)]))
    assert recorder.heatmap().maxCount == 1

    recorder.configure(_scene(width=2000.0, depth=1600.0))
    heatmap = recorder.heatmap()
    assert heatmap.maxCount == 0
    assert heatmap.cols == 21 and heatmap.rows == 17


def test_build_analytics_from_frames() -> None:
    analytics = build_analytics(
        _scene(),
        [
            _frame(0.0, [(1, 100.0, 100.0)]),
            _frame(0.1, [(1, 250.0, 100.0)]),
        ],
        cell_size_cm=100.0,
    )
    assert analytics.timeSeconds == 0.1
    assert analytics.heatmap is not None
    assert analytics.heatmap.maxCount == 1
    assert analytics.visitHeatmap is not None
    assert analytics.visitHeatmap.maxCount == 1
    assert sum(analytics.visitHeatmap.counts) == 2
    assert [item.agentId for item in analytics.trajectories] == [1]


def test_customer_journey_tracks_distance_duration_and_exit() -> None:
    recorder = FlowAnalyticsRecorder(_scene(), cell_size_cm=100.0)
    recorder.record_frame(_frame(0.0, [(1, 0.0, 0.0)]))
    recorder.record_frame(_frame(2.0, [(1, 300.0, 400.0)]))
    recorder.record_frame(_frame(3.0, []))

    customer = recorder.snapshot().customers[0]
    assert customer.customerId == 1
    assert customer.entryTimeSeconds == 0.0
    assert customer.exitTimeSeconds == 3.0
    assert customer.totalTimeSeconds == 3.0
    assert customer.distanceCm == 500.0
    assert customer.active is False


def test_delta_since_falls_back_to_full_when_history_window_is_exceeded() -> None:
    recorder = FlowAnalyticsRecorder(_scene(), cell_size_cm=100.0)
    for step in range(620):
        recorder.record_frame(_frame(step * 0.1, [(1, 50.0 + float(step % 20), 50.0)]))

    assert recorder.seq > 600
    # Old sequence is outside the retained delta window: caller must request
    # a full snapshot fallback.
    assert recorder.delta_since(0) is None


def _apply_delta(base: dict, delta: dict) -> dict:
    from copy import deepcopy

    result = deepcopy(base)
    result["timeSeconds"] = delta["timeSeconds"]
    for name, increments in (("heatmap", "occupancyIncrements"), ("visitHeatmap", "visitIncrements")):
        for item in delta[increments]:
            result[name]["counts"][item["index"]] += item["delta"]
        result[name]["maxCount"] = max(result[name]["counts"])
    trajectories = {item["agentId"]: item for item in result["trajectories"]}
    for agent_id in delta["removedTrajectoryAgentIds"]:
        trajectories.pop(agent_id, None)
    for item in delta["trajectoryReplacements"]:
        trajectories[item["agentId"]] = deepcopy(item)
    for item in delta["trajectoryAppends"]:
        trajectories[item["agentId"]]["pointsCm"].extend(item["appendPointsCm"])
    for agent_id in delta["deactivatedTrajectoryAgentIds"]:
        if agent_id in trajectories:
            trajectories[agent_id]["active"] = False
    customers = {item["customerId"]: item for item in result["customers"]}
    for agent_id in delta["removedCustomerIds"]:
        customers.pop(agent_id, None)
    for item in delta["customerUpdates"]:
        customers[item["customerId"]] = item
    result["trajectories"] = sorted(trajectories.values(), key=lambda item: item["agentId"])
    result["customers"] = list(customers.values())
    return result


def test_large_cohort_keeps_stable_paths_and_all_customer_and_grid_statistics() -> None:
    recorder = FlowAnalyticsRecorder(_scene(width=10000))
    base = recorder.snapshot().model_dump(mode="json")
    seq = recorder.seq
    # More customers than either display limit: all active customers must retain
    # their distance/entry time, while only forty stable paths are sampled.
    for step in range(180):
        recorder.record_frame(_frame(step / 10, [(i, 50 + step * 20, 50) for i in reversed(range(120))]))
        assert set(recorder._trajectories) == set(range(40))
        assert len(recorder._customers) == 120
    delta = recorder.delta_since(seq)
    assert delta is not None
    assert _apply_delta(base, delta) == recorder.snapshot().model_dump(mode="json")
    assert sum(recorder.heatmap().counts) == 120 * 180
    assert all(customer.distanceCm == 179 * 20 for customer in recorder.customers())
    assert all(customer.entryTimeSeconds == 0 for customer in recorder.customers())
    assert all(len(path.pointsCm) <= 320 for path in recorder.trajectories())


def test_delta_replay_handles_admission_decimation_removal_and_customer_eviction() -> None:
    recorder = FlowAnalyticsRecorder(_scene(width=10000))
    base = recorder.snapshot().model_dump(mode="json")
    seq = recorder.seq
    for step in range(350):
        # First tracked agents leave; next active agents are admitted, without
        # resending any heatmap or losing active customers' accumulated history.
        ids = range(120) if step < 200 else range(30, 120)
        recorder.record_frame(_frame(step / 10, [(i, 50 + step * 20, 50) for i in ids]))
        if step % 13 == 0 or step == 349:
            delta = recorder.delta_since(seq)
            assert delta is not None
            base = _apply_delta(base, delta)
            expected = recorder.snapshot().model_dump(mode="json")
            assert base == expected
            seq = recorder.seq
    assert len(base["trajectories"]) == 40
    assert len(base["customers"]) == 100
    assert sum(recorder.heatmap().counts) == 200 * 120 + 150 * 90


def test_delta_history_boundaries_and_geometry_reset_require_correct_resync() -> None:
    from services.flow_analytics import MAX_DELTA_HISTORY

    recorder = FlowAnalyticsRecorder(_scene())
    start_seq = recorder.seq
    for step in range(MAX_DELTA_HISTORY):
        recorder.record_frame(_frame(step / 10, [(1, 50, 50)]))
    assert recorder.delta_since(start_seq) is not None
    recorder.record_frame(_frame(61, [(1, 50, 50)]))
    assert recorder.delta_since(start_seq) is None
    assert recorder.delta_since(start_seq + 1) is not None
    assert recorder.delta_since(recorder.seq + 1) is None
    assert recorder.delta_since(recorder.seq)["customerUpdates"] == []
    seq = recorder.seq
    recorder.configure(_scene(width=2000))
    assert recorder.delta_since(seq) is None
    recorder.record_frame(_frame(62, [(1, 50, 50)]))
    assert recorder.delta_since(seq) is None
    assert sum(recorder.heatmap().counts) == 1


def test_delta_includes_first_point_after_snapshot_omits_stationary_path() -> None:
    recorder = FlowAnalyticsRecorder(_scene())
    recorder.record_frame(_frame(0, [(1, 50, 50)]))
    base = recorder.snapshot().model_dump(mode="json")
    assert base["trajectories"] == []
    seq = recorder.seq
    recorder.record_frame(_frame(0.1, [(1, 100, 50)]))
    assert _apply_delta(base, recorder.delta_since(seq)) == recorder.snapshot().model_dump(mode="json")


def test_queue_wait_metrics_track_time_spent_in_the_queue() -> None:
    stage = _FakeQueueStage()
    runtime = _WaypointRuntime(
        waypoint=SimulationWaypoint(id="wp", x=0.0, z=0.0, retentionSeconds=2.0),
        stage_id=1,
        stage=stage,
        release_interval_s=2.0,
    )

    stage.queue = [10, 11]
    _tick_queue_runtime(runtime, 0.0)
    metrics = queue_wait_metrics(runtime, 1.0)
    assert metrics["queuedAgents"] == 2
    assert metrics["completedWaits"] == 0
    assert metrics["currentMaxWaitSeconds"] == 1.0

    # Agent 10 reaches its full retention time and is released.
    _tick_queue_runtime(runtime, 2.0)
    assert stage.queue == [11]
    metrics = queue_wait_metrics(runtime, 2.0)
    assert metrics["completedWaits"] == 1
    assert metrics["averageWaitSeconds"] == 2.0
    assert metrics["maxWaitSeconds"] == 2.0
    assert metrics["queuedAgents"] == 1


def test_queue_wait_metrics_without_runtime_are_zeroed() -> None:
    metrics = queue_wait_metrics(None, 12.0)
    assert metrics == {
        "queuedAgents": 0,
        "completedWaits": 0,
        "averageWaitSeconds": 0.0,
        "maxWaitSeconds": 0.0,
        "currentMaxWaitSeconds": 0.0,
    }

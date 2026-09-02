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

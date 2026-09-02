"""Spatial analytics for pedestrian flow simulations.

Accumulates two visual analytics layers from simulation frames:

* a **heatmap** of agent occupancy — how many agent samples fell in each cell of
  a regular grid covering the store floor;
* a **visit grid** counting how many times an agent *entered* each cell, which
  divided by the elapsed time gives an absolute client flow (persons/second)
  that does not depend on the tick rate;
* the **trajectories** followed by the agents, as polylines in store
  coordinates (cm).

Both are recorded incrementally so a live session keeps the full history even
though only a small window of frames is sent back to the client.
"""

from __future__ import annotations

from models.project import (
    AgentTrajectory,
    SceneData,
    SimulationAnalytics,
    SimulationFrame,
    SimulationHeatmap,
)

DEFAULT_HEATMAP_CELL_CM = 50.0
# Bound the grid so the payload stays small on very large stores.
MAX_HEATMAP_CELLS_PER_AXIS = 120
# Only the most recent agents keep a trajectory: older ones are dropped so the
# response size stays constant over long sessions.
MAX_TRACKED_TRAJECTORIES = 40
MAX_TRAJECTORY_POINTS = 160
# Minimum distance between two recorded trajectory points.
TRAJECTORY_MIN_STEP_CM = 15.0


def _grid_geometry(scene: SceneData, cell_size_cm: float) -> tuple[float, float, float, int, int]:
    origin_x = float(scene.store.position[0]) if scene.store.position else 0.0
    origin_z = float(scene.store.position[2]) if scene.store.position else 0.0
    width_cm = max(1.0, float(scene.store.dimensions["width"]))
    depth_cm = max(1.0, float(scene.store.dimensions["depth"]))
    cell = max(1.0, float(cell_size_cm))
    cell = max(cell, width_cm / MAX_HEATMAP_CELLS_PER_AXIS, depth_cm / MAX_HEATMAP_CELLS_PER_AXIS)
    cols = max(1, int(width_cm // cell) + 1)
    rows = max(1, int(depth_cm // cell) + 1)
    return origin_x, origin_z, cell, cols, rows


class FlowAnalyticsRecorder:
    """Incrementally builds the occupancy heatmap and the agent trajectories."""

    def __init__(self, scene: SceneData, cell_size_cm: float = DEFAULT_HEATMAP_CELL_CM) -> None:
        self._requested_cell_cm = float(cell_size_cm)
        self._trajectories: dict[int, list[float]] = {}
        self._active_agents: set[int] = set()
        self._agent_cells: dict[int, int] = {}
        self._time_seconds = 0.0
        self._max_count = 0
        self.configure(scene)

    def configure(self, scene: SceneData) -> None:
        """(Re)build the grid for ``scene``; counts are reset when it changes."""
        origin_x, origin_z, cell, cols, rows = _grid_geometry(scene, self._requested_cell_cm)
        unchanged = (
            getattr(self, "_cols", None) == cols
            and getattr(self, "_rows", None) == rows
            and getattr(self, "_cell_cm", None) == cell
            and getattr(self, "_origin_x", None) == origin_x
            and getattr(self, "_origin_z", None) == origin_z
        )
        if unchanged:
            return
        self._origin_x = origin_x
        self._origin_z = origin_z
        self._cell_cm = cell
        self._cols = cols
        self._rows = rows
        self._counts = [0] * (cols * rows)
        self._visit_counts = [0] * (cols * rows)
        self._max_count = 0
        self._max_visit_count = 0
        self._agent_cells = {}

    def record_frame(self, frame: SimulationFrame) -> None:
        self._time_seconds = float(frame.timeSeconds)
        seen: set[int] = set()
        for agent in frame.agents:
            seen.add(int(agent.id))
            self._record_occupancy(float(agent.xCm), float(agent.zCm))
            self._record_visit(int(agent.id), float(agent.xCm), float(agent.zCm))
            self._record_trajectory_point(int(agent.id), float(agent.xCm), float(agent.zCm))
        self._active_agents = seen
        for agent_id in [agent_id for agent_id in self._agent_cells if agent_id not in seen]:
            del self._agent_cells[agent_id]
        self._evict_old_trajectories()

    def _record_occupancy(self, x_cm: float, z_cm: float) -> None:
        col = int((x_cm - self._origin_x) // self._cell_cm)
        row = int((z_cm - self._origin_z) // self._cell_cm)
        if col < 0 or row < 0 or col >= self._cols or row >= self._rows:
            return
        index = row * self._cols + col
        self._counts[index] += 1
        if self._counts[index] > self._max_count:
            self._max_count = self._counts[index]

    def _cell_index(self, x_cm: float, z_cm: float) -> int | None:
        col = int((x_cm - self._origin_x) // self._cell_cm)
        row = int((z_cm - self._origin_z) // self._cell_cm)
        if col < 0 or row < 0 or col >= self._cols or row >= self._rows:
            return None
        return row * self._cols + col

    def _record_visit(self, agent_id: int, x_cm: float, z_cm: float) -> None:
        """Count one visit each time an agent steps into a new cell."""
        index = self._cell_index(x_cm, z_cm)
        if index is None:
            self._agent_cells.pop(agent_id, None)
            return
        if self._agent_cells.get(agent_id) == index:
            return
        self._agent_cells[agent_id] = index
        self._visit_counts[index] += 1
        if self._visit_counts[index] > self._max_visit_count:
            self._max_visit_count = self._visit_counts[index]

    def _record_trajectory_point(self, agent_id: int, x_cm: float, z_cm: float) -> None:
        points = self._trajectories.get(agent_id)
        if points is None:
            self._trajectories[agent_id] = [round(x_cm, 1), round(z_cm, 1)]
            return
        last_x = points[-2]
        last_z = points[-1]
        if abs(x_cm - last_x) < TRAJECTORY_MIN_STEP_CM and abs(z_cm - last_z) < TRAJECTORY_MIN_STEP_CM:
            return
        points.append(round(x_cm, 1))
        points.append(round(z_cm, 1))
        if len(points) > MAX_TRAJECTORY_POINTS * 2:
            # Halve the resolution instead of truncating so the whole path shape
            # is preserved for the rest of the session.
            pair_count = len(points) // 2
            decimated: list[float] = []
            for pair_index in range(0, pair_count - 1, 2):
                decimated.append(points[pair_index * 2])
                decimated.append(points[pair_index * 2 + 1])
            decimated.append(points[-2])
            decimated.append(points[-1])
            self._trajectories[agent_id] = decimated

    def _evict_old_trajectories(self) -> None:
        if len(self._trajectories) <= MAX_TRACKED_TRAJECTORIES:
            return
        # Drop the oldest finished agents first (dict keeps insertion order).
        for agent_id in list(self._trajectories):
            if len(self._trajectories) <= MAX_TRACKED_TRAJECTORIES:
                break
            if agent_id not in self._active_agents:
                del self._trajectories[agent_id]
        while len(self._trajectories) > MAX_TRACKED_TRAJECTORIES:
            del self._trajectories[next(iter(self._trajectories))]

    def heatmap(self) -> SimulationHeatmap:
        return SimulationHeatmap(
            cellSizeCm=self._cell_cm,
            originXCm=self._origin_x,
            originZCm=self._origin_z,
            cols=self._cols,
            rows=self._rows,
            maxCount=self._max_count,
            counts=list(self._counts),
        )

    def visit_heatmap(self) -> SimulationHeatmap:
        """Grid of agent entries per cell (persons, not person-samples)."""
        return SimulationHeatmap(
            cellSizeCm=self._cell_cm,
            originXCm=self._origin_x,
            originZCm=self._origin_z,
            cols=self._cols,
            rows=self._rows,
            maxCount=self._max_visit_count,
            counts=list(self._visit_counts),
        )

    def trajectories(self) -> list[AgentTrajectory]:
        return [
            AgentTrajectory(
                agentId=agent_id,
                active=agent_id in self._active_agents,
                pointsCm=list(points),
            )
            for agent_id, points in self._trajectories.items()
            if len(points) >= 4
        ]

    def snapshot(self) -> SimulationAnalytics:
        return SimulationAnalytics(
            timeSeconds=round(self._time_seconds, 2),
            heatmap=self.heatmap(),
            visitHeatmap=self.visit_heatmap(),
            trajectories=self.trajectories(),
        )


def build_analytics(
    scene: SceneData,
    frames: list[SimulationFrame],
    cell_size_cm: float = DEFAULT_HEATMAP_CELL_CM,
) -> SimulationAnalytics:
    """Build analytics for a completed (batch) simulation."""
    recorder = FlowAnalyticsRecorder(scene, cell_size_cm=cell_size_cm)
    for frame in frames:
        recorder.record_frame(frame)
    return recorder.snapshot()

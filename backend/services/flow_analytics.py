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

from collections import deque

from models.project import (
    AgentTrajectory,
    CustomerJourney,
    SceneData,
    SimulationAnalytics,
    SimulationFrame,
    SimulationHeatmap,
)

DEFAULT_HEATMAP_CELL_CM = 50.0
# Bound the grid so the payload stays small on very large stores.
MAX_HEATMAP_CELLS_PER_AXIS = 120
# Keep a stable cohort of active trajectories, replacing finished agents first.
MAX_TRACKED_TRAJECTORIES = 40
MAX_TRAJECTORY_POINTS = 160
MAX_TRACKED_CUSTOMERS = 100
# Minimum distance between two recorded trajectory points.
TRAJECTORY_MIN_STEP_CM = 15.0
MAX_DELTA_HISTORY = 600


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
        self._customers: dict[int, CustomerJourney] = {}
        self._last_positions: dict[int, tuple[float, float]] = {}
        self._time_seconds = 0.0
        self._max_count = 0
        self._seq = 0
        self._delta_history: deque[dict] = deque(maxlen=MAX_DELTA_HISTORY)
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
        self._seq += 1
        self._reset_seq = self._seq
        self._delta_history.clear()

    def record_frame(self, frame: SimulationFrame) -> None:
        self._time_seconds = float(frame.timeSeconds)
        occupancy_increments: dict[int, int] = {}
        visit_increments: dict[int, int] = {}
        trajectory_appends: dict[int, list[float]] = {}
        trajectory_replacements: dict[int, list[float]] = {}
        customer_updates: dict[int, None] = {}
        previous_active = set(self._active_agents)
        seen = {int(agent.id) for agent in frame.agents}
        removed_trajectories = self._select_trajectories(seen)
        for agent in frame.agents:
            agent_id = int(agent.id)
            self._record_customer(agent_id, float(agent.xCm), float(agent.zCm), float(frame.timeSeconds))
            customer_updates[agent_id] = None
            occupancy_index = self._record_occupancy(float(agent.xCm), float(agent.zCm))
            if occupancy_index is not None:
                occupancy_increments[occupancy_index] = occupancy_increments.get(occupancy_index, 0) + 1
            visit_index = self._record_visit(int(agent.id), float(agent.xCm), float(agent.zCm))
            if visit_index is not None:
                visit_increments[visit_index] = visit_increments.get(visit_index, 0) + 1
            if agent_id not in self._trajectories:
                continue
            previous_length = len(self._trajectories[agent_id])
            appended = self._record_trajectory_point(agent_id, float(agent.xCm), float(agent.zCm))
            points = self._trajectories[agent_id]
            # Snapshots omit single-point paths. Publish their full path when
            # they become visible, and replace rather than append on decimation.
            if len(points) >= 4 and (
                previous_length < 4 or len(points) < previous_length or agent_id not in previous_active
            ):
                trajectory_replacements[agent_id] = list(points)
                continue
            if appended:
                trajectory_appends[agent_id] = appended
        self._active_agents = seen
        for agent_id in [agent_id for agent_id in self._agent_cells if agent_id not in seen]:
            del self._agent_cells[agent_id]
        for agent_id, customer in self._customers.items():
            if agent_id not in seen and customer.active:
                customer.active = False
                customer.exitTimeSeconds = float(frame.timeSeconds)
                customer.totalTimeSeconds = round(customer.exitTimeSeconds - customer.entryTimeSeconds, 2)
                self._last_positions.pop(agent_id, None)
                customer_updates[agent_id] = None
        deactivated = sorted((previous_active - seen) & self._trajectories.keys())
        removed_customers = self._evict_old_customers()
        for agent_id in removed_customers:
            customer_updates.pop(agent_id, None)
        self._seq += 1
        self._delta_history.append(
            {
                "seq": self._seq,
                "timeSeconds": round(self._time_seconds, 2),
                "occupancyIncrements": occupancy_increments,
                "visitIncrements": visit_increments,
                "trajectoryAppends": trajectory_appends,
                "trajectoryReplacements": trajectory_replacements,
                "removedTrajectoryAgentIds": removed_trajectories,
                "removedCustomerIds": removed_customers,
                "deactivatedTrajectoryAgentIds": deactivated,
                # Consumers need the latest state, not a copy of every active
                # customer's growing statistics at every physics step.
                "customerUpdates": list(customer_updates),
            }
        )

    def _record_customer(self, agent_id: int, x_cm: float, z_cm: float, time_seconds: float) -> None:
        customer = self._customers.get(agent_id)
        if customer is None:
            customer = CustomerJourney(
                customerId=agent_id,
                entryTimeSeconds=round(time_seconds, 2),
                totalTimeSeconds=0.0,
            )
            self._customers[agent_id] = customer
        previous = self._last_positions.get(agent_id)
        if previous is not None:
            customer.distanceCm = round(customer.distanceCm + ((x_cm - previous[0]) ** 2 + (z_cm - previous[1]) ** 2) ** 0.5, 2)
        customer.totalTimeSeconds = round(time_seconds - customer.entryTimeSeconds, 2)
        customer.active = True
        customer.exitTimeSeconds = None
        self._last_positions[agent_id] = (x_cm, z_cm)

    def _evict_old_customers(self) -> list[int]:
        evicted = []
        for oldest_id in list(self._customers):
            if len(self._customers) <= MAX_TRACKED_CUSTOMERS:
                break
            if self._customers[oldest_id].active:
                continue
            del self._customers[oldest_id]
            self._last_positions.pop(oldest_id, None)
            evicted.append(oldest_id)
        return evicted

    def _record_occupancy(self, x_cm: float, z_cm: float) -> int | None:
        col = int((x_cm - self._origin_x) // self._cell_cm)
        row = int((z_cm - self._origin_z) // self._cell_cm)
        if col < 0 or row < 0 or col >= self._cols or row >= self._rows:
            return None
        index = row * self._cols + col
        self._counts[index] += 1
        if self._counts[index] > self._max_count:
            self._max_count = self._counts[index]
        return index

    def _cell_index(self, x_cm: float, z_cm: float) -> int | None:
        col = int((x_cm - self._origin_x) // self._cell_cm)
        row = int((z_cm - self._origin_z) // self._cell_cm)
        if col < 0 or row < 0 or col >= self._cols or row >= self._rows:
            return None
        return row * self._cols + col

    def _record_visit(self, agent_id: int, x_cm: float, z_cm: float) -> int | None:
        """Count one visit each time an agent steps into a new cell."""
        index = self._cell_index(x_cm, z_cm)
        if index is None:
            self._agent_cells.pop(agent_id, None)
            return None
        if self._agent_cells.get(agent_id) == index:
            return None
        self._agent_cells[agent_id] = index
        self._visit_counts[index] += 1
        if self._visit_counts[index] > self._max_visit_count:
            self._max_visit_count = self._visit_counts[index]
        return index

    def _record_trajectory_point(self, agent_id: int, x_cm: float, z_cm: float) -> list[float]:
        points = self._trajectories.get(agent_id)
        if not points:
            pair = [round(x_cm, 1), round(z_cm, 1)]
            self._trajectories[agent_id] = pair
            return []
        last_x = points[-2]
        last_z = points[-1]
        if abs(x_cm - last_x) < TRAJECTORY_MIN_STEP_CM and abs(z_cm - last_z) < TRAJECTORY_MIN_STEP_CM:
            return []
        appended = [round(x_cm, 1), round(z_cm, 1)]
        points.extend(appended)
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
            return []
        return appended

    def _select_trajectories(self, seen: set[int]) -> list[int]:
        inactive = deque(agent_id for agent_id in self._trajectories if agent_id not in seen)
        removed = []
        for agent_id in sorted(seen - self._trajectories.keys()):
            if len(self._trajectories) >= MAX_TRACKED_TRAJECTORIES:
                if not inactive:
                    break
                oldest_id = inactive.popleft()
                del self._trajectories[oldest_id]
                removed.append(oldest_id)
            self._trajectories[agent_id] = []
        return removed

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

    def customers(self) -> list[CustomerJourney]:
        return list(self._customers.values())

    def snapshot(self) -> SimulationAnalytics:
        return SimulationAnalytics(
            timeSeconds=round(self._time_seconds, 2),
            heatmap=self.heatmap(),
            visitHeatmap=self.visit_heatmap(),
            trajectories=self.trajectories(),
            customers=self.customers(),
        )

    @property
    def seq(self) -> int:
        return self._seq

    def delta_since(self, since_seq: int) -> dict | None:
        if since_seq > self._seq or since_seq < self._reset_seq:
            return None
        if since_seq == self._seq:
            return {
                "timeSeconds": round(self._time_seconds, 2),
                "occupancyIncrements": [],
                "visitIncrements": [],
                "trajectoryAppends": [],
                "trajectoryReplacements": [],
                "removedTrajectoryAgentIds": [],
                "removedCustomerIds": [],
                "deactivatedTrajectoryAgentIds": [],
                "customerUpdates": [],
            }
        if not self._delta_history:
            return None
        oldest_seq = int(self._delta_history[0]["seq"])
        if since_seq < oldest_seq - 1:
            return None
        occupancy_increments: dict[int, int] = {}
        visit_increments: dict[int, int] = {}
        trajectory_appends: dict[int, list[float]] = {}
        trajectory_replacements: dict[int, list[float]] = {}
        removed_trajectories: set[int] = set()
        removed_customers: set[int] = set()
        customer_updates: dict[int, None] = {}
        deactivated: set[int] = set()
        time_seconds = round(self._time_seconds, 2)
        for delta in self._delta_history:
            seq = int(delta["seq"])
            if seq <= since_seq:
                continue
            time_seconds = float(delta["timeSeconds"])
            for index, value in delta["occupancyIncrements"].items():
                occupancy_increments[int(index)] = occupancy_increments.get(int(index), 0) + int(value)
            for index, value in delta["visitIncrements"].items():
                visit_increments[int(index)] = visit_increments.get(int(index), 0) + int(value)
            for agent_id, appended in delta["trajectoryAppends"].items():
                target = trajectory_replacements if agent_id in trajectory_replacements else trajectory_appends
                target.setdefault(agent_id, []).extend(appended)
            for agent_id, points in delta["trajectoryReplacements"].items():
                trajectory_appends.pop(agent_id, None)
                trajectory_replacements[agent_id] = list(points)
                deactivated.discard(agent_id)
            for agent_id in delta["removedTrajectoryAgentIds"]:
                trajectory_appends.pop(agent_id, None)
                trajectory_replacements.pop(agent_id, None)
                deactivated.discard(agent_id)
                removed_trajectories.add(agent_id)
            for agent_id in delta["deactivatedTrajectoryAgentIds"]:
                deactivated.add(int(agent_id))
            for agent_id in delta["customerUpdates"]:
                customer_updates[agent_id] = None
            for agent_id in delta["removedCustomerIds"]:
                customer_updates.pop(agent_id, None)
                removed_customers.add(agent_id)
        return {
            "timeSeconds": round(time_seconds, 2),
            "occupancyIncrements": [
                {"index": index, "delta": value}
                for index, value in occupancy_increments.items()
                if value != 0
            ],
            "visitIncrements": [
                {"index": index, "delta": value}
                for index, value in visit_increments.items()
                if value != 0
            ],
            "trajectoryAppends": [
                {
                    "agentId": agent_id,
                    "appendPointsCm": points,
                }
                for agent_id, points in trajectory_appends.items()
                if points
            ],
            "deactivatedTrajectoryAgentIds": sorted(deactivated),
            "trajectoryReplacements": [
                {"agentId": agent_id, "active": agent_id in self._active_agents, "pointsCm": points}
                for agent_id, points in trajectory_replacements.items()
            ],
            "removedTrajectoryAgentIds": sorted(removed_trajectories),
            "removedCustomerIds": sorted(removed_customers),
            "customerUpdates": [
                self._customers[agent_id].model_dump(mode="json")
                for agent_id in customer_updates
                if agent_id in self._customers
            ],
        }


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

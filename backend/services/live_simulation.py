from __future__ import annotations

import random
import threading
from dataclasses import dataclass
from time import time
from typing import Any
from uuid import uuid4

import services.simulation as simsvc
from models.project import (
    SceneData,
    SimulationAgentFrame,
    SimulationConfig,
    SimulationFrame,
    SimulationResult,
    SimulationSummary,
    SimulationWaypoint,
    WaypointMetrics,
)

if simsvc.jps is None:  # pragma: no cover - validated at runtime in endpoints
    jps = None
else:
    jps = simsvc.jps


@dataclass
class _LiveAgentRoute:
    stable_id: int
    desired_speed: float
    route_tokens: list[str]
    token_index: int = 0


class LiveSimulationSession:
    def __init__(self, scene: SceneData, config: SimulationConfig):
        if jps is None:
            raise RuntimeError("JuPedSim is not installed on the backend")
        self.id = str(uuid4())
        self.lock = threading.Lock()
        self.scene = scene
        self.config = config
        self.rng = random.Random(int(config.randomSeed))
        self.time_seconds = 0.0
        self.paused = False
        self.spawned = 0
        self.completed = 0
        self.next_stable_agent_id = 1
        self.next_arrival_at: float | None = None
        self.frames: list[SimulationFrame] = []
        self.agent_speeds: dict[int, float] = {}
        self.frozen_agents: set[int] = set()
        self.agent_routes: dict[int, _LiveAgentRoute] = {}
        self.stage_to_token: dict[int, str] = {}
        self.token_to_stage: dict[str, int] = {}
        self.waypoint_stage_ids: dict[str, int] = {}
        self.exit_stage_ids: dict[str, int] = {}
        self.waypoint_by_stage_id: dict[int, SimulationWaypoint] = {}
        self.waypoint_runtimes: dict[str, simsvc._WaypointRuntime] = {}
        self.metrics_waypoints: list[SimulationWaypoint] = []
        self.waypoint_series: dict[str, list[Any]] = {}
        self.average_load_accumulator = 0.0
        self.average_load_samples = 0
        self.max_waypoint_load = 0
        self._init_runtime(carry_agents=[])
        self._capture_frame()

    @property
    def active_agents(self) -> int:
        return int(self.sim.agent_count())

    def _token_for_exit_stage(self, exit_waypoint_id: str) -> str:
        return f"exit_hidden:{exit_waypoint_id}"

    def _build_route_tokens(self, spawn_index: int) -> list[str]:
        selected_entry = self.entries[spawn_index % len(self.entries)]
        tokens: list[str] = [selected_entry.id]
        for waypoint in self.transit_waypoints:
            if (not waypoint.optional) or self.rng.random() <= float(waypoint.visitProbability):
                tokens.append(waypoint.id)
        selected_exit = self.exits[spawn_index % len(self.exits)]
        tokens.append(selected_exit.id)
        tokens.append(self._token_for_exit_stage(selected_exit.id))
        return tokens

    def _route_tokens_to_stage_ids(self, tokens: list[str]) -> list[int]:
        return [self.token_to_stage[token] for token in tokens if token in self.token_to_stage]

    def _init_runtime(self, carry_agents: list[tuple[_LiveAgentRoute, tuple[float, float]]]) -> None:
        self.walkable = simsvc._build_walkable_geometry(self.scene)
        self.entries, self.transit_waypoints, self.exits = simsvc._partition_waypoints(self.scene, self.config)
        simsvc._validate_waypoint_constraints([*self.entries, *self.transit_waypoints, *self.exits], self.walkable)
        self.sim = jps.Simulation(
            model=jps.CollisionFreeSpeedModel(),
            geometry=self.walkable,
            dt=simsvc.SIMULATION_DT_S,
        )
        self.waypoint_stage_ids = {}
        self.exit_stage_ids = {}
        self.waypoint_by_stage_id = {}
        self.waypoint_runtimes = {}
        self.metrics_waypoints = [*self.entries, *self.transit_waypoints, *self.exits]
        self.stage_to_token = {}
        self.token_to_stage = {}

        for waypoint in self.metrics_waypoints:
            if waypoint.type == "exit":
                approach_stage_id = self.sim.add_waypoint_stage(
                    simsvc._safe_waypoint_point(
                        waypoint,
                        self.walkable,
                        clearance_cm=simsvc._waypoint_constraint_clearance_cm(waypoint),
                    ),
                    simsvc._cm_to_m(max(40.0, waypoint.radiusCm)),
                )
                self.waypoint_stage_ids[waypoint.id] = approach_stage_id
                self.waypoint_by_stage_id[approach_stage_id] = waypoint
                self.stage_to_token[approach_stage_id] = waypoint.id
                self.token_to_stage[waypoint.id] = approach_stage_id

                exit_stage_id = self.sim.add_exit_stage(simsvc._waypoint_exit_polygon(waypoint, self.walkable))
                self.exit_stage_ids[waypoint.id] = exit_stage_id
                exit_token = self._token_for_exit_stage(waypoint.id)
                self.stage_to_token[exit_stage_id] = exit_token
                self.token_to_stage[exit_token] = exit_stage_id
            elif waypoint.retentionSeconds > 0:
                stage_id = self.sim.add_queue_stage(simsvc._queue_slot_positions(waypoint, self.walkable))
                runtime = simsvc._WaypointRuntime(
                    waypoint=waypoint,
                    stage_id=stage_id,
                    stage=self.sim.get_stage(stage_id),
                    release_interval_s=float(waypoint.retentionSeconds),
                )
                self.waypoint_runtimes[waypoint.id] = runtime
                self.waypoint_stage_ids[waypoint.id] = stage_id
                self.waypoint_by_stage_id[stage_id] = waypoint
                self.stage_to_token[stage_id] = waypoint.id
                self.token_to_stage[waypoint.id] = stage_id
            else:
                stage_id = self.sim.add_waypoint_stage(
                    simsvc._safe_waypoint_point(
                        waypoint,
                        self.walkable,
                        clearance_cm=simsvc._waypoint_constraint_clearance_cm(waypoint),
                    ),
                    simsvc._cm_to_m(max(40.0, waypoint.radiusCm)),
                )
                self.waypoint_stage_ids[waypoint.id] = stage_id
                self.waypoint_by_stage_id[stage_id] = waypoint
                self.stage_to_token[stage_id] = waypoint.id
                self.token_to_stage[waypoint.id] = stage_id

        if not self.waypoint_series:
            self.waypoint_series = {waypoint.id: [] for waypoint in self.metrics_waypoints}
        else:
            for waypoint in self.metrics_waypoints:
                self.waypoint_series.setdefault(waypoint.id, [])

        old_routes = carry_agents
        self.agent_routes = {}
        self.agent_speeds = {}
        self.frozen_agents = set()
        for route_state, old_pos in old_routes:
            remaining_tokens = route_state.route_tokens[route_state.token_index :]
            stage_ids = self._route_tokens_to_stage_ids(remaining_tokens)
            if len(stage_ids) < 2:
                fallback_exit = self.exits[0]
                remaining_tokens = [fallback_exit.id, self._token_for_exit_stage(fallback_exit.id)]
                stage_ids = self._route_tokens_to_stage_ids(remaining_tokens)
            if len(stage_ids) < 2:
                continue
            position = simsvc._closest_walkable_point(old_pos, self.walkable)
            journey = jps.JourneyDescription(stage_ids)
            for from_stage, to_stage in zip(stage_ids[:-1], stage_ids[1:]):
                journey.set_transition_for_stage(from_stage, jps.Transition.create_fixed_transition(to_stage))
            journey_id = self.sim.add_journey(journey)
            desired_speed = max(0.5, float(route_state.desired_speed))
            new_agent_id = self.sim.add_agent(
                simsvc._build_agent_params(
                    journey_id=journey_id,
                    stage_id=stage_ids[0],
                    position=position,
                    desired_speed=desired_speed,
                )
            )
            self.agent_routes[new_agent_id] = _LiveAgentRoute(
                stable_id=route_state.stable_id,
                desired_speed=desired_speed,
                route_tokens=remaining_tokens,
                token_index=0,
            )
            self.agent_speeds[new_agent_id] = desired_speed
            self.next_stable_agent_id = max(self.next_stable_agent_id, route_state.stable_id + 1)

    def _ensure_next_arrival(self) -> None:
        rate = max(0.0, float(self.config.arrivalRatePerSecond))
        if rate <= 0:
            self.next_arrival_at = None
            return
        if self.next_arrival_at is None or self.next_arrival_at < self.time_seconds:
            self.next_arrival_at = self.time_seconds + self.rng.expovariate(rate)

    def _spawn_if_due(self) -> None:
        rate = max(0.0, float(self.config.arrivalRatePerSecond))
        if rate <= 0:
            self.next_arrival_at = None
            return
        self._ensure_next_arrival()
        max_customers = max(1, int(self.config.maxCustomers))
        step_spawn_positions: dict[str, list[tuple[float, float]]] = {}
        while (
            self.next_arrival_at is not None
            and self.next_arrival_at <= self.time_seconds
            and self.active_agents < max_customers
        ):
            tokens = self._build_route_tokens(self.spawned)
            stage_ids = self._route_tokens_to_stage_ids(tokens)
            if len(stage_ids) < 2:
                self.next_arrival_at = self.time_seconds + self.rng.expovariate(rate)
                continue
            journey = jps.JourneyDescription(stage_ids)
            for from_stage, to_stage in zip(stage_ids[:-1], stage_ids[1:]):
                journey.set_transition_for_stage(from_stage, jps.Transition.create_fixed_transition(to_stage))
            journey_id = self.sim.add_journey(journey)
            entry_wp = self.entries[self.spawned % len(self.entries)]
            occupied = step_spawn_positions.setdefault(entry_wp.id, [])
            spawn_position = simsvc._spawn_from_entry(entry_wp, self.walkable, self.rng, occupied)
            occupied.append(spawn_position)
            desired_speed = max(
                0.5,
                self.rng.gauss(float(self.config.desiredSpeedMps), float(self.config.speedVariation)),
            )
            agent_id = self.sim.add_agent(
                simsvc._build_agent_params(
                    journey_id=journey_id,
                    stage_id=stage_ids[0],
                    position=spawn_position,
                    desired_speed=desired_speed,
                )
            )
            stable_id = self.next_stable_agent_id
            self.next_stable_agent_id += 1
            self.agent_routes[agent_id] = _LiveAgentRoute(
                stable_id=stable_id,
                desired_speed=desired_speed,
                route_tokens=tokens,
                token_index=0,
            )
            self.agent_speeds[agent_id] = desired_speed
            self.spawned += 1
            self.next_arrival_at = self.time_seconds + self.rng.expovariate(rate)

    def _update_agent_route_indices(self) -> None:
        for agent in self.sim.agents():
            agent_id = int(agent.id)
            route = self.agent_routes.get(agent_id)
            if route is None:
                continue
            token = self.stage_to_token.get(int(agent.stage_id))
            if token is None:
                continue
            for idx in range(route.token_index, len(route.route_tokens)):
                if route.route_tokens[idx] == token:
                    route.token_index = idx
                    break

    def _capture_frame(self) -> None:
        frame_agents: list[SimulationAgentFrame] = []
        for agent in self.sim.agents():
            route = self.agent_routes.get(int(agent.id))
            if route is None:
                continue
            heading_x, heading_z = agent.orientation
            vision_angle_deg, vision_range_cm = simsvc._vision_for_agent(
                self.config,
                self.waypoint_by_stage_id.get(int(agent.stage_id)),
            )
            frame_agents.append(
                SimulationAgentFrame(
                    id=route.stable_id,
                    xCm=round(simsvc._m_to_cm(agent.position[0]), 2),
                    zCm=round(simsvc._m_to_cm(agent.position[1]), 2),
                    headingX=float(heading_x) if heading_x or heading_z else 1.0,
                    headingZ=float(heading_z),
                    visionAngleDeg=vision_angle_deg,
                    visionRangeCm=vision_range_cm,
                )
            )
        self.frames.append(
            SimulationFrame(timeSeconds=round(self.time_seconds, 2), agents=frame_agents)
        )
        waypoint_loads: list[int] = []
        for waypoint in self.metrics_waypoints:
            stage_id = self.waypoint_stage_ids.get(waypoint.id)
            if stage_id is None:
                continue
            stage = self.sim.get_stage(stage_id)
            current_agents = int(stage.count_targeting())
            runtime = self.waypoint_runtimes.get(waypoint.id)
            released_agents = runtime.released_agents if runtime is not None else 0
            waypoint_loads.append(current_agents)
            self.waypoint_series[waypoint.id].append(
                simsvc.WaypointSample(
                    timeSeconds=round(self.time_seconds, 2),
                    activeAgents=current_agents,
                    releasedAgents=released_agents,
                )
            )
        if waypoint_loads:
            self.average_load_accumulator += sum(waypoint_loads) / len(waypoint_loads)
            self.average_load_samples += 1
            self.max_waypoint_load = max(self.max_waypoint_load, max(waypoint_loads))

    def tick(self, steps: int = 1) -> SimulationResult:
        with self.lock:
            if self.paused:
                return self.snapshot()
            n_steps = max(1, int(steps))
            for _ in range(n_steps):
                self._spawn_if_due()
                for runtime in self.waypoint_runtimes.values():
                    simsvc._tick_queue_runtime(runtime, self.time_seconds)
                simsvc._freeze_retained_agents(
                    self.sim,
                    self.waypoint_runtimes,
                    self.agent_speeds,
                    self.frozen_agents,
                )
                self.sim.iterate()
                simsvc._apply_right_hand_bias(self.sim)
                removed_agent_ids = [int(agent_id) for agent_id in self.sim.removed_agents()]
                for removed_id in removed_agent_ids:
                    if removed_id in self.agent_routes:
                        self.completed += 1
                        del self.agent_routes[removed_id]
                    self.agent_speeds.pop(removed_id, None)
                    self.frozen_agents.discard(removed_id)
                self._update_agent_route_indices()
                self.time_seconds += simsvc.SIMULATION_DT_S
            self._capture_frame()
            return self.snapshot()

    def set_paused(self, paused: bool) -> SimulationResult:
        with self.lock:
            self.paused = paused
            return self.snapshot()

    def update(self, scene: SceneData, config: SimulationConfig) -> SimulationResult:
        with self.lock:
            carry_agents: list[tuple[_LiveAgentRoute, tuple[float, float]]] = []
            for agent in self.sim.agents():
                route = self.agent_routes.get(int(agent.id))
                if route is None:
                    continue
                carry_agents.append((route, (float(agent.position[0]), float(agent.position[1]))))
            self.scene = scene
            self.config = config
            self._init_runtime(carry_agents=carry_agents)
            self._capture_frame()
            return self.snapshot()

    def snapshot(self) -> SimulationResult:
        waypoint_metrics = [
            WaypointMetrics(
                waypointId=waypoint.id,
                waypointLabel=waypoint.label,
                waypointType=waypoint.type,
                retentionSeconds=float(waypoint.retentionSeconds),
                maxActiveAgents=max(
                    (sample.activeAgents for sample in self.waypoint_series.get(waypoint.id, [])),
                    default=0,
                ),
                releasedAgents=(
                    max(
                        (sample.releasedAgents for sample in self.waypoint_series.get(waypoint.id, [])),
                        default=0,
                    )
                    if waypoint.type != "exit"
                    else 0
                ),
                samples=self.waypoint_series.get(waypoint.id, []),
            )
            for waypoint in self.metrics_waypoints
        ]
        all_retentions = [
            float(waypoint.retentionSeconds)
            for waypoint in self.transit_waypoints
            if waypoint.retentionSeconds > 0
        ]
        summary = SimulationSummary(
            spawnedCustomers=self.spawned,
            completedCustomers=self.completed,
            activeCustomers=self.active_agents,
            averageWaypointLoad=round(
                self.average_load_accumulator / self.average_load_samples
                if self.average_load_samples
                else 0.0,
                2,
            ),
            maxWaypointLoad=self.max_waypoint_load,
            averageConfiguredRetentionSeconds=(
                round(sum(all_retentions) / len(all_retentions), 2) if all_retentions else 0.0
            ),
        )
        return SimulationResult(frames=self.frames, waypoints=waypoint_metrics, summary=summary)


class LiveSimulationManager:
    def __init__(self) -> None:
        self._sessions: dict[str, LiveSimulationSession] = {}
        self._lock = threading.Lock()

    def start(self, scene: SceneData, config: SimulationConfig) -> tuple[str, SimulationResult]:
        session = LiveSimulationSession(scene, config)
        with self._lock:
            self._sessions[session.id] = session
        return session.id, session.snapshot()

    def get(self, session_id: str) -> LiveSimulationSession:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(session_id)
        return session

    def stop(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def reap_idle(self, ttl_seconds: float = 900.0) -> None:
        cutoff = time() - ttl_seconds
        with self._lock:
            stale = [
                sid
                for sid, session in self._sessions.items()
                if (session.frames and session.frames[-1].timeSeconds < cutoff)
            ]
            for sid in stale:
                self._sessions.pop(sid, None)


live_simulation_manager = LiveSimulationManager()

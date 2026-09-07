from __future__ import annotations

import logging
import random
import threading
from dataclasses import dataclass
from time import time
from typing import Any
from uuid import uuid4

import services.simulation as simsvc
from models.project import (
    AgentBasket,
    AgentBasketItem,
    PedestrianPickupPlan,
    PickupEvent,
    SceneData,
    SimulationAgentFrame,
    SimulationAnalytics,
    SimulationConfig,
    SimulationFrame,
    SimulationResult,
    SimulationSummary,
    SimulationWaypoint,
    WaypointMetrics,
)
from services.flow_analytics import FlowAnalyticsRecorder

if simsvc.jps is None:  # pragma: no cover - validated at runtime in endpoints
    jps = None
else:
    jps = simsvc.jps

MAX_LIVE_FRAMES = 600
MAX_WAYPOINT_SAMPLES = 1200
# Only the most recent frames are needed by the client to interpolate smooth
# playback (it keeps a sub-second render buffer and never resnaps more than ~1 s
# behind the newest frame). Returning the whole growing history on every ~100 ms
# tick makes the JSON payload balloon over time, which janks the main thread and
# causes the stutter and teleport-through-furniture artefacts. Cap the returned
# window to a small, constant-size tail while keeping the full history server-side.
LIVE_RESPONSE_FRAME_WINDOW = 20
# Bound the per-waypoint sample series returned to the client so tick responses
# stay a constant size. The full series is kept server-side, so the aggregate
# metrics (peak load, released agents) remain computed over the whole session.
LIVE_RESPONSE_SAMPLE_WINDOW = 240


@dataclass
class _LiveAgentRoute:
    stable_id: int
    desired_speed: float
    route_tokens: list[str]
    token_index: int = 0
    # Set when this agent's journey was built from an imported pedestrian CSV
    # plan rather than the default Poisson arrival process.
    pedestrian_id: int | None = None


class LiveSimulationSession:
    def __init__(self, project_id: str, scene: SceneData, config: SimulationConfig):
        if jps is None:
            raise RuntimeError("JuPedSim is not installed on the backend")
        self.id = str(uuid4())
        self.project_id = project_id
        self.lock = threading.Lock()
        self.last_accessed_at = time()
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
        # Throughput of every waypoint type (queue runtimes only cover retention waypoints).
        self.passages = simsvc.WaypointPassageTracker()
        self.stage_to_waypoint_id: dict[int, str] = {}
        self.metrics_waypoints: list[SimulationWaypoint] = []
        self.waypoint_series: dict[str, list[Any]] = {}
        self.average_load_accumulator = 0.0
        self.average_load_samples = 0
        self.max_waypoint_load = 0
        self.analytics_recorder = FlowAnalyticsRecorder(scene)
        # Imported pedestrian CSV support (see services/pickup_planning.py):
        # when plans are loaded, spawning switches from the Poisson arrival
        # process to a schedule driven by each pedestrian's start_unix_ts.
        self.pedestrian_plans: list[PedestrianPickupPlan] = []
        self.pedestrian_cursor: int = 0
        self.pedestrian_sim_start_ts: int | None = None
        # token -> (ean, product name, pickup duration) for pickup waypoints,
        # so frame capture / basket lookup can resolve what an agent is doing.
        self.pickup_item_by_token: dict[str, tuple[str, str | None, float]] = {}
        # stable_id -> ordered basket, for the "click pedestrian" detail panel.
        self.agent_baskets: dict[int, PedestrianPickupPlan] = {}
        # stable_id -> {ean: (picked, pickedAtSeconds)}, updated on every pickup.
        self.basket_status: dict[int, dict[str, tuple[bool, float | None]]] = {}
        self.pending_pickup_events: list[PickupEvent] = []
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
        previous_queue_stats = {
            waypoint_id: (
                runtime.released_agents,
                runtime.completed_waits,
                runtime.total_wait_seconds,
                runtime.max_wait_seconds,
            )
            for waypoint_id, runtime in self.waypoint_runtimes.items()
        }
        self.waypoint_stage_ids = {}
        self.exit_stage_ids = {}
        self.waypoint_by_stage_id = {}
        self.waypoint_runtimes = {}
        self.next_arrival_at = None
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
                # Hot updates rebuild every stage: carry the cumulative queue
                # statistics over so the measured waiting times keep growing
                # instead of restarting from zero on each scene edit.
                carried = previous_queue_stats.get(waypoint.id)
                if carried is not None:
                    (
                        runtime.released_agents,
                        runtime.completed_waits,
                        runtime.total_wait_seconds,
                        runtime.max_wait_seconds,
                    ) = carried
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

        # Stage ids are rebuilt on every hot update: refresh the mapping and drop
        # the per-agent stage memory while keeping the cumulative passage counts.
        self.stage_to_waypoint_id = {
            stage_id: waypoint_id for waypoint_id, stage_id in self.waypoint_stage_ids.items()
        }
        self.passages.forget_agent_positions()

        if not self.waypoint_series:
            self.waypoint_series = {waypoint.id: [] for waypoint in self.metrics_waypoints}
        else:
            for waypoint in self.metrics_waypoints:
                self.waypoint_series.setdefault(waypoint.id, [])

        old_routes = carry_agents
        self.agent_routes = {}
        self.agent_speeds = {}
        self.frozen_agents = set()
        # Carried-over agents must be re-placed with the same agent-radius
        # clearance from walls that fresh spawns use.  When furniture is moved on
        # top of an existing agent, projecting onto the raw walkable boundary
        # would leave the agent flush against (or overlapping) the new obstacle,
        # which makes ``add_agent`` reject the position and raise.  A single such
        # failure would otherwise abort the whole hot-update and wipe every agent
        # that had not yet been re-added — i.e. pedestrians vanish completely.
        placement_walkable = (
            simsvc._walkable_with_clearance(
                self.walkable,
                simsvc.AGENT_RADIUS_CM + simsvc.BOUNDARY_CLEARANCE_EPSILON_CM,
            )
            or self.walkable
        )
        for route_state, old_pos in old_routes:
            remaining_tokens = route_state.route_tokens[route_state.token_index :]
            stage_ids = self._route_tokens_to_stage_ids(remaining_tokens)
            if len(stage_ids) < 2:
                fallback_exit = self.exits[0]
                remaining_tokens = [fallback_exit.id, self._token_for_exit_stage(fallback_exit.id)]
                stage_ids = self._route_tokens_to_stage_ids(remaining_tokens)
            if len(stage_ids) < 2:
                continue
            position = simsvc._closest_walkable_point(old_pos, placement_walkable)
            journey = jps.JourneyDescription(stage_ids)
            for from_stage, to_stage in zip(stage_ids[:-1], stage_ids[1:]):
                journey.set_transition_for_stage(from_stage, jps.Transition.create_fixed_transition(to_stage))
            journey_id = self.sim.add_journey(journey)
            desired_speed = max(0.5, float(route_state.desired_speed))
            try:
                new_agent_id = self.sim.add_agent(
                    simsvc._build_agent_params(
                        journey_id=journey_id,
                        stage_id=stage_ids[0],
                        position=position,
                        desired_speed=desired_speed,
                    )
                )
            except Exception:
                # Never let a single un-placeable agent abort the update and take
                # every other carried agent down with it. Skip this one instead.
                logging.getLogger(__name__).warning(
                    "live_simulation update: could not re-place carried agent %s at %s; skipping.",
                    route_state.stable_id,
                    position,
                )
                self.next_stable_agent_id = max(self.next_stable_agent_id, route_state.stable_id + 1)
                continue
            self.agent_routes[new_agent_id] = _LiveAgentRoute(
                stable_id=route_state.stable_id,
                desired_speed=desired_speed,
                route_tokens=remaining_tokens,
                token_index=0,
                pedestrian_id=route_state.pedestrian_id,
            )
            self.agent_speeds[new_agent_id] = desired_speed
            self.next_stable_agent_id = max(self.next_stable_agent_id, route_state.stable_id + 1)

        if self.pedestrian_plans:
            self._register_pedestrian_pickup_stages()

    def _ensure_next_arrival(self) -> None:
        rate = max(0.0, float(self.config.arrivalRatePerSecond))
        if rate <= 0:
            self.next_arrival_at = None
            return
        if self.next_arrival_at is None:
            # Ensure at least one customer appears right after launch when arrivals are enabled.
            if self.spawned == 0 and self.time_seconds == 0:
                self.next_arrival_at = self.time_seconds
            else:
                self.next_arrival_at = self.time_seconds + self.rng.expovariate(rate)

    def _spawn_if_due(self) -> None:
        if self.pedestrian_plans:
            self._spawn_pedestrians_if_due()
            return
        rate = max(0.0, float(self.config.arrivalRatePerSecond))
        if rate <= 0:
            self.next_arrival_at = None
            return
        self._ensure_next_arrival()
        max_customers = max(1, int(self.config.maxCustomers))
        step_spawn_positions = simsvc.current_agent_positions(self.sim)
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
            desired_speed = max(
                0.5,
                self.rng.gauss(float(self.config.desiredSpeedMps), float(self.config.speedVariation)),
            )
            try:
                agent_id, spawn_position = simsvc.add_agent_with_spawn_retry(
                    sim=self.sim,
                    waypoint=entry_wp,
                    walkable=self.walkable,
                    rng=self.rng,
                    occupied_positions=step_spawn_positions,
                    journey_id=journey_id,
                    stage_id=simsvc.initial_target_stage_id(stage_ids),
                    desired_speed=desired_speed,
                )
            except RuntimeError as exc:
                if simsvc.TOO_CLOSE_TO_AGENT_ERROR_SNIPPET not in str(exc):
                    raise
                logging.getLogger(__name__).warning(
                    "Skipping one live spawn near entry '%s' after placement retries: %s",
                    entry_wp.label,
                    exc,
                )
                self.next_arrival_at = self.time_seconds + self.rng.expovariate(rate)
                continue
            step_spawn_positions.append(spawn_position)
            stable_id = self.next_stable_agent_id
            self.next_stable_agent_id += 1
            self.agent_routes[agent_id] = _LiveAgentRoute(
                stable_id=stable_id,
                desired_speed=desired_speed,
                route_tokens=tokens,
                token_index=0,
            )
            self.agent_speeds[agent_id] = desired_speed
            # Agents start already past their entry (first target is the next
            # stage), so the entry throughput is credited at spawn time.
            self.passages.record_passage(entry_wp.id)
            self.spawned += 1
            self.next_arrival_at = self.time_seconds + self.rng.expovariate(rate)

    def load_pedestrian_plans(self, plans: list[PedestrianPickupPlan]) -> None:
        """Load an imported pedestrian CSV so spawning follows its schedule.

        Replaces the Poisson arrival process: pedestrians are spawned in
        ``start_unix_ts`` order, offset so the earliest one arrives at
        simulation time 0. Each pickup item resolved to a shelf position gets
        its own queue stage with a variable 1s-4s retention, inserted between
        the entry and exit of that pedestrian's journey.
        """
        with self.lock:
            ordered = sorted(plans, key=lambda plan: plan.startUnixTs)
            self.pedestrian_plans = ordered
            self.pedestrian_cursor = 0
            self.pedestrian_sim_start_ts = ordered[0].startUnixTs if ordered else None
            for plan in ordered:
                self.agent_baskets[plan.pedestrianId] = plan
                self.basket_status[plan.pedestrianId] = {
                    item.ean: (False, None) for item in plan.items
                }
            self._register_pedestrian_pickup_stages()

    def _register_pedestrian_pickup_stages(self) -> None:
        """Create (once) a queue stage for every resolved pickup item.

        Stages are registered in the same maps used for config waypoints so
        the existing queue-tick/freeze machinery drives them for free, but
        they are intentionally kept out of ``self.metrics_waypoints`` — one
        synthetic waypoint per (pedestrian, product) pair would otherwise
        make the per-tick metrics payload grow linearly with the CSV size.
        """
        for plan in self.pedestrian_plans:
            for index, item in enumerate(plan.items):
                if not item.found or item.xCm is None or item.zCm is None:
                    continue
                token = f"pickup:{plan.pedestrianId}:{index}"
                if token in self.token_to_stage:
                    continue
                waypoint = SimulationWaypoint(
                    id=token,
                    label=item.name or item.ean,
                    type="transit",
                    x=item.xCm,
                    z=item.zCm,
                    radiusCm=60.0,
                    optional=False,
                    visitProbability=1.0,
                    retentionSeconds=float(item.pickupDurationSeconds or 1.0),
                )
                stage_id = self.sim.add_queue_stage(
                    simsvc._queue_slot_positions(waypoint, self.walkable)
                )
                runtime = simsvc._WaypointRuntime(
                    waypoint=waypoint,
                    stage_id=stage_id,
                    stage=self.sim.get_stage(stage_id),
                    release_interval_s=float(waypoint.retentionSeconds),
                )
                self.waypoint_runtimes[token] = runtime
                self.waypoint_stage_ids[token] = stage_id
                self.waypoint_by_stage_id[stage_id] = waypoint
                self.stage_to_token[stage_id] = token
                self.token_to_stage[token] = stage_id
                self.stage_to_waypoint_id[stage_id] = token
                self.pickup_item_by_token[token] = (
                    item.ean,
                    item.name,
                    float(item.pickupDurationSeconds or 1.0),
                )

    def _pedestrian_route_tokens(self, plan: PedestrianPickupPlan, spawn_index: int) -> list[str]:
        entry = self.entries[spawn_index % len(self.entries)]
        tokens: list[str] = [entry.id]
        for index, item in enumerate(plan.items):
            token = f"pickup:{plan.pedestrianId}:{index}"
            if token in self.token_to_stage:
                tokens.append(token)
        exit_wp = self.exits[spawn_index % len(self.exits)]
        tokens.append(exit_wp.id)
        tokens.append(self._token_for_exit_stage(exit_wp.id))
        return tokens

    def _spawn_pedestrians_if_due(self) -> None:
        max_customers = max(1, int(self.config.maxCustomers))
        step_spawn_positions = simsvc.current_agent_positions(self.sim)
        while (
            self.pedestrian_cursor < len(self.pedestrian_plans)
            and self.active_agents < max_customers
        ):
            plan = self.pedestrian_plans[self.pedestrian_cursor]
            scheduled_at = float(plan.startUnixTs - (self.pedestrian_sim_start_ts or plan.startUnixTs))
            if scheduled_at > self.time_seconds:
                break
            tokens = self._pedestrian_route_tokens(plan, self.pedestrian_cursor)
            stage_ids = self._route_tokens_to_stage_ids(tokens)
            if len(stage_ids) < 2:
                self.pedestrian_cursor += 1
                continue
            journey = jps.JourneyDescription(stage_ids)
            for from_stage, to_stage in zip(stage_ids[:-1], stage_ids[1:]):
                journey.set_transition_for_stage(from_stage, jps.Transition.create_fixed_transition(to_stage))
            journey_id = self.sim.add_journey(journey)
            entry_wp = self.entries[self.pedestrian_cursor % len(self.entries)]
            desired_speed = max(0.3, float(plan.speedMps))
            try:
                agent_id, spawn_position = simsvc.add_agent_with_spawn_retry(
                    sim=self.sim,
                    waypoint=entry_wp,
                    walkable=self.walkable,
                    rng=self.rng,
                    occupied_positions=step_spawn_positions,
                    journey_id=journey_id,
                    stage_id=simsvc.initial_target_stage_id(stage_ids),
                    desired_speed=desired_speed,
                )
            except RuntimeError as exc:
                if simsvc.TOO_CLOSE_TO_AGENT_ERROR_SNIPPET not in str(exc):
                    raise
                # Leave the pedestrian at the head of the queue and retry next tick
                # instead of dropping them or spinning the whole loop on one blocker.
                logging.getLogger(__name__).warning(
                    "Skipping live spawn near entry '%s' this tick after placement retries: %s",
                    entry_wp.label,
                    exc,
                )
                break
            step_spawn_positions.append(spawn_position)
            stable_id = self.next_stable_agent_id
            self.next_stable_agent_id += 1
            self.agent_routes[agent_id] = _LiveAgentRoute(
                stable_id=stable_id,
                desired_speed=desired_speed,
                route_tokens=tokens,
                token_index=0,
                pedestrian_id=plan.pedestrianId,
            )
            self.agent_speeds[agent_id] = desired_speed
            self.agent_baskets[stable_id] = plan
            self.basket_status[stable_id] = {item.ean: (False, None) for item in plan.items}
            self.passages.record_passage(entry_wp.id)
            self.spawned += 1
            self.pedestrian_cursor += 1

    def basket_for(self, stable_id: int) -> AgentBasket | None:
        """Detail-panel payload for one pedestrian, by its stable agent id."""
        plan = self.agent_baskets.get(stable_id)
        if plan is None:
            return None
        status = self.basket_status.get(stable_id, {})
        active = any(route.stable_id == stable_id for route in self.agent_routes.values())
        items = []
        for item in plan.items:
            picked, picked_at = status.get(item.ean, (False, None))
            items.append(
                AgentBasketItem(
                    ean=item.ean,
                    name=item.name,
                    found=item.found,
                    reasonNotFound=item.reasonNotFound,
                    picked=picked,
                    pickedAtSeconds=picked_at,
                )
            )
        return AgentBasket(
            pedestrianId=plan.pedestrianId,
            agentId=stable_id,
            profile=plan.profile,
            items=items,
            active=active,
        )

    def list_baskets(self) -> list[AgentBasket]:
        """« Parcours client » panel payload: every pedestrian seen so far.

        Baskets are kept for the lifetime of the session even after a
        pedestrian has exited (``self.agent_baskets`` is never pruned), so
        this always reflects the full run, not just currently active agents.
        """
        with self.lock:
            baskets = [self.basket_for(stable_id) for stable_id in self.agent_baskets]
        return [basket for basket in baskets if basket is not None]

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
            picking_ean = picking_name = None
            picking_started_at = picking_duration = None
            token = self.stage_to_token.get(int(agent.stage_id))
            pickup_item = self.pickup_item_by_token.get(token) if token else None
            if pickup_item is not None:
                runtime = self.waypoint_runtimes.get(token)
                enqueued_at = runtime.enqueue_times.get(int(agent.id)) if runtime else None
                if enqueued_at is not None:
                    picking_ean, picking_name, picking_duration = pickup_item
                    picking_started_at = round(enqueued_at, 2)
            frame_agents.append(
                SimulationAgentFrame(
                    id=route.stable_id,
                    xCm=round(simsvc._m_to_cm(agent.position[0]), 2),
                    zCm=round(simsvc._m_to_cm(agent.position[1]), 2),
                    headingX=float(heading_x) if heading_x or heading_z else 1.0,
                    headingZ=float(heading_z),
                    visionAngleDeg=vision_angle_deg,
                    visionRangeCm=vision_range_cm,
                    pickingEan=picking_ean,
                    pickingProductName=picking_name,
                    pickingStartedAtSeconds=picking_started_at,
                    pickingDurationSeconds=picking_duration,
                )
            )
        self.frames.append(
            SimulationFrame(timeSeconds=round(self.time_seconds, 2), agents=frame_agents)
        )
        self.analytics_recorder.record_frame(self.frames[-1])
        if len(self.frames) > MAX_LIVE_FRAMES:
            self.frames = self.frames[-MAX_LIVE_FRAMES:]
        waypoint_loads: list[int] = []
        for waypoint in self.metrics_waypoints:
            stage_id = self.waypoint_stage_ids.get(waypoint.id)
            if stage_id is None:
                continue
            stage = self.sim.get_stage(stage_id)
            current_agents = int(stage.count_targeting())
            runtime = self.waypoint_runtimes.get(waypoint.id)
            released_agents = max(
                runtime.released_agents if runtime is not None else 0,
                self.passages.released(waypoint.id),
            )
            waypoint_loads.append(current_agents)
            self.waypoint_series[waypoint.id].append(
                simsvc.WaypointSample(
                    timeSeconds=round(self.time_seconds, 2),
                    activeAgents=current_agents,
                    releasedAgents=released_agents,
                )
            )
            if len(self.waypoint_series[waypoint.id]) > MAX_WAYPOINT_SAMPLES:
                self.waypoint_series[waypoint.id] = self.waypoint_series[waypoint.id][-MAX_WAYPOINT_SAMPLES:]
        if waypoint_loads:
            self.average_load_accumulator += sum(waypoint_loads) / len(waypoint_loads)
            self.average_load_samples += 1
            self.max_waypoint_load = max(self.max_waypoint_load, max(waypoint_loads))

    def tick(self, steps: int = 1) -> SimulationResult:
        with self.lock:
            self.last_accessed_at = time()
            if self.paused:
                return self.snapshot()
            n_steps = max(1, int(steps))
            self.pending_pickup_events = []
            for _ in range(n_steps):
                self._spawn_if_due()
                for token, runtime in self.waypoint_runtimes.items():
                    released_agent_id = simsvc._tick_queue_runtime(runtime, self.time_seconds)
                    if released_agent_id is None:
                        continue
                    self._record_pickup_if_applicable(token, released_agent_id)
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
                self.passages.observe(self.sim, self.stage_to_waypoint_id)
                self.time_seconds += simsvc.SIMULATION_DT_S
            self._capture_frame()
            return self.snapshot()

    def _record_pickup_if_applicable(self, token: str, released_agent_id: int) -> None:
        """Turn a queue release into a PickupEvent when the queue was a
        product pickup stage, and update the pedestrian's basket status.
        """
        pickup_item = self.pickup_item_by_token.get(token)
        if pickup_item is None:
            return
        ean, name, _duration = pickup_item
        route = self.agent_routes.get(released_agent_id)
        if route is None or route.pedestrian_id is None:
            return
        status = self.basket_status.setdefault(route.stable_id, {})
        status[ean] = (True, round(self.time_seconds, 2))
        self.pending_pickup_events.append(
            PickupEvent(
                agentId=route.stable_id,
                pedestrianId=route.pedestrian_id,
                ean=ean,
                name=name,
                timeSeconds=round(self.time_seconds, 2),
            )
        )

    def set_paused(self, paused: bool) -> SimulationResult:
        with self.lock:
            self.last_accessed_at = time()
            self.paused = paused
            return self.snapshot()

    def update(self, scene: SceneData, config: SimulationConfig) -> SimulationResult:
        with self.lock:
            self.last_accessed_at = time()
            # Validate the new layout BEFORE touching any session state.  A
            # constraint violation (e.g. furniture moved too close to a
            # waypoint) must reject the update and leave the running session
            # fully intact; mutating first used to leave the session half
            # rebuilt (new scene, old sim) and broke every later tick/update.
            walkable = simsvc._build_walkable_geometry(scene)
            entries, transit, exits = simsvc._partition_waypoints(scene, config)
            simsvc._validate_waypoint_constraints([*entries, *transit, *exits], walkable)
            carry_agents: list[tuple[_LiveAgentRoute, tuple[float, float]]] = []
            for agent in self.sim.agents():
                route = self.agent_routes.get(int(agent.id))
                if route is None:
                    continue
                carry_agents.append((route, (float(agent.position[0]), float(agent.position[1]))))
            previous_scene = self.scene
            previous_config = self.config
            try:
                self.scene = scene
                self.config = config
                self.analytics_recorder.configure(scene)
                self._init_runtime(carry_agents=carry_agents)
            except Exception:
                # Any failure while rebuilding the runtime: roll back to the
                # previous (known-good) scene so the session keeps working.
                self.scene = previous_scene
                self.config = previous_config
                self.analytics_recorder.configure(previous_scene)
                self._init_runtime(carry_agents=carry_agents)
                raise
            self._capture_frame()
            return self.snapshot()

    def analytics(self) -> SimulationAnalytics:
        with self.lock:
            self.last_accessed_at = time()
            return self.analytics_recorder.snapshot()

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
                releasedAgents=max(
                    max(
                        (sample.releasedAgents for sample in self.waypoint_series.get(waypoint.id, [])),
                        default=0,
                    ),
                    self.passages.released(waypoint.id),
                ),
                samples=self.waypoint_series.get(waypoint.id, [])[-LIVE_RESPONSE_SAMPLE_WINDOW:],
                **simsvc.queue_wait_metrics(
                    self.waypoint_runtimes.get(waypoint.id),
                    self.time_seconds,
                ),
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
        return SimulationResult(
            frames=self.frames[-LIVE_RESPONSE_FRAME_WINDOW:],
            waypoints=waypoint_metrics,
            summary=summary,
            pickupEvents=list(self.pending_pickup_events),
        )


class LiveSimulationManager:
    def __init__(self) -> None:
        self._sessions: dict[str, LiveSimulationSession] = {}
        self._lock = threading.Lock()

    def start(self, project_id: str, scene: SceneData, config: SimulationConfig) -> tuple[str, SimulationResult]:
        session = LiveSimulationSession(project_id, scene, config)
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
                if session.last_accessed_at < cutoff
            ]
            for sid in stale:
                self._sessions.pop(sid, None)


live_simulation_manager = LiveSimulationManager()

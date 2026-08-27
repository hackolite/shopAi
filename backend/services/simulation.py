from __future__ import annotations

import math
import random
from dataclasses import dataclass

try:
    import jupedsim as jps
except ImportError:  # pragma: no cover - handled at runtime
    jps = None

from shapely.geometry import MultiPolygon, Point, Polygon

from models.project import (
    FurnitureInstance,
    SceneData,
    SimulationAgentFrame,
    SimulationConfig,
    SimulationFrame,
    SimulationResult,
    SimulationSummary,
    SimulationWaypoint,
    WaypointSample,
    WaypointMetrics,
)

CM_TO_M = 0.01
M_TO_CM = 100.0
DEFAULT_SNAPSHOT_INTERVAL_S = 0.5
SIMULATION_DT_S = 0.1
OBSTACLE_CLEARANCE_CM = 5.0
AGENT_RADIUS_CM = 25.0
BOUNDARY_CLEARANCE_EPSILON_CM = 0.1
WAYPOINT_SUGGESTION_MIN_DISTANCE_CM = 1.0
ENTRY_FALLBACK_MARGIN_CM = 120.0
EXIT_FALLBACK_MARGIN_CM = 120.0
AGENT_DIAMETER_CM = AGENT_RADIUS_CM * 2
SPAWN_SPACING_CM = AGENT_DIAMETER_CM + BOUNDARY_CLEARANCE_EPSILON_CM


@dataclass
class _WaypointRuntime:
    waypoint: SimulationWaypoint
    stage_id: int
    stage: object
    release_interval_s: float
    release_ready_at: float = 0.0
    released_agents: int = 0


class SimulationConstraintViolation(ValueError):
    def __init__(self, detail: dict[str, object]):
        super().__init__(str(detail.get("message", "Simulation constraint violation")))
        self.detail = detail


def _cm_to_m(value: float) -> float:
    return float(value) * CM_TO_M


def _m_to_cm(value: float) -> float:
    return float(value) * M_TO_CM


def _default_entry_waypoint(scene: SceneData) -> SimulationWaypoint:
    store = scene.store
    store_width = float(store.dimensions["width"])
    return SimulationWaypoint(
        id="default-entry",
        label="Entrée",
        type="entry",
        x=max(ENTRY_FALLBACK_MARGIN_CM, store_width / 2),
        z=ENTRY_FALLBACK_MARGIN_CM,
        radiusCm=120.0,
        optional=False,
        visitProbability=1.0,
        retentionSeconds=0.0,
    )


def _default_exit_waypoint(scene: SceneData) -> SimulationWaypoint:
    store = scene.store
    store_width = float(store.dimensions["width"])
    store_depth = float(store.dimensions["depth"])
    return SimulationWaypoint(
        id="default-exit",
        label="Sortie",
        type="exit",
        x=max(EXIT_FALLBACK_MARGIN_CM, store_width / 2),
        z=max(EXIT_FALLBACK_MARGIN_CM, store_depth - EXIT_FALLBACK_MARGIN_CM),
        radiusCm=120.0,
        optional=False,
        visitProbability=1.0,
        retentionSeconds=0.0,
    )


def _partition_waypoints(
    scene: SceneData,
    config: SimulationConfig,
) -> tuple[list[SimulationWaypoint], list[SimulationWaypoint], list[SimulationWaypoint]]:
    entries = [waypoint for waypoint in config.waypoints if waypoint.type == "entry"]
    exits = [waypoint for waypoint in config.waypoints if waypoint.type == "exit"]
    transit = [waypoint for waypoint in config.waypoints if waypoint.type == "transit"]
    if not entries:
        entries = [_default_entry_waypoint(scene)]
    if not exits:
        exits = [_default_exit_waypoint(scene)]
    return entries, transit, exits


def _waypoint_point(waypoint: SimulationWaypoint) -> tuple[float, float]:
    return (_cm_to_m(waypoint.x), _cm_to_m(waypoint.z))


def _waypoint_exit_polygon(waypoint: SimulationWaypoint, walkable: Polygon) -> Polygon:
    half = _cm_to_m(max(40.0, waypoint.radiusCm)) / 2
    x, z = _safe_waypoint_point(
        waypoint,
        walkable,
        clearance_cm=_waypoint_constraint_clearance_cm(waypoint),
    )
    return Polygon(
        [
            (x - half, z - half),
            (x + half, z - half),
            (x + half, z + half),
            (x - half, z + half),
        ]
    )


def _furniture_polygon(furniture: FurnitureInstance, store_polygon: Polygon) -> Polygon | None:
    if furniture.mounted is False or not furniture.visible:
        return None
    width = float(furniture.dimensions["width"])
    depth = float(furniture.dimensions["depth"])
    half_w = width / 2
    half_d = depth / 2
    center = (float(furniture.position[0]), float(furniture.position[2]))
    rotation = math.radians(float(furniture.rotation[1]))
    corners = [
        (-half_w, -half_d),
        (half_w, -half_d),
        (half_w, half_d),
        (-half_w, half_d),
    ]
    world = []
    for local_x, local_z in corners:
        wx = center[0] + local_x * math.cos(rotation) - local_z * math.sin(rotation)
        wz = center[1] + local_x * math.sin(rotation) + local_z * math.cos(rotation)
        world.append((_cm_to_m(wx), _cm_to_m(wz)))
    polygon = Polygon(world)
    if polygon.is_empty:
        return None
    polygon = polygon.buffer(_cm_to_m(OBSTACLE_CLEARANCE_CM), join_style="mitre")
    clipped = polygon.intersection(store_polygon)
    if clipped.is_empty:
        return None
    if isinstance(clipped, MultiPolygon):
        clipped = max(clipped.geoms, key=lambda geom: geom.area)
    return clipped if isinstance(clipped, Polygon) else None


def _build_walkable_geometry(scene: SceneData) -> Polygon:
    store = scene.store
    store_polygon = Polygon(
        [
            (0.0, 0.0),
            (_cm_to_m(float(store.dimensions["width"])), 0.0),
            (_cm_to_m(float(store.dimensions["width"])), _cm_to_m(float(store.dimensions["depth"]))),
            (0.0, _cm_to_m(float(store.dimensions["depth"]))),
        ]
    )
    walkable = store_polygon
    for furniture in scene.furniture:
        obstacle = _furniture_polygon(furniture, store_polygon)
        if obstacle is not None:
            walkable = walkable.difference(obstacle)
    walkable = walkable.buffer(0)
    if isinstance(walkable, MultiPolygon):
        walkable = max(walkable.geoms, key=lambda geom: geom.area)
    if not isinstance(walkable, Polygon) or walkable.is_empty:
        raise ValueError("Unable to derive a valid walkable area from the current store layout")
    return walkable


def _point_in_walkable(point: tuple[float, float], walkable: Polygon) -> bool:
    return walkable.contains(Point(point)) or walkable.touches(Point(point))


def _normalize_polygon(geometry) -> Polygon | None:
    if geometry.is_empty:
        return None
    geometry = geometry.buffer(0)
    if geometry.is_empty:
        return None
    if isinstance(geometry, MultiPolygon):
        geometry = max(geometry.geoms, key=lambda geom: geom.area)
    return geometry if isinstance(geometry, Polygon) else None


def _walkable_with_clearance(walkable: Polygon, clearance_cm: float) -> Polygon | None:
    clearance_m = _cm_to_m(max(0.0, clearance_cm))
    if clearance_m <= 0:
        return walkable
    return _normalize_polygon(walkable.buffer(-clearance_m))


def _closest_walkable_point(point: tuple[float, float], walkable: Polygon) -> tuple[float, float]:
    if _point_in_walkable(point, walkable):
        return point
    projected = walkable.boundary.interpolate(walkable.boundary.project(Point(point)))
    projected_point = (projected.x, projected.y)
    if _point_in_walkable(projected_point, walkable):
        return projected_point
    fallback = walkable.representative_point()
    return (fallback.x, fallback.y)


def _points_are_distinct(
    point: tuple[float, float],
    candidate: tuple[float, float],
    min_distance_cm: float = WAYPOINT_SUGGESTION_MIN_DISTANCE_CM,
) -> bool:
    return math.hypot(point[0] - candidate[0], point[1] - candidate[1]) >= _cm_to_m(min_distance_cm)


def _suggest_distinct_walkable_point(
    point: tuple[float, float],
    walkable: Polygon,
) -> tuple[float, float] | None:
    candidate = _closest_walkable_point(point, walkable)
    if _points_are_distinct(point, candidate):
        return candidate
    fallback = walkable.representative_point()
    fallback_point = (fallback.x, fallback.y)
    if _point_in_walkable(fallback_point, walkable) and _points_are_distinct(point, fallback_point):
        return fallback_point
    return None


def _waypoint_constraint_clearance_cm(waypoint: SimulationWaypoint) -> float:
    if waypoint.type == "exit":
        extent_cm = max(40.0, float(waypoint.radiusCm)) / 2
    elif waypoint.type in {"entry", "transit"}:
        extent_cm = 0.0
    else:
        extent_cm = 0.0
    return extent_cm + AGENT_RADIUS_CM + BOUNDARY_CLEARANCE_EPSILON_CM


def _safe_waypoint_point(
    waypoint: SimulationWaypoint,
    walkable: Polygon,
    clearance_cm: float = 0.0,
) -> tuple[float, float]:
    point = _waypoint_point(waypoint)
    constrained_walkable = _walkable_with_clearance(walkable, clearance_cm)
    target_walkable = constrained_walkable or walkable
    return _closest_walkable_point(point, target_walkable)


def _raise_waypoint_constraint_violation(waypoint: SimulationWaypoint, walkable: Polygon) -> None:
    constrained_walkable = _walkable_with_clearance(
        walkable,
        _waypoint_constraint_clearance_cm(waypoint),
    )
    current_point = _waypoint_point(waypoint)
    suggested_x: float | None = None
    suggested_z: float | None = None
    message = (
        f'Le point "{waypoint.label}" est trop proche des limites de circulation. '
        "Déplacez-le au plus près vers la correction proposée."
    )
    if constrained_walkable is not None:
        suggested_point = _suggest_distinct_walkable_point(current_point, constrained_walkable)
        if suggested_point is not None:
            suggested_x, suggested_z = suggested_point
        else:
            message = (
                f'Le point "{waypoint.label}" est trop proche des limites de circulation '
                "et aucune correction distincte n'a pu être calculée automatiquement."
            )
    else:
        message = (
            f'Le point "{waypoint.label}" est trop proche des limites de circulation '
            "et aucun emplacement valide n'est disponible avec la marge requise."
        )
    raise SimulationConstraintViolation(
        {
            "message": message,
            "waypointId": waypoint.id,
            "waypointLabel": waypoint.label,
            "currentXcm": round(float(waypoint.x), 2),
            "currentZcm": round(float(waypoint.z), 2),
            "suggestedXcm": round(_m_to_cm(suggested_x), 2) if suggested_x is not None else None,
            "suggestedZcm": round(_m_to_cm(suggested_z), 2) if suggested_z is not None else None,
            "minimumClearanceCm": round(_waypoint_constraint_clearance_cm(waypoint), 2),
        }
    )


def _validate_waypoint_constraints(waypoints: list[SimulationWaypoint], walkable: Polygon) -> None:
    for waypoint in waypoints:
        point = _waypoint_point(waypoint)
        if not _point_in_walkable(point, walkable):
            _raise_waypoint_constraint_violation(waypoint, walkable)
        clearance_m = _cm_to_m(_waypoint_constraint_clearance_cm(waypoint))
        if clearance_m > 0 and walkable.boundary.distance(Point(point)) < clearance_m:
            _raise_waypoint_constraint_violation(waypoint, walkable)


def _min_entry_radius_cm(agent_count: int) -> float:
    """Return the minimum entry waypoint radius (cm) to fit `agent_count` agents
    without overlap, arranged in concentric rings around the center.

    The formula packs agents in a disc: radius ≥ sqrt(N) × agent_spacing so that
    the disc area is large enough for all agents placed at SPAWN_SPACING_CM apart.
    """
    if agent_count <= 1:
        return AGENT_DIAMETER_CM
    return math.ceil(math.sqrt(agent_count)) * SPAWN_SPACING_CM


def _candidate_clears_occupied(
    candidate: tuple[float, float],
    occupied: list[tuple[float, float]],
) -> bool:
    min_dist_m = _cm_to_m(SPAWN_SPACING_CM)
    return all(
        math.hypot(candidate[0] - ox, candidate[1] - oz) >= min_dist_m
        for ox, oz in occupied
    )


def _spawn_from_entry(
    waypoint: SimulationWaypoint,
    walkable: Polygon,
    rng: random.Random,
    occupied_positions: list[tuple[float, float]] | None = None,
) -> tuple[float, float]:
    center_x, center_z = _safe_waypoint_point(
        waypoint,
        walkable,
        clearance_cm=AGENT_RADIUS_CM + BOUNDARY_CLEARANCE_EPSILON_CM,
    )
    occupied = occupied_positions or []
    # Use at least enough radius to avoid overlaps with already-occupied slots.
    min_radius_cm = _min_entry_radius_cm(len(occupied) + 1)
    radius_m = _cm_to_m(max(min_radius_cm, waypoint.radiusCm))
    spawnable = _walkable_with_clearance(walkable, AGENT_RADIUS_CM + BOUNDARY_CLEARANCE_EPSILON_CM) or walkable
    for _ in range(240):
        angle = rng.uniform(0, math.tau)
        r = radius_m * math.sqrt(rng.random())
        candidate = (
            center_x + math.cos(angle) * r,
            center_z + math.sin(angle) * r,
        )
        if _point_in_walkable(candidate, spawnable) and _candidate_clears_occupied(candidate, occupied):
            return candidate
    # Fallback: ignore spacing constraint but stay in walkable area.
    return _random_point_in_polygon(spawnable, rng)


def _random_point_in_polygon(polygon: Polygon, rng: random.Random) -> tuple[float, float]:
    min_x, min_y, max_x, max_y = polygon.bounds
    for _ in range(500):
        x = rng.uniform(min_x, max_x)
        y = rng.uniform(min_y, max_y)
        if polygon.contains(Point(x, y)):
            return (x, y)
    center = polygon.representative_point()
    return (center.x, center.y)


def _build_agent_params(
    journey_id: int,
    stage_id: int,
    position: tuple[float, float],
    desired_speed: float,
):
    return jps.CollisionFreeSpeedModelAgentParameters(
        position=position,
        journey_id=journey_id,
        stage_id=stage_id,
        desired_speed=desired_speed,
        radius=_cm_to_m(AGENT_RADIUS_CM),
        time_gap=1.0,
    )


def _vision_for_agent(config: SimulationConfig, stage_waypoint):
    if stage_waypoint is None:
        return (70.0, 220.0)
    return (float(stage_waypoint.visionAngleDeg), float(stage_waypoint.visionRangeCm))


def run_flow_simulation(scene: SceneData, config: SimulationConfig) -> SimulationResult:
    if jps is None:
        raise RuntimeError("JuPedSim is not installed on the backend")
    if not config.enabled:
        return SimulationResult(
            frames=[],
            waypoints=[],
            summary=SimulationSummary(
                spawnedCustomers=0,
                completedCustomers=0,
                activeCustomers=0,
                averageWaypointLoad=0.0,
                maxWaypointLoad=0,
                averageConfiguredRetentionSeconds=0.0,
            ),
        )

    rng = random.Random(int(config.randomSeed))
    walkable = _build_walkable_geometry(scene)
    entries, transit_waypoints, exits = _partition_waypoints(scene, config)
    _validate_waypoint_constraints([*entries, *transit_waypoints, *exits], walkable)
    sim = jps.Simulation(
        model=jps.CollisionFreeSpeedModel(),
        geometry=walkable,
        dt=SIMULATION_DT_S,
    )

    exit_stage_ids: dict[str, int] = {}
    waypoint_stage_ids: dict[str, int] = {}
    waypoint_by_stage_id: dict[int, SimulationWaypoint] = {}
    waypoint_runtimes: dict[str, _WaypointRuntime] = {}
    metrics_waypoints = [*entries, *transit_waypoints, *exits]
    for waypoint in metrics_waypoints:
        if waypoint.type == "exit":
            stage_id = sim.add_exit_stage(_waypoint_exit_polygon(waypoint, walkable))
            exit_stage_ids[waypoint.id] = stage_id
        elif waypoint.retentionSeconds > 0:
            stage_id = sim.add_queue_stage(
                [_safe_waypoint_point(waypoint, walkable, clearance_cm=AGENT_RADIUS_CM + BOUNDARY_CLEARANCE_EPSILON_CM)]
            )
            runtime = _WaypointRuntime(
                waypoint=waypoint,
                stage_id=stage_id,
                stage=sim.get_stage(stage_id),
                release_interval_s=float(waypoint.retentionSeconds),
            )
            waypoint_runtimes[waypoint.id] = runtime
            waypoint_stage_ids[waypoint.id] = stage_id
            waypoint_by_stage_id[stage_id] = waypoint
        else:
            stage_id = sim.add_waypoint_stage(
                _safe_waypoint_point(
                    waypoint,
                    walkable,
                    clearance_cm=_waypoint_constraint_clearance_cm(waypoint),
                ),
                _cm_to_m(max(40.0, waypoint.radiusCm)),
            )
            waypoint_stage_ids[waypoint.id] = stage_id
            waypoint_by_stage_id[stage_id] = waypoint

    arrival_times: list[float] = []
    arrival_rate = max(0.0, float(config.arrivalRatePerSecond))
    if arrival_rate > 0:
        current_arrival = 0.0
        while len(arrival_times) < int(config.maxCustomers):
            current_arrival += rng.expovariate(arrival_rate)
            if current_arrival > float(config.durationSeconds):
                break
            arrival_times.append(current_arrival)

    arrival_index = 0
    spawned = 0
    completed = 0
    steps_per_snapshot = max(1, round(DEFAULT_SNAPSHOT_INTERVAL_S / SIMULATION_DT_S))
    frames: list[SimulationFrame] = []
    waypoint_series: dict[str, list[WaypointSample]] = {waypoint.id: [] for waypoint in metrics_waypoints}
    average_load_accumulator = 0.0
    average_load_samples = 0
    max_waypoint_load = 0

    for step_index in range(int(float(config.durationSeconds) / SIMULATION_DT_S) + 1):
        current_time = step_index * SIMULATION_DT_S
        step_spawn_positions: dict[str, list[tuple[float, float]]] = {}

        while arrival_index < len(arrival_times) and arrival_times[arrival_index] <= current_time:
            selected_entry = entries[spawned % len(entries)]
            selected_stage_ids: list[int] = [waypoint_stage_ids[selected_entry.id]]
            for waypoint in transit_waypoints:
                if not waypoint.optional or rng.random() <= float(waypoint.visitProbability):
                    selected_stage_ids.append(waypoint_stage_ids[waypoint.id])
            selected_exit = exits[spawned % len(exits)]
            selected_stage_ids.append(exit_stage_ids[selected_exit.id])
            journey = jps.JourneyDescription(selected_stage_ids)
            for from_stage, to_stage in zip(selected_stage_ids[:-1], selected_stage_ids[1:]):
                journey.set_transition_for_stage(from_stage, jps.Transition.create_fixed_transition(to_stage))
            journey_id = sim.add_journey(journey)
            occupied = step_spawn_positions.setdefault(selected_entry.id, [])
            spawn_position = _spawn_from_entry(selected_entry, walkable, rng, occupied)
            occupied.append(spawn_position)
            desired_speed = max(0.5, rng.gauss(float(config.desiredSpeedMps), float(config.speedVariation)))
            sim.add_agent(
                _build_agent_params(
                    journey_id=journey_id,
                    stage_id=selected_stage_ids[0],
                    position=spawn_position,
                    desired_speed=desired_speed,
                )
            )
            spawned += 1
            arrival_index += 1

        for runtime in waypoint_runtimes.values():
            queue_length = int(runtime.stage.count_targeting())
            if queue_length > 0 and current_time >= runtime.release_ready_at:
                runtime.stage.pop(1)
                runtime.released_agents += 1
                runtime.release_ready_at = current_time + runtime.release_interval_s

        sim.iterate()
        completed += len(sim.removed_agents())

        if step_index % steps_per_snapshot == 0:
            waypoint_loads: list[int] = []
            for waypoint in metrics_waypoints:
                if waypoint.type == "exit":
                    current_agents = 0
                    released_agents = 0
                else:
                    stage_id = waypoint_stage_ids.get(waypoint.id)
                    if stage_id is None:
                        continue
                    stage = sim.get_stage(stage_id)
                    current_agents = int(stage.count_targeting())
                    runtime = waypoint_runtimes.get(waypoint.id)
                    released_agents = runtime.released_agents if runtime is not None else 0
                waypoint_loads.append(current_agents)
                waypoint_series[waypoint.id].append(
                    WaypointSample(
                        timeSeconds=round(current_time, 2),
                        activeAgents=current_agents,
                        releasedAgents=released_agents,
                    )
                )
            if waypoint_loads:
                sample_average = sum(waypoint_loads) / len(waypoint_loads)
                average_load_accumulator += sample_average
                average_load_samples += 1
                max_waypoint_load = max(max_waypoint_load, max(waypoint_loads))

            frame_agents: list[SimulationAgentFrame] = []
            for agent in sim.agents():
                heading_x, heading_z = agent.orientation
                vision_angle_deg, vision_range_cm = _vision_for_agent(
                    config,
                    waypoint_by_stage_id.get(int(agent.stage_id)),
                )
                frame_agents.append(
                    SimulationAgentFrame(
                        id=int(agent.id),
                        xCm=round(_m_to_cm(agent.position[0]), 2),
                        zCm=round(_m_to_cm(agent.position[1]), 2),
                        headingX=float(heading_x) if heading_x or heading_z else 1.0,
                        headingZ=float(heading_z),
                        visionAngleDeg=vision_angle_deg,
                        visionRangeCm=vision_range_cm,
                    )
                )
            frames.append(SimulationFrame(timeSeconds=round(current_time, 2), agents=frame_agents))

    waypoint_metrics = [
        WaypointMetrics(
            waypointId=waypoint.id,
            waypointLabel=waypoint.label,
            waypointType=waypoint.type,
            retentionSeconds=float(waypoint.retentionSeconds),
            maxActiveAgents=max((sample.activeAgents for sample in waypoint_series[waypoint.id]), default=0),
            releasedAgents=(
                max((sample.releasedAgents for sample in waypoint_series[waypoint.id]), default=0)
                if waypoint.type != "exit"
                else 0
            ),
            samples=waypoint_series[waypoint.id],
        )
        for waypoint in metrics_waypoints
    ]
    all_retentions = [float(waypoint.retentionSeconds) for waypoint in transit_waypoints if waypoint.retentionSeconds > 0]

    summary = SimulationSummary(
        spawnedCustomers=spawned,
        completedCustomers=completed,
        activeCustomers=int(sim.agent_count()),
        averageWaypointLoad=round(
            average_load_accumulator / average_load_samples if average_load_samples else 0.0,
            2,
        ),
        maxWaypointLoad=max_waypoint_load,
        averageConfiguredRetentionSeconds=round(sum(all_retentions) / len(all_retentions), 2) if all_retentions else 0.0,
    )
    return SimulationResult(frames=frames, waypoints=waypoint_metrics, summary=summary)

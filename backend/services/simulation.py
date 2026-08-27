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
    FloorZone,
    FurnitureInstance,
    SceneData,
    SimulationAgentFrame,
    SimulationConfig,
    SimulationFrame,
    SimulationResult,
    SimulationSummary,
    QueueSample,
    CheckoutMetrics,
)

CM_TO_M = 0.01
M_TO_CM = 100.0
DEFAULT_ZONE_WIDTH_CM = 240.0
DEFAULT_ZONE_DEPTH_CM = 140.0
DEFAULT_SNAPSHOT_INTERVAL_S = 0.5
SIMULATION_DT_S = 0.1
SPAWN_RADIUS_CM = 25.0
OBSTACLE_CLEARANCE_CM = 5.0


@dataclass
class _CheckoutRuntime:
    register: FurnitureInstance
    stage_id: int
    stage: object
    service_ready_at: float = 0.0
    served_customers: int = 0


def _cm_to_m(value: float) -> float:
    return float(value) * CM_TO_M


def _m_to_cm(value: float) -> float:
    return float(value) * M_TO_CM


def _zone_polygon(zone: FloorZone) -> Polygon:
    return Polygon(
        [
            (_cm_to_m(zone.x), _cm_to_m(zone.z)),
            (_cm_to_m(zone.x + zone.width), _cm_to_m(zone.z)),
            (_cm_to_m(zone.x + zone.width), _cm_to_m(zone.z + zone.depth)),
            (_cm_to_m(zone.x), _cm_to_m(zone.z + zone.depth)),
        ]
    )


def _default_zone(scene: SceneData, zone_type: str) -> FloorZone:
    store = scene.store
    store_width = float(store.dimensions["width"])
    store_depth = float(store.dimensions["depth"])
    x = max(0.0, store_width / 2 - DEFAULT_ZONE_WIDTH_CM / 2)
    z = 0.0 if zone_type == "entrance" else max(0.0, store_depth - DEFAULT_ZONE_DEPTH_CM)
    return FloorZone(
        id=f"default-{zone_type}",
        type=zone_type,
        label="Entrée" if zone_type == "entrance" else "Sortie",
        x=x,
        z=z,
        width=min(DEFAULT_ZONE_WIDTH_CM, store_width),
        depth=min(DEFAULT_ZONE_DEPTH_CM, store_depth),
    )


def _find_zone(scene: SceneData, zone_type: str) -> FloorZone:
    zone = next((zone for zone in scene.store.zones if zone.type.value == zone_type), None)
    return zone or _default_zone(scene, zone_type)


def _rotated_forward(rotation_deg: float) -> tuple[float, float]:
    radians = math.radians(rotation_deg)
    return (math.sin(radians), math.cos(radians))


def _register_service_position(register: FurnitureInstance) -> tuple[float, float]:
    fx, fz = _rotated_forward(float(register.rotation[1]))
    cx = float(register.position[0])
    cz = float(register.position[2])
    reach = float(register.dimensions["depth"]) / 2 + 40.0
    return (cx + fx * reach, cz + fz * reach)


def _register_queue_positions(register: FurnitureInstance, queue_slots: int, spacing_cm: float) -> list[tuple[float, float]]:
    service_x, service_z = _register_service_position(register)
    fx, fz = _rotated_forward(float(register.rotation[1]))
    return [
        (_cm_to_m(service_x + fx * spacing_cm * index), _cm_to_m(service_z + fz * spacing_cm * index))
        for index in range(max(1, queue_slots))
    ]


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
        radius=_cm_to_m(25.0),
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
            checkouts=[],
            summary=SimulationSummary(
                spawnedCustomers=0,
                completedCustomers=0,
                activeCustomers=0,
                averageQueueLength=0.0,
                maxQueueLength=0,
            ),
        )

    rng = random.Random(int(config.randomSeed))
    walkable = _build_walkable_geometry(scene)
    sim = jps.Simulation(
        model=jps.CollisionFreeSpeedModel(),
        geometry=walkable,
        dt=SIMULATION_DT_S,
    )

    entrance_zone = _find_zone(scene, "entrance")
    exit_zone = _find_zone(scene, "exit")
    entrance_polygon = _zone_polygon(entrance_zone).intersection(walkable)
    exit_polygon = _zone_polygon(exit_zone)
    if entrance_polygon.is_empty:
        entrance_polygon = walkable

    exit_stage = sim.add_exit_stage(exit_polygon)
    waypoint_stage_ids: dict[str, int] = {}
    waypoint_by_stage_id: dict[int, object] = {}
    ordered_waypoints = list(config.waypoints)
    for waypoint in ordered_waypoints:
        stage_id = sim.add_waypoint_stage(
            (_cm_to_m(waypoint.x), _cm_to_m(waypoint.z)),
            _cm_to_m(waypoint.radiusCm),
        )
        waypoint_stage_ids[waypoint.id] = stage_id
        waypoint_by_stage_id[stage_id] = waypoint

    registers = [
        furniture
        for furniture in scene.furniture
        if furniture.type == "register" and furniture.visible and furniture.mounted is not False
    ]
    if not registers:
        registers = [
            FurnitureInstance(
                id="synthetic-register",
                name="Sortie",
                type="register",
                libraryId="register",
                position=[float(exit_zone.x + exit_zone.width / 2), 0.0, float(max(0.0, exit_zone.z - 60.0))],
                rotation=[0.0, 180.0, 0.0],
                dimensions={"width": 80.0, "depth": 60.0, "height": 90.0},
                visible=True,
                locked=True,
                mounted=True,
                parentId=None,
                childIds=[],
                faces={face: None for face in ("front", "back", "left", "right", "top", "bottom")},
            )
        ]

    checkout_runtimes: list[_CheckoutRuntime] = []
    for register in registers:
        stage_id = sim.add_queue_stage(
            _register_queue_positions(register, int(config.queueSlots), float(config.queueSpacingCm))
        )
        checkout_runtimes.append(
            _CheckoutRuntime(register=register, stage_id=stage_id, stage=sim.get_stage(stage_id))
        )

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
    queue_series: dict[str, list[QueueSample]] = {runtime.register.id: [] for runtime in checkout_runtimes}
    average_queue_accumulator = 0.0
    average_queue_samples = 0
    max_queue_length = 0

    for step_index in range(int(float(config.durationSeconds) / SIMULATION_DT_S) + 1):
        current_time = step_index * SIMULATION_DT_S

        while arrival_index < len(arrival_times) and arrival_times[arrival_index] <= current_time:
            register_runtime = checkout_runtimes[spawned % len(checkout_runtimes)]
            selected_stage_ids: list[int] = []
            for waypoint in ordered_waypoints:
                if not waypoint.optional or rng.random() <= float(waypoint.visitProbability):
                    selected_stage_ids.append(waypoint_stage_ids[waypoint.id])
            selected_stage_ids.extend([register_runtime.stage_id, exit_stage])
            journey = jps.JourneyDescription(selected_stage_ids)
            for from_stage, to_stage in zip(selected_stage_ids[:-1], selected_stage_ids[1:]):
                journey.set_transition_for_stage(from_stage, jps.Transition.create_fixed_transition(to_stage))
            journey_id = sim.add_journey(journey)
            spawn_position = _random_point_in_polygon(entrance_polygon, rng)
            spawn_position = (
                spawn_position[0] + rng.uniform(-_cm_to_m(SPAWN_RADIUS_CM), _cm_to_m(SPAWN_RADIUS_CM)),
                spawn_position[1] + rng.uniform(-_cm_to_m(SPAWN_RADIUS_CM), _cm_to_m(SPAWN_RADIUS_CM)),
            )
            if not walkable.contains(Point(spawn_position)):
                spawn_position = _random_point_in_polygon(entrance_polygon, rng)
            desired_speed = max(0.5, rng.gauss(float(config.desiredSpeedMps), float(config.speedVariation)))
            agent_id = sim.add_agent(
                _build_agent_params(
                    journey_id=journey_id,
                    stage_id=selected_stage_ids[0],
                    position=spawn_position,
                    desired_speed=desired_speed,
                )
            )
            spawned += 1
            arrival_index += 1

        for runtime in checkout_runtimes:
            queue_length = int(runtime.stage.count_targeting())
            if queue_length > 0 and current_time >= runtime.service_ready_at:
                runtime.stage.pop(1)
                runtime.served_customers += 1
                service_time = max(
                    1.0,
                    rng.gauss(float(config.serviceTimeSeconds), float(config.serviceTimeJitterSeconds)),
                )
                runtime.service_ready_at = current_time + service_time

        sim.iterate()
        completed += len(sim.removed_agents())

        if step_index % steps_per_snapshot == 0:
            queue_lengths: list[int] = []
            for runtime in checkout_runtimes:
                queue_length = int(runtime.stage.count_targeting())
                queue_lengths.append(queue_length)
                queue_series[runtime.register.id].append(
                    QueueSample(
                        timeSeconds=round(current_time, 2),
                        queueLength=queue_length,
                        servedCustomers=runtime.served_customers,
                    )
                )
            if queue_lengths:
                sample_average = sum(queue_lengths) / len(queue_lengths)
                average_queue_accumulator += sample_average
                average_queue_samples += 1
                max_queue_length = max(max_queue_length, max(queue_lengths))

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

    checkouts = [
        CheckoutMetrics(
            registerId=runtime.register.id,
            registerName=runtime.register.name,
            queueLengthMax=max((sample.queueLength for sample in queue_series[runtime.register.id]), default=0),
            servedCustomers=runtime.served_customers,
            samples=queue_series[runtime.register.id],
        )
        for runtime in checkout_runtimes
    ]

    summary = SimulationSummary(
        spawnedCustomers=spawned,
        completedCustomers=completed,
        activeCustomers=int(sim.agent_count()),
        averageQueueLength=round(
            average_queue_accumulator / average_queue_samples if average_queue_samples else 0.0,
            2,
        ),
        maxQueueLength=max_queue_length,
    )
    return SimulationResult(frames=frames, checkouts=checkouts, summary=summary)

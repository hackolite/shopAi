"""Walkable-area partitioning for pedestrian simulation.

When forbidden zones or furniture split the store into several disconnected
pieces, the simulation must not hard-fail as long as an entry and an exit
share one connected component: the other islands are simply excluded from the
geometry handed to JuPedSim.  This module computes that partition and keeps a
structured list of every obstacle whose removal created an island.

The partition is recomputed from scratch on every call, so an area that was
previously excluded automatically becomes connected again when the user
removes or shrinks an obstacle — no extra state is needed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from shapely.geometry import MultiPolygon, Polygon

from models.project import SceneData, SimulationConfig, SimulationWaypoint
from services.simulation import (
    SimulationConstraintViolation,
    _cm_to_m,
    _furniture_polygon,
    _m_to_cm,
    _partition_waypoints,
    _point_in_walkable,
    _split_accessible_area_detail,
    _walkable_components,
    _waypoint_point,
    _zone_polygon,
)


@dataclass
class WalkablePartition:
    # The connected component agents can walk in.
    connected: Polygon
    # Excluded islands (may be empty).
    disconnected: list[Polygon]
    # Obstacles whose subtraction split the walkable area
    # ({"elementType": "zone"|"furniture", "elementId", "elementLabel"}).
    excluded_obstacles: list[dict] = field(default_factory=list)
    # Ids of entries/transits/exits that lie within ``connected``.
    reachable_waypoint_ids: set[str] = field(default_factory=set)


def _store_polygon(store) -> Polygon:
    store_x_m = _cm_to_m(float(store.position[0]))
    store_z_m = _cm_to_m(float(store.position[2]))
    width_m = _cm_to_m(float(store.dimensions["width"]))
    depth_m = _cm_to_m(float(store.dimensions["depth"]))
    return Polygon(
        [
            (store_x_m, store_z_m),
            (store_x_m + width_m, store_z_m),
            (store_x_m + width_m, store_z_m + depth_m),
            (store_x_m, store_z_m + depth_m),
        ]
    )


def _obstacle_identity(element_type: str, element_id: str | None, element_label: str | None) -> dict:
    return {
        "elementType": element_type,
        "elementId": element_id,
        "elementLabel": element_label,
    }


def _collect_splitting_obstacles(scene: SceneData, store_polygon: Polygon) -> tuple[object, list[dict]]:
    """Subtract every obstacle once, collecting all that split the walkable area."""
    all_obstacles = []
    for furniture in scene.furniture:
        obstacle = _furniture_polygon(furniture, store_polygon)
        if obstacle is not None:
            all_obstacles.append(obstacle)
    for zone in getattr(scene.store, "zones", []) or []:
        obstacle = _zone_polygon(zone, store_polygon)
        if obstacle is not None:
            all_obstacles.append(obstacle)

    from shapely.ops import unary_union
    obstacles_union = unary_union(all_obstacles) if all_obstacles else None

    if obstacles_union is not None and not obstacles_union.is_empty:
        global_walkable = store_polygon.difference(obstacles_union).buffer(0)
    else:
        global_walkable = store_polygon

    if not isinstance(global_walkable, MultiPolygon) or len(_walkable_components(global_walkable)) <= 1:
        return global_walkable, []

    walkable = store_polygon
    splitting: list[dict] = []
    for furniture in scene.furniture:
        obstacle = _furniture_polygon(furniture, store_polygon)
        if obstacle is None:
            continue
        overlap = walkable.intersection(obstacle)
        if overlap.is_empty:
            continue
        walkable = walkable.difference(obstacle)
        normalized = walkable.buffer(0)
        if isinstance(normalized, MultiPolygon) and len(_walkable_components(normalized)) > 1:
            splitting.append(_obstacle_identity("furniture", furniture.id, furniture.name))
    for zone in getattr(scene.store, "zones", []) or []:
        obstacle = _zone_polygon(zone, store_polygon)
        if obstacle is None:
            continue
        overlap = walkable.intersection(obstacle)
        if overlap.is_empty:
            continue
        walkable = walkable.difference(obstacle)
        normalized = walkable.buffer(0)
        if isinstance(normalized, MultiPolygon) and len(_walkable_components(normalized)) > 1:
            splitting.append(
                _obstacle_identity("zone", getattr(zone, "id", None), getattr(zone, "label", None))
            )
    return walkable, splitting


def _first_blocking_detail(excluded_obstacles: list[dict]) -> dict[str, object]:
    if excluded_obstacles:
        first = excluded_obstacles[0]
        return _split_accessible_area_detail(
            element_type=first["elementType"],
            element_id=first["elementId"],
            element_label=first["elementLabel"],
        )
    return _split_accessible_area_detail(element_type="obstacle")


def _format_obstacle_names(excluded_obstacles: list[dict], limit: int = 3) -> str:
    names = [
        str(obstacle["elementLabel"] or obstacle["elementId"] or "sans nom")
        for obstacle in excluded_obstacles[:limit]
    ]
    if len(excluded_obstacles) > limit:
        names.append("…")
    return ", ".join(f"« {name} »" for name in names)


def _raise_disconnected_exit(waypoint: SimulationWaypoint, excluded_obstacles: list[dict]) -> None:
    detail = _first_blocking_detail(excluded_obstacles)
    if excluded_obstacles:
        detail["message"] = (
            f"La sortie « {waypoint.label} » est coupée de l'entrée : "
            f"{_format_obstacle_names(excluded_obstacles)} coupe la zone accessible des piétons "
            "et une partie du magasin est isolée. Réduisez ou déplacez l'obstacle "
            "pour reconnecter la sortie, ou déplacez la sortie dans la zone reliée à l'entrée."
        )
    else:
        detail["message"] = (
            f"La sortie « {waypoint.label} » n'est pas reliée à l'entrée : "
            "une partie de la zone accessible des piétons est isolée du reste du magasin."
        )
    detail["blockingElementIds"] = [
        obstacle["elementId"] for obstacle in excluded_obstacles if obstacle["elementId"] is not None
    ]
    raise SimulationConstraintViolation(detail)


def raise_no_reachable_entry(excluded_obstacles: list[dict]) -> None:
    detail = _first_blocking_detail(excluded_obstacles)
    if excluded_obstacles:
        detail["message"] = (
            "Aucune entrée ne se trouve sur la zone accessible reliée aux sorties : "
            f"{_format_obstacle_names(excluded_obstacles)} isole une partie du magasin. "
            "Déplacez une entrée dans la zone reliée ou supprimez l'obstacle."
        )
    else:
        detail["message"] = "Aucune entrée ne se trouve sur la zone accessible des piétons."
    detail["blockingElementIds"] = [
        obstacle["elementId"] for obstacle in excluded_obstacles if obstacle["elementId"] is not None
    ]
    raise SimulationConstraintViolation(detail)


def _choose_connected_component(
    components: list[Polygon],
    entries: list[SimulationWaypoint],
) -> Polygon:
    """Pick the component containing the first entry; majority of entries wins,
    ties break to the largest area, and no entry at all falls back to largest."""
    entry_components: list[Polygon] = []
    for entry in entries:
        point = _waypoint_point(entry)
        for component in components:
            if _point_in_walkable(point, component):
                entry_components.append(component)
                break
    if not entry_components:
        return max(components, key=lambda geom: geom.area)
    # Majority of entries decides; ties prefer the first entry's component,
    # then the largest area.
    first = entry_components[0]
    counts: list[tuple[Polygon, int]] = []
    for component in entry_components:
        for index, (existing_component, _) in enumerate(counts):
            if component.equals(existing_component):
                counts[index] = (existing_component, counts[index][1] + 1)
                break
        else:
            counts.append((component, 1))
    return max(
        counts,
        key=lambda item: (item[1], item[0].equals(first), item[0].area),
    )[0]


def compute_walkable_partition(scene: SceneData, config: SimulationConfig) -> WalkablePartition:
    store_polygon = _store_polygon(scene.store)
    walkable, splitting = _collect_splitting_obstacles(scene, store_polygon)
    walkable = walkable.buffer(0)
    components = _walkable_components(walkable)
    if not components:
        raise ValueError("Unable to derive a valid walkable area from the current store layout")

    # Raises SimulationConstraintViolation when waypoints exist but no exit.
    entries, transit, exits = _partition_waypoints(scene, config)

    connected = _choose_connected_component(components, entries)
    disconnected = [component for component in components if not component.equals(connected)]

    for exit_waypoint in exits:
        if not _point_in_walkable(_waypoint_point(exit_waypoint), connected):
            _raise_disconnected_exit(exit_waypoint, splitting)

    reachable_waypoint_ids = {
        waypoint.id
        for waypoint in [*entries, *transit, *exits]
        if _point_in_walkable(_waypoint_point(waypoint), connected)
    }
    return WalkablePartition(
        connected=connected,
        disconnected=disconnected,
        excluded_obstacles=splitting,
        reachable_waypoint_ids=reachable_waypoint_ids,
    )


def filter_reachable_waypoints(
    waypoints: list[SimulationWaypoint],
    partition: WalkablePartition,
) -> list[SimulationWaypoint]:
    """Keep only waypoints that lie within the connected walkable component."""
    return [waypoint for waypoint in waypoints if waypoint.id in partition.reachable_waypoint_ids]


def waypoints_outside_disconnected_islands(
    waypoints: list[SimulationWaypoint],
    partition: WalkablePartition,
) -> list[SimulationWaypoint]:
    """Keep waypoints that do NOT sit on an excluded island.

    These must still satisfy the usual walkable constraints: a waypoint
    covered by an obstacle on the connected landmass (e.g. furniture moved on
    top of it) is a 422 violation, whereas a waypoint stranded on a
    disconnected island is silently dropped instead.
    """
    if not partition.disconnected:
        return list(waypoints)
    return [
        waypoint
        for waypoint in waypoints
        if not any(
            _point_in_walkable(_waypoint_point(waypoint), island)
            for island in partition.disconnected
        )
    ]


def m_ring_to_cm(ring) -> list[list[float]]:
    return [[round(_m_to_cm(x), 2), round(_m_to_cm(z), 2)] for x, z in ring.coords]


def polygon_to_cm(polygon: Polygon) -> dict:
    return {
        "exterior": m_ring_to_cm(polygon.exterior),
        "holes": [m_ring_to_cm(ring) for ring in polygon.interiors],
    }

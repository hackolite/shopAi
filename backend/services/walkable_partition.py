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

import hashlib
import json
import threading
from dataclasses import dataclass, field
from collections import OrderedDict

from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

from models.project import SceneData, SimulationConfig, SimulationWaypoint
from services.simulation import (
    AGENT_RADIUS_CM,
    BOUNDARY_CLEARANCE_EPSILON_CM,
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
    # Simplified runtime geometry handed to the crowd simulator.
    runtime_connected: Polygon
    # Excluded islands (may be empty).
    disconnected: list[Polygon]
    # Obstacles whose subtraction split the walkable area
    # ({"elementType": "zone"|"furniture", "elementId", "elementLabel"}).
    excluded_obstacles: list[dict] = field(default_factory=list)
    # Ids of entries/transits/exits that lie within ``connected``.
    reachable_waypoint_ids: set[str] = field(default_factory=set)


@dataclass
class CompiledLayout:
    scene_hash: str
    store_polygon: Polygon
    components: list[Polygon]
    runtime_components: list[Polygon]
    excluded_obstacles: list[dict]
    obstacle_cell_size_m: float
    obstacle_spatial_index: dict[tuple[int, int], list[int]]


_COMPILED_LAYOUT_CACHE: OrderedDict[str, CompiledLayout] = OrderedDict()
_COMPILED_LAYOUT_CACHE_LOCK = threading.Lock()
_MAX_COMPILED_LAYOUTS = 16
_SPATIAL_INDEX_GRID_DIVISIONS = 32
_RUNTIME_OPENING_CLEARANCE_CM = AGENT_RADIUS_CM + BOUNDARY_CLEARANCE_EPSILON_CM
_RUNTIME_SIMPLIFICATION_TOLERANCE_CM = max(5.0, AGENT_RADIUS_CM * 0.5)
_RUNTIME_BUFFER_MIN_VERTEX_COUNT = 48


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


def _scene_hash(scene: SceneData) -> str:
    payload = json.dumps(
        scene.model_dump(mode="json", by_alias=True),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _collect_scene_obstacles(
    scene: SceneData,
    store_polygon: Polygon,
) -> list[tuple[dict, Polygon | MultiPolygon]]:
    obstacles: list[tuple[dict, Polygon | MultiPolygon]] = []
    for furniture in scene.furniture:
        obstacle = _furniture_polygon(furniture, store_polygon)
        if obstacle is not None:
            obstacles.append(
                (_obstacle_identity("furniture", furniture.id, furniture.name), obstacle)
            )
    for zone in getattr(scene.store, "zones", []) or []:
        obstacle = _zone_polygon(zone, store_polygon)
        if obstacle is not None:
            obstacles.append(
                (
                    _obstacle_identity("zone", getattr(zone, "id", None), getattr(zone, "label", None)),
                    obstacle,
                )
            )
    return obstacles


def _build_obstacle_spatial_index(
    store_polygon: Polygon,
    obstacles: list[tuple[dict, Polygon | MultiPolygon]],
) -> tuple[float, dict[tuple[int, int], list[int]]]:
    min_x, min_z, max_x, max_z = store_polygon.bounds
    cell_size_m = max(
        (max_x - min_x) / _SPATIAL_INDEX_GRID_DIVISIONS,
        (max_z - min_z) / _SPATIAL_INDEX_GRID_DIVISIONS,
        1e-6,
    )
    index: dict[tuple[int, int], list[int]] = {}
    for obstacle_index, (_identity, obstacle) in enumerate(obstacles):
        bounds = obstacle.bounds
        start_col = min(_SPATIAL_INDEX_GRID_DIVISIONS - 1, max(0, int((bounds[0] - min_x) // cell_size_m)))
        end_col = min(_SPATIAL_INDEX_GRID_DIVISIONS - 1, max(0, int((bounds[2] - min_x) // cell_size_m)))
        start_row = min(_SPATIAL_INDEX_GRID_DIVISIONS - 1, max(0, int((bounds[1] - min_z) // cell_size_m)))
        end_row = min(_SPATIAL_INDEX_GRID_DIVISIONS - 1, max(0, int((bounds[3] - min_z) // cell_size_m)))
        for col in range(start_col, end_col + 1):
            for row in range(start_row, end_row + 1):
                index.setdefault((col, row), []).append(obstacle_index)
    return cell_size_m, index


def _collect_splitting_obstacles(
    store_polygon: Polygon,
    obstacles: list[tuple[dict, Polygon | MultiPolygon]],
) -> tuple[object, list[dict]]:
    """Subtract every obstacle once, collecting all that split the walkable area."""

    obstacles_union = unary_union([obstacle for _identity, obstacle in obstacles]) if obstacles else None

    if obstacles_union is not None and not obstacles_union.is_empty:
        global_walkable = store_polygon.difference(obstacles_union).buffer(0)
    else:
        global_walkable = store_polygon

    if not isinstance(global_walkable, MultiPolygon) or len(_walkable_components(global_walkable)) <= 1:
        return global_walkable, []

    walkable = store_polygon
    splitting: list[dict] = []
    for identity, obstacle in obstacles:
        overlap = walkable.intersection(obstacle)
        if overlap.is_empty:
            continue
        walkable = walkable.difference(obstacle)
        normalized = walkable.buffer(0)
        if isinstance(normalized, MultiPolygon) and len(_walkable_components(normalized)) > 1:
            splitting.append(identity)
    return walkable, splitting


def _normalize_polygon(
    geometry,
    *,
    anchor: tuple[float, float] | None = None,
) -> Polygon | None:
    if geometry.is_empty:
        return None
    geometry = geometry.buffer(0)
    if geometry.is_empty:
        return None
    if isinstance(geometry, MultiPolygon):
        geoms = [geom for geom in geometry.geoms if isinstance(geom, Polygon)]
        if not geoms:
            return None
        if anchor is not None:
            for geom in geoms:
                if _point_in_walkable(anchor, geom):
                    geometry = geom
                    break
            else:
                geometry = max(geoms, key=lambda geom: geom.area)
        else:
            geometry = max(geoms, key=lambda geom: geom.area)
    return geometry if isinstance(geometry, Polygon) else None


def _compile_runtime_component(component: Polygon) -> Polygon:
    """Compile a lighter runtime walkable for crowd simulation.

    The editing/preview geometry stays exact; the simulator gets an agent-centric
    version that removes sub-agent detail and micro-passages that only add
    computational cost.
    """

    clearance_m = _cm_to_m(_RUNTIME_OPENING_CLEARANCE_CM)
    tolerance_m = _cm_to_m(_RUNTIME_SIMPLIFICATION_TOLERANCE_CM)
    anchor = (component.representative_point().x, component.representative_point().y)
    vertex_count = len(component.exterior.coords) + sum(len(ring.coords) for ring in component.interiors)
    if vertex_count <= _RUNTIME_BUFFER_MIN_VERTEX_COUNT:
        compiled = _normalize_polygon(component, anchor=anchor)
    else:
        compiled = _normalize_polygon(
            component.buffer(-clearance_m, join_style="mitre").buffer(clearance_m, join_style="mitre"),
            anchor=anchor,
        )
    if compiled is None:
        compiled = _normalize_polygon(component, anchor=anchor)
    if compiled is None:
        return component
    simplified = compiled.simplify(tolerance_m, preserve_topology=True)
    normalized = _normalize_polygon(simplified, anchor=anchor) or compiled
    return _normalize_polygon(normalized, anchor=anchor) or normalized


def _build_compiled_layout(scene: SceneData) -> CompiledLayout:
    store_polygon = _store_polygon(scene.store)
    obstacles = _collect_scene_obstacles(scene, store_polygon)
    walkable, splitting = _collect_splitting_obstacles(store_polygon, obstacles)
    walkable = walkable.buffer(0)
    components = _walkable_components(walkable)
    runtime_components = [_compile_runtime_component(component) for component in components]
    cell_size_m, obstacle_spatial_index = _build_obstacle_spatial_index(store_polygon, obstacles)
    return CompiledLayout(
        scene_hash=_scene_hash(scene),
        store_polygon=store_polygon,
        components=components,
        runtime_components=runtime_components,
        excluded_obstacles=splitting,
        obstacle_cell_size_m=cell_size_m,
        obstacle_spatial_index=obstacle_spatial_index,
    )


def compiled_layout(scene: SceneData) -> CompiledLayout:
    scene_hash = _scene_hash(scene)
    with _COMPILED_LAYOUT_CACHE_LOCK:
        cached = _COMPILED_LAYOUT_CACHE.get(scene_hash)
        if cached is not None:
            _COMPILED_LAYOUT_CACHE.move_to_end(scene_hash)
            return cached
    built = _build_compiled_layout(scene)
    with _COMPILED_LAYOUT_CACHE_LOCK:
        cached = _COMPILED_LAYOUT_CACHE.get(scene_hash)
        if cached is not None:
            _COMPILED_LAYOUT_CACHE.move_to_end(scene_hash)
            return cached
        _COMPILED_LAYOUT_CACHE[scene_hash] = built
        while len(_COMPILED_LAYOUT_CACHE) > _MAX_COMPILED_LAYOUTS:
            _COMPILED_LAYOUT_CACHE.popitem(last=False)
    return built


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


def _choose_connected_component_index(
    components: list[Polygon],
    entries: list[SimulationWaypoint],
) -> int:
    """Pick the component containing the first entry; majority of entries wins,
    ties break to the largest area, and no entry at all falls back to largest."""
    if not entries:
        return max(range(len(components)), key=lambda index: components[index].area)
    entry_component_indexes: list[int] = []
    for entry in entries:
        point = _waypoint_point(entry)
        for index, component in enumerate(components):
            if _point_in_walkable(point, component):
                entry_component_indexes.append(index)
                break
    if not entry_component_indexes:
        return max(range(len(components)), key=lambda index: components[index].area)
    # Majority of entries decides; ties prefer the first entry's component,
    # then the largest area.
    first = entry_component_indexes[0]
    counts: dict[int, int] = {}
    for index in entry_component_indexes:
        counts[index] = counts.get(index, 0) + 1
    return max(
        counts,
        key=lambda index: (counts[index], index == first, components[index].area),
    )


def compute_walkable_partition(scene: SceneData, config: SimulationConfig) -> WalkablePartition:
    layout = compiled_layout(scene)
    if not layout.components:
        raise ValueError("Unable to derive a valid walkable area from the current store layout")

    # Raises SimulationConstraintViolation when waypoints exist but no exit.
    entries, transit, exits = _partition_waypoints(scene, config)

    connected_index = _choose_connected_component_index(layout.components, entries)
    connected = layout.components[connected_index]
    runtime_connected = layout.runtime_components[connected_index]
    disconnected = [
        component for index, component in enumerate(layout.components) if index != connected_index
    ]

    for exit_waypoint in exits:
        if not _point_in_walkable(_waypoint_point(exit_waypoint), connected):
            _raise_disconnected_exit(exit_waypoint, layout.excluded_obstacles)

    reachable_waypoint_ids = {
        waypoint.id
        for waypoint in [*entries, *transit, *exits]
        if _point_in_walkable(_waypoint_point(waypoint), connected)
    }
    if any(
        waypoint.id in reachable_waypoint_ids
        and not _point_in_walkable(_waypoint_point(waypoint), runtime_connected)
        for waypoint in [*entries, *transit, *exits]
    ):
        runtime_connected = connected
    return WalkablePartition(
        connected=connected,
        runtime_connected=runtime_connected,
        disconnected=disconnected,
        excluded_obstacles=layout.excluded_obstacles,
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

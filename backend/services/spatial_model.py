from __future__ import annotations

from dataclasses import dataclass, field
from heapq import heappop, heappush
import math

from shapely.geometry import GeometryCollection, LineString, MultiPolygon, Point, Polygon
from shapely.ops import triangulate


_NAVMESH_MIN_CELL_AREA_M2 = 1e-6
_NAVMESH_SHARED_EDGE_EPSILON_M = 1e-6
_NAVMESH_INDEX_GRID_DIVISIONS = 24


@dataclass(frozen=True)
class SpatialObstacle:
    obstacle_id: str
    element_type: str
    element_id: str | None
    element_label: str | None
    polygon: Polygon
    bounds: tuple[float, float, float, float]


@dataclass(frozen=True)
class BuildingBlock:
    block_id: str
    polygon: Polygon
    bounds: tuple[float, float, float, float]
    member_element_ids: tuple[str, ...] = ()
    member_osm_way_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class WalkableSurface:
    surface_id: str
    polygon: Polygon
    bounds: tuple[float, float, float, float]
    area_m2: float


@dataclass(frozen=True)
class NavMeshCell:
    cell_id: str
    polygon: Polygon
    centroid: tuple[float, float]
    bounds: tuple[float, float, float, float]
    area_m2: float


@dataclass(frozen=True)
class NavMeshPortal:
    portal_id: str
    from_cell_id: str
    to_cell_id: str
    segment: tuple[tuple[float, float], tuple[float, float]]
    midpoint: tuple[float, float]
    width_m: float


@dataclass
class NavMeshGraph:
    cells: list[NavMeshCell]
    adjacency: dict[str, list[str]]
    portals: list[NavMeshPortal]
    index_bounds: tuple[float, float, float, float]
    index_cell_size_m: float
    point_index: dict[tuple[int, int], list[str]] = field(default_factory=dict)
    _cell_lookup: dict[str, NavMeshCell] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        if not self._cell_lookup:
            self._cell_lookup = {cell.cell_id: cell for cell in self.cells}

    def cell(self, cell_id: str) -> NavMeshCell | None:
        return self._cell_lookup.get(cell_id)


@dataclass(frozen=True)
class SpatialModel:
    scene_hash: str
    static_obstacles: list[SpatialObstacle]
    building_blocks: list[BuildingBlock]
    walkable_surfaces: list[WalkableSurface]
    navmesh: NavMeshGraph
    bounds: tuple[float, float, float, float]


def _iter_polygons(geometry) -> list[Polygon]:
    if geometry is None or geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return [polygon for polygon in geometry.geoms if isinstance(polygon, Polygon)]
    if isinstance(geometry, GeometryCollection):
        polygons: list[Polygon] = []
        for geom in geometry.geoms:
            polygons.extend(_iter_polygons(geom))
        return polygons
    return [geom for geom in getattr(geometry, "geoms", []) if isinstance(geom, Polygon)]


def _normalize_polygon(geometry) -> Polygon | None:
    if geometry is None or geometry.is_empty:
        return None
    geometry = geometry.buffer(0)
    if geometry.is_empty:
        return None
    if isinstance(geometry, Polygon):
        return geometry if geometry.area > _NAVMESH_MIN_CELL_AREA_M2 else None
    polygons = [polygon for polygon in _iter_polygons(geometry) if polygon.area > _NAVMESH_MIN_CELL_AREA_M2]
    if not polygons:
        return None
    return max(polygons, key=lambda polygon: polygon.area)


def _polygon_signature(polygon: Polygon) -> str:
    return polygon.wkb_hex


def _bounds_intersect(
    left_bounds: tuple[float, float, float, float],
    right_bounds: tuple[float, float, float, float],
) -> bool:
    return not (
        left_bounds[2] < right_bounds[0]
        or right_bounds[2] < left_bounds[0]
        or left_bounds[3] < right_bounds[1]
        or right_bounds[3] < left_bounds[1]
    )


def build_navmesh_graph(
    walkable: Polygon,
    *,
    cell_id_prefix: str = "nav",
) -> NavMeshGraph:
    normalized_walkable = _normalize_polygon(walkable)
    if normalized_walkable is None:
        return NavMeshGraph(
            cells=[],
            adjacency={},
            portals=[],
            index_bounds=(0.0, 0.0, 0.0, 0.0),
            index_cell_size_m=1.0,
        )

    seen: set[str] = set()
    cells: list[NavMeshCell] = []
    for triangle in triangulate(normalized_walkable):
        clipped = triangle.intersection(normalized_walkable)
        for polygon in _iter_polygons(clipped):
            normalized = _normalize_polygon(polygon)
            if normalized is None:
                continue
            signature = _polygon_signature(normalized)
            if signature in seen:
                continue
            seen.add(signature)
            centroid = normalized.representative_point()
            cells.append(
                NavMeshCell(
                    cell_id=f"{cell_id_prefix}-{len(cells):04d}",
                    polygon=normalized,
                    centroid=(float(centroid.x), float(centroid.y)),
                    bounds=normalized.bounds,
                    area_m2=float(normalized.area),
                )
            )

    if not cells:
        centroid = normalized_walkable.representative_point()
        cells = [
            NavMeshCell(
                cell_id=f"{cell_id_prefix}-0000",
                polygon=normalized_walkable,
                centroid=(float(centroid.x), float(centroid.y)),
                bounds=normalized_walkable.bounds,
                area_m2=float(normalized_walkable.area),
            )
        ]

    adjacency: dict[str, list[str]] = {cell.cell_id: [] for cell in cells}
    portals: list[NavMeshPortal] = []
    for index, cell in enumerate(cells):
        for other in cells[index + 1 :]:
            if not _bounds_intersect(cell.bounds, other.bounds):
                continue
            shared = cell.polygon.boundary.intersection(other.polygon.boundary)
            if shared.is_empty:
                continue
            segment = _longest_shared_segment(shared)
            if segment is None:
                continue
            start, end = segment
            width_m = math.hypot(end[0] - start[0], end[1] - start[1])
            if width_m <= _NAVMESH_SHARED_EDGE_EPSILON_M:
                continue
            adjacency[cell.cell_id].append(other.cell_id)
            adjacency[other.cell_id].append(cell.cell_id)
            midpoint = ((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0)
            portals.append(
                NavMeshPortal(
                    portal_id=f"portal-{len(portals):04d}",
                    from_cell_id=cell.cell_id,
                    to_cell_id=other.cell_id,
                    segment=(start, end),
                    midpoint=midpoint,
                    width_m=width_m,
                )
            )

    for neighbors in adjacency.values():
        neighbors.sort()

    point_index_bounds = normalized_walkable.bounds
    point_index_cell_size_m, point_index = _build_point_index(point_index_bounds, cells)
    return NavMeshGraph(
        cells=cells,
        adjacency=adjacency,
        portals=portals,
        index_bounds=point_index_bounds,
        index_cell_size_m=point_index_cell_size_m,
        point_index=point_index,
    )


def _longest_shared_segment(shared_geometry) -> tuple[tuple[float, float], tuple[float, float]] | None:
    line_candidates: list[LineString] = []
    if isinstance(shared_geometry, LineString):
        line_candidates = [shared_geometry]
    else:
        line_candidates = [
            geom
            for geom in getattr(shared_geometry, "geoms", [])
            if isinstance(geom, LineString)
        ]
    if not line_candidates:
        return None
    longest = max(line_candidates, key=lambda geom: geom.length)
    coords = list(longest.coords)
    if len(coords) < 2:
        return None
    start = (float(coords[0][0]), float(coords[0][1]))
    end = (float(coords[-1][0]), float(coords[-1][1]))
    return start, end


def _build_point_index(
    bounds: tuple[float, float, float, float],
    cells: list[NavMeshCell],
) -> tuple[float, dict[tuple[int, int], list[str]]]:
    min_x, min_y, max_x, max_y = bounds
    cell_size_m = max(
        (max_x - min_x) / _NAVMESH_INDEX_GRID_DIVISIONS,
        (max_y - min_y) / _NAVMESH_INDEX_GRID_DIVISIONS,
        1e-6,
    )
    index: dict[tuple[int, int], list[str]] = {}
    for cell in cells:
        start_col = min(_NAVMESH_INDEX_GRID_DIVISIONS - 1, max(0, int((cell.bounds[0] - min_x) // cell_size_m)))
        end_col = min(_NAVMESH_INDEX_GRID_DIVISIONS - 1, max(0, int((cell.bounds[2] - min_x) // cell_size_m)))
        start_row = min(_NAVMESH_INDEX_GRID_DIVISIONS - 1, max(0, int((cell.bounds[1] - min_y) // cell_size_m)))
        end_row = min(_NAVMESH_INDEX_GRID_DIVISIONS - 1, max(0, int((cell.bounds[3] - min_y) // cell_size_m)))
        for col in range(start_col, end_col + 1):
            for row in range(start_row, end_row + 1):
                index.setdefault((col, row), []).append(cell.cell_id)
    return cell_size_m, index


def locate_navmesh_cell(graph: NavMeshGraph, point: tuple[float, float]) -> NavMeshCell | None:
    if not graph.cells:
        return None
    candidate_ids = _candidate_cell_ids(graph, point)
    target = Point(point)
    for cell_id in candidate_ids:
        cell = graph.cell(cell_id)
        if cell is not None and cell.polygon.covers(target):
            return cell
    for cell in graph.cells:
        if cell.polygon.covers(target):
            return cell
    return None


def _candidate_cell_ids(graph: NavMeshGraph, point: tuple[float, float]) -> list[str]:
    min_x, min_y, _max_x, _max_y = graph.index_bounds
    cell_size_m = max(graph.index_cell_size_m, 1e-6)
    col = min(_NAVMESH_INDEX_GRID_DIVISIONS - 1, max(0, int((point[0] - min_x) // cell_size_m)))
    row = min(_NAVMESH_INDEX_GRID_DIVISIONS - 1, max(0, int((point[1] - min_y) // cell_size_m)))
    return graph.point_index.get((col, row), [])


def astar_cell_path(
    graph: NavMeshGraph,
    start_point: tuple[float, float],
    end_point: tuple[float, float],
) -> list[str]:
    start_cell = locate_navmesh_cell(graph, start_point)
    end_cell = locate_navmesh_cell(graph, end_point)
    if start_cell is None or end_cell is None:
        return []
    if start_cell.cell_id == end_cell.cell_id:
        return [start_cell.cell_id]

    frontier: list[tuple[float, str]] = []
    heappush(frontier, (0.0, start_cell.cell_id))
    came_from: dict[str, str | None] = {start_cell.cell_id: None}
    g_score: dict[str, float] = {start_cell.cell_id: 0.0}

    while frontier:
        _priority, current = heappop(frontier)
        if current == end_cell.cell_id:
            return _reconstruct_path(came_from, current)
        current_cell = graph.cell(current)
        if current_cell is None:
            continue
        for neighbor in graph.adjacency.get(current, []):
            neighbor_cell = graph.cell(neighbor)
            if neighbor_cell is None:
                continue
            tentative = g_score[current] + math.hypot(
                neighbor_cell.centroid[0] - current_cell.centroid[0],
                neighbor_cell.centroid[1] - current_cell.centroid[1],
            )
            if tentative >= g_score.get(neighbor, math.inf):
                continue
            came_from[neighbor] = current
            g_score[neighbor] = tentative
            heuristic = math.hypot(
                end_cell.centroid[0] - neighbor_cell.centroid[0],
                end_cell.centroid[1] - neighbor_cell.centroid[1],
            )
            heappush(frontier, (tentative + heuristic, neighbor))
    return []


def _reconstruct_path(came_from: dict[str, str | None], current: str) -> list[str]:
    path = [current]
    while came_from[current] is not None:
        current = came_from[current]  # type: ignore[assignment]
        path.append(current)
    path.reverse()
    return path

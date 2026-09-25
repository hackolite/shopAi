from __future__ import annotations

from shapely.geometry import Polygon

from models.project import SceneData, SimulationConfig
import services.walkable_partition as walkable_partition
from services.walkable_partition import compiled_layout, compute_walkable_partition


def _scene(zone_x: float = 100.0) -> SceneData:
    return SceneData.model_validate(
        {
            "store": {
                "id": "store-1",
                "name": "Store",
                "position": [0.0, 0.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": 1200.0, "depth": 800.0, "height": 300.0},
                "zones": [
                    {
                        "id": "zone-1",
                        "type": "forbidden",
                        "label": "Bloc",
                        "x": zone_x,
                        "z": 150.0,
                        "width": 200.0,
                        "depth": 200.0,
                    }
                ],
            },
            "furniture": [],
        }
    )


def _scene_with_sawtooth_obstacle() -> SceneData:
    points = [
        {"x": 300.0, "z": 200.0},
        {"x": 900.0, "z": 200.0},
        {"x": 900.0, "z": 400.0},
    ]
    for index in range(29, -1, -1):
        x = 300.0 + index * 20.0
        points.append({"x": x + 10.0, "z": 410.0 if index % 2 == 0 else 400.0})
        points.append({"x": x, "z": 400.0 if index % 2 == 0 else 410.0})
    points.append({"x": 300.0, "z": 400.0})
    return SceneData.model_validate(
        {
            "store": {
                "id": "store-jagged",
                "name": "Store",
                "position": [0.0, 0.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": 1600.0, "depth": 1200.0, "height": 300.0},
                "zones": [
                    {
                        "id": "zone-jagged",
                        "type": "forbidden",
                        "shape": "polygon",
                        "label": "Sawtooth",
                        "x": 300.0,
                        "z": 200.0,
                        "width": 600.0,
                        "depth": 210.0,
                        "points": points,
                    }
                ],
            },
            "furniture": [],
        }
    )


def _config() -> SimulationConfig:
    return SimulationConfig.model_validate(
        {
            "waypoints": [
                {
                    "id": "entry-1",
                    "type": "entry",
                    "label": "Entrée",
                    "x": 40.0,
                    "z": 40.0,
                    "radiusCm": 120.0,
                    "optional": False,
                    "visitProbability": 1.0,
                    "retentionSeconds": 0.0,
                },
                {
                    "id": "exit-1",
                    "type": "exit",
                    "label": "Sortie",
                    "x": 1000.0,
                    "z": 700.0,
                    "radiusCm": 120.0,
                    "optional": False,
                    "visitProbability": 1.0,
                    "retentionSeconds": 0.0,
                },
            ]
        }
    )


def test_compiled_layout_cache_reuses_same_scene_geometry() -> None:
    scene = _scene()

    first = compiled_layout(scene)
    second = compiled_layout(scene)

    assert first is second
    assert first.components
    assert first.runtime_components
    assert first.obstacle_spatial_index


def test_compiled_layout_cache_misses_when_scene_changes() -> None:
    first = compiled_layout(_scene(zone_x=100.0))
    second = compiled_layout(_scene(zone_x=300.0))

    assert first is not second
    assert first.scene_hash != second.scene_hash


def test_compute_walkable_partition_reuses_compiled_geometry_with_new_waypoints() -> None:
    scene = _scene()
    config = _config()

    base = compute_walkable_partition(scene, config)
    moved = compute_walkable_partition(
        scene,
        config.model_copy(
            update={
                "waypoints": [
                    *config.waypoints[:-1],
                    config.waypoints[-1].model_copy(update={"x": 950.0}),
                ]
            }
        ),
    )

    assert base.connected.area == moved.connected.area
    assert base.runtime_connected.area == moved.runtime_connected.area
    assert base.excluded_obstacles == moved.excluded_obstacles


def test_runtime_walkable_is_simplified_relative_to_preview_geometry() -> None:
    partition = compute_walkable_partition(_scene_with_sawtooth_obstacle(), _config())

    exact_vertex_count = len(partition.connected.exterior.coords) + sum(
        len(ring.coords) for ring in partition.connected.interiors
    )
    runtime_vertex_count = len(partition.runtime_connected.exterior.coords) + sum(
        len(ring.coords) for ring in partition.runtime_connected.interiors
    )

    assert runtime_vertex_count < exact_vertex_count
    assert abs(partition.runtime_connected.area - partition.connected.area) < 1.0


def test_runtime_walkable_supports_simulation_setup_with_reachable_waypoints() -> None:
    import services.simulation as sim_svc

    scene = _scene_with_sawtooth_obstacle()
    config = SimulationConfig.model_validate(
        {
            "arrivalRatePerSecond": 0.2,
            "durationSeconds": 1.0,
            "maxCustomers": 1,
            "randomSeed": 7,
            "waypoints": [
                {
                    "id": "entry-1",
                    "type": "entry",
                    "label": "Entrée",
                    "x": 120.0,
                    "z": 120.0,
                    "radiusCm": 120.0,
                    "optional": False,
                    "visitProbability": 1.0,
                    "retentionSeconds": 0.0,
                },
                {
                    "id": "transit-1",
                    "type": "transit",
                    "label": "Transit",
                    "x": 980.0,
                    "z": 430.0,
                    "radiusCm": 120.0,
                    "optional": False,
                    "visitProbability": 1.0,
                    "retentionSeconds": 0.0,
                },
                {
                    "id": "exit-1",
                    "type": "exit",
                    "label": "Sortie",
                    "x": 1450.0,
                    "z": 1050.0,
                    "radiusCm": 120.0,
                    "optional": False,
                    "visitProbability": 1.0,
                    "retentionSeconds": 0.0,
                },
            ],
        }
    )

    result = sim_svc.run_flow_simulation(scene, config)

    assert result.frames


def test_spatial_model_builds_navmesh_and_astar_route() -> None:
    partition = compute_walkable_partition(_scene_with_sawtooth_obstacle(), _config())

    assert partition.spatial_model is not None
    assert partition.spatial_model.walkable_surfaces
    assert partition.spatial_model.navmesh.cells
    assert partition.spatial_model.navmesh.portals

    route = walkable_partition.navmesh_route_preview(
        partition,
        [_config().waypoints[0]],
        [_config().waypoints[1]],
    )
    assert route
    assert route[0] in partition.spatial_model.navmesh.adjacency


def test_spatial_model_exposes_building_blocks_for_osm_obstacles() -> None:
    scene_osm = SceneData.model_validate(
        {
            "store": {
                "id": "store-buildings",
                "name": "Store",
                "position": [0.0, 0.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": 2500.0, "depth": 1800.0, "height": 300.0},
                "zones": [
                    {
                        "id": "building-a",
                        "type": "forbidden",
                        "shape": "rectangle",
                        "label": "Building A",
                        "x": 200.0,
                        "z": 300.0,
                        "width": 400.0,
                        "depth": 900.0,
                        "_source": {"isLikelyBuilding": True, "osmWayId": "100"},
                    },
                    {
                        "id": "building-b",
                        "type": "forbidden",
                        "shape": "rectangle",
                        "label": "Building B",
                        "x": 620.0,
                        "z": 300.0,
                        "width": 400.0,
                        "depth": 900.0,
                        "_source": {"isLikelyBuilding": True, "osmWayId": "101"},
                    },
                ],
            },
            "furniture": [],
        }
    )

    partition = compute_walkable_partition(scene_osm, SimulationConfig.model_validate({"waypoints": []}))

    assert partition.spatial_model is not None
    assert partition.spatial_model.building_blocks
    assert any(
        set(block.member_osm_way_ids) >= {"100", "101"}
        for block in partition.spatial_model.building_blocks
    )


def test_runtime_obstacle_merge_fuses_likely_buildings_only() -> None:
    scene_osm = SceneData.model_validate(
        {
            "store": {
                "id": "store-buildings",
                "name": "Store",
                "position": [0.0, 0.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": 2500.0, "depth": 1800.0, "height": 300.0},
                "zones": [
                    {
                        "id": "building-a",
                        "type": "forbidden",
                        "shape": "rectangle",
                        "label": "Building A",
                        "x": 200.0,
                        "z": 300.0,
                        "width": 400.0,
                        "depth": 900.0,
                        "_source": {"isLikelyBuilding": True, "osmWayId": "100"},
                    },
                    {
                        "id": "building-b",
                        "type": "forbidden",
                        "shape": "rectangle",
                        "label": "Building B",
                        "x": 1100.0,
                        "z": 300.0,
                        "width": 400.0,
                        "depth": 900.0,
                        "_source": {"isLikelyBuilding": True, "osmWayId": "101"},
                    },
                ],
            },
            "furniture": [],
        }
    )
    scene_non_osm = scene_osm.model_copy(deep=True)
    for zone in scene_non_osm.store.zones:
        if zone.source:
            zone.source.pop("osmWayId", None)

    config = SimulationConfig.model_validate({"waypoints": []})
    osm_partition = compute_walkable_partition(scene_osm, config)
    non_osm_partition = compute_walkable_partition(scene_non_osm, config)

    assert osm_partition.connected.area < non_osm_partition.connected.area
    assert osm_partition.runtime_connected.area < non_osm_partition.runtime_connected.area


def test_runtime_obstacle_merge_ignores_non_osm_buildings() -> None:
    scene = SceneData.model_validate(
        {
            "store": {
                "id": "store-non-osm",
                "name": "Store",
                "position": [0.0, 0.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": 1200.0, "depth": 1200.0, "height": 300.0},
                "zones": [
                    {
                        "id": "manual-building-a",
                        "type": "forbidden",
                        "shape": "rectangle",
                        "label": "Manual A",
                        "x": 100.0,
                        "z": 100.0,
                        "width": 200.0,
                        "depth": 200.0,
                        "_source": {"isLikelyBuilding": True},
                    },
                    {
                        "id": "manual-building-b",
                        "type": "forbidden",
                        "shape": "rectangle",
                        "label": "Manual B",
                        "x": 500.0,
                        "z": 100.0,
                        "width": 200.0,
                        "depth": 200.0,
                        "_source": {"isLikelyBuilding": True},
                    },
                ],
            },
            "furniture": [],
        }
    )
    base = compute_walkable_partition(scene, SimulationConfig.model_validate({"waypoints": []}))
    again = compute_walkable_partition(scene, SimulationConfig.model_validate({"waypoints": []}))
    assert base.connected.area == again.connected.area


def test_runtime_obstacle_merge_is_recomputed_when_osm_buildings_move() -> None:
    scene = SceneData.model_validate(
        {
            "store": {
                "id": "store-edit-osm",
                "name": "Store",
                "position": [0.0, 0.0, 0.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": 2000.0, "depth": 1200.0, "height": 300.0},
                "zones": [
                    {
                        "id": "building-a",
                        "type": "forbidden",
                        "shape": "rectangle",
                        "label": "Building A",
                        "x": 100.0,
                        "z": 100.0,
                        "width": 300.0,
                        "depth": 500.0,
                        "_source": {"isLikelyBuilding": True, "osmWayId": "100"},
                    },
                    {
                        "id": "building-b",
                        "type": "forbidden",
                        "shape": "rectangle",
                        "label": "Building B",
                        "x": 430.0,
                        "z": 100.0,
                        "width": 300.0,
                        "depth": 500.0,
                        "_source": {"isLikelyBuilding": True, "osmWayId": "101"},
                    },
                ],
            },
            "furniture": [],
        }
    )
    moved_scene = scene.model_copy(deep=True)
    moved_scene.store.zones[1].x = 900.0

    first_layout = compiled_layout(scene)
    moved_layout = compiled_layout(moved_scene)
    first_partition = compute_walkable_partition(scene, SimulationConfig.model_validate({"waypoints": []}))
    moved_partition = compute_walkable_partition(
        moved_scene,
        SimulationConfig.model_validate({"waypoints": []}),
    )

    assert first_layout is not moved_layout
    assert first_layout.scene_hash != moved_layout.scene_hash
    assert first_partition.connected.area != moved_partition.connected.area
    assert first_partition.runtime_connected.area != moved_partition.runtime_connected.area


def test_runtime_obstacle_merge_convex_hull_guard_accepts_small_ratio() -> None:
    polygon = Polygon(
        [
            (0.0, 0.0),
            (80.0, 0.0),
            (80.0, 40.0),
            (46.0, 40.0),
            (46.0, 34.0),
            (34.0, 34.0),
            (34.0, 40.0),
            (0.0, 40.0),
        ]
    )
    identity = {"elementType": "zone", "elementId": "convex-ok", "elementLabel": "Convex OK"}

    normalized = walkable_partition._normalize_polygon(  # noqa: SLF001
        polygon.buffer(walkable_partition._NAV_BUILDING_ENVELOPE_BUFFER_M).buffer(  # noqa: SLF001
            -walkable_partition._NAV_BUILDING_ENVELOPE_BUFFER_M  # noqa: SLF001
        )
    )
    assert normalized is not None
    convex = walkable_partition._normalize_polygon(normalized.convex_hull)  # noqa: SLF001
    assert convex is not None
    assert convex.area <= normalized.area * walkable_partition._NAV_BUILDING_ENVELOPE_MAX_CONVEX_AREA_RATIO  # noqa: SLF001

    merged, gain = walkable_partition._merge_building_obstacles([(identity, polygon)])  # noqa: SLF001

    assert len(merged) == 1
    assert merged[0][1].area >= normalized.area
    assert gain["sourceObstacleCount"] == 1
    assert gain["runtimeObstacleCount"] == 1


def test_runtime_obstacle_merge_convex_hull_guard_rejects_large_ratio() -> None:
    polygon = Polygon(
        [
            (0.0, 0.0),
            (120.0, 0.0),
            (120.0, 80.0),
            (90.0, 80.0),
            (90.0, 20.0),
            (30.0, 20.0),
            (30.0, 80.0),
            (0.0, 80.0),
        ]
    )
    identity = {"elementType": "zone", "elementId": "convex-no", "elementLabel": "Convex NO"}

    normalized = walkable_partition._normalize_polygon(  # noqa: SLF001
        polygon.buffer(walkable_partition._NAV_BUILDING_ENVELOPE_BUFFER_M).buffer(  # noqa: SLF001
            -walkable_partition._NAV_BUILDING_ENVELOPE_BUFFER_M  # noqa: SLF001
        )
    )
    assert normalized is not None
    convex = walkable_partition._normalize_polygon(normalized.convex_hull)  # noqa: SLF001
    assert convex is not None
    assert convex.area > normalized.area * walkable_partition._NAV_BUILDING_ENVELOPE_MAX_CONVEX_AREA_RATIO  # noqa: SLF001

    merged, gain = walkable_partition._merge_building_obstacles([(identity, polygon)])  # noqa: SLF001

    assert len(merged) == 1
    assert merged[0][1].area < convex.area
    assert gain["sourceObstacleCount"] == 1
    assert gain["runtimeObstacleCount"] == 1


def test_runtime_obstacle_merge_drops_small_island_after_simplification() -> None:
    polygon = Polygon(
        [
            (0.0, 0.0),
            (8.0, 0.0),
            (8.0, 2.0),
            (0.0, 2.0),
        ]
    )
    identity = {"elementType": "zone", "elementId": "small", "elementLabel": "Small"}

    normalized = walkable_partition._normalize_polygon(  # noqa: SLF001
        polygon.buffer(walkable_partition._NAV_BUILDING_ENVELOPE_BUFFER_M).buffer(  # noqa: SLF001
            -walkable_partition._NAV_BUILDING_ENVELOPE_BUFFER_M  # noqa: SLF001
        )
    )
    assert normalized is not None
    assert normalized.area >= walkable_partition._NAV_BUILDING_ENVELOPE_MIN_AREA_M2  # noqa: SLF001

    merged, gain = walkable_partition._merge_building_obstacles([(identity, polygon)])  # noqa: SLF001

    assert merged == []
    assert gain["sourceObstacleCount"] == 1
    assert gain["runtimeObstacleCount"] == 0

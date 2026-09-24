from __future__ import annotations

from models.project import SceneData, SimulationConfig
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

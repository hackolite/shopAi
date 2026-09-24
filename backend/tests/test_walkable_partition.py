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
    assert base.excluded_obstacles == moved.excluded_obstacles

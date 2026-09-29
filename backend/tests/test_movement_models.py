from __future__ import annotations

import math
import random
import tempfile
from pathlib import Path

import jupedsim as jps
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from shapely.geometry import Polygon

import services.project_manager as pm
from models.project import SimulationConfig
from services.movement_models import (
    MOVEMENT_MODEL_IDS,
    CentrifugalForceStrategy,
    RepulsionSettings,
    SocialForceStrategy,
    VelocityBasedStrategy,
    create_movement_strategy,
    speed_dependent_range,
    strategy_from_config,
)

pm.STORAGE_ROOT = Path(tempfile.mkdtemp(prefix="shopai_movement_test_"))

from main import app  # noqa: E402

client = TestClient(app, raise_server_exceptions=True)


def test_speed_dependent_range_follows_formula() -> None:
    walking, lam, v0 = 0.8, 0.55, 1.34
    for speed in (0.0, 0.3, 1.34, 3.0):
        expected = walking * (1 - lam * math.exp(-speed / v0))
        assert speed_dependent_range(speed, walking, lam, v0) == pytest.approx(expected)
    # v -> 0 compresses the bubble to B_marche * (1 - λ).
    assert speed_dependent_range(0.0, walking, lam, v0) == pytest.approx(walking * (1 - lam))
    # Monotonically increasing towards B_marche.
    ranges = [speed_dependent_range(v / 10, walking, lam, v0) for v in range(0, 60)]
    assert ranges == sorted(ranges)
    assert ranges[-1] < walking


def test_speed_dependent_range_clamps_lambda_and_negative_speed() -> None:
    assert speed_dependent_range(0.0, 1.0, 0.9) == pytest.approx(1.0 - 0.7)
    assert speed_dependent_range(0.0, 1.0, 0.1) == pytest.approx(1.0 - 0.4)
    assert speed_dependent_range(-2.0, 1.0, 0.5) == speed_dependent_range(0.0, 1.0, 0.5)


def test_disabled_repulsion_keeps_walking_range() -> None:
    settings = RepulsionSettings(enabled=False, walking_range_m=0.8)
    assert settings.range_m(0.0) == pytest.approx(0.8)
    assert settings.scale(0.0) == pytest.approx(1.0)


def test_factory_returns_expected_strategies() -> None:
    assert set(MOVEMENT_MODEL_IDS) == {"social_force", "centrifugal_force", "velocity"}
    assert isinstance(create_movement_strategy("social_force"), SocialForceStrategy)
    assert isinstance(create_movement_strategy("centrifugal_force"), CentrifugalForceStrategy)
    assert isinstance(create_movement_strategy("velocity"), VelocityBasedStrategy)
    assert isinstance(create_movement_strategy(None), VelocityBasedStrategy)
    with pytest.raises(ValueError):
        create_movement_strategy("unknown")


def test_config_defaults_and_lambda_validation() -> None:
    config = SimulationConfig()
    assert config.movementModel == "velocity"
    assert config.speedDependentRepulsion.enabled is True
    assert config.speedDependentRepulsion.walkingRangeM == pytest.approx(0.8)
    assert config.speedDependentRepulsion.referenceSpeedMps == pytest.approx(1.34)
    assert 0.4 <= config.speedDependentRepulsion.compressionLambda <= 0.7
    with pytest.raises(ValidationError):
        SimulationConfig(speedDependentRepulsion={"compressionLambda": 0.9})
    with pytest.raises(ValidationError):
        SimulationConfig(movementModel="nope")
    strategy = strategy_from_config(
        SimulationConfig(movementModel="social_force", speedDependentRepulsion={"compressionLambda": 0.7}),
        0.25,
    )
    assert isinstance(strategy, SocialForceStrategy)
    assert strategy.repulsion.compression_lambda == pytest.approx(0.7)


def _crowd_density_at_target(model_id: str, repulsion: RepulsionSettings) -> float:
    """Density (pers/m²) within 1 m of a shared target all agents push towards."""
    strategy = create_movement_strategy(model_id, repulsion, 0.25)
    room = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    sim = jps.Simulation(model=strategy.create_model(), geometry=room, dt=strategy.simulation_dt(0.1))
    target = (5.0, 5.0)
    stage_id = sim.add_waypoint_stage(target, 0.3)
    journey_id = sim.add_journey(jps.JourneyDescription([stage_id]))
    rng = random.Random(1)
    positions: list[tuple[float, float]] = []
    while len(positions) < 120:
        candidate = (rng.uniform(0.5, 9.5), rng.uniform(0.5, 9.5))
        if all(math.dist(candidate, other) > 0.7 for other in positions):
            positions.append(candidate)
    for position in positions:
        sim.add_agent(strategy.build_agent_params(position, journey_id, stage_id, 1.34))
    for _ in range(400):
        strategy.advance(sim, 0.1)
    inside = sum(1 for agent in sim.agents() if math.dist(agent.position, target) < 1.0)
    return inside / math.pi


@pytest.mark.parametrize("model_id", ["social_force", "velocity"])
def test_speed_dependent_repulsion_increases_standstill_density(model_id: str) -> None:
    baseline = _crowd_density_at_target(model_id, RepulsionSettings(enabled=False))
    compressed = _crowd_density_at_target(model_id, RepulsionSettings(enabled=True, compression_lambda=0.7))
    assert compressed > baseline


def test_stopped_agent_gets_compressed_range() -> None:
    strategy = create_movement_strategy("velocity", RepulsionSettings(compression_lambda=0.5), 0.25)
    room = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    sim = jps.Simulation(model=strategy.create_model(), geometry=room, dt=strategy.simulation_dt(0.1))
    stage_id = sim.add_waypoint_stage((9.0, 5.0), 0.3)
    journey_id = sim.add_journey(jps.JourneyDescription([stage_id]))
    walker = sim.add_agent(strategy.build_agent_params((1.0, 5.0), journey_id, stage_id, 1.34))
    for _ in range(20):
        strategy.advance(sim, 0.1)
    moving_range = sim.agent(walker).model.range_neighbor_repulsion
    sim.agent(walker).model.desired_speed = 0.0
    for _ in range(5):
        strategy.advance(sim, 0.1)
    stopped_range = sim.agent(walker).model.range_neighbor_repulsion
    reference = VelocityBasedStrategy.RANGE_NEIGHBOR_REPULSION_REF_M
    assert stopped_range == pytest.approx(reference * 0.5, rel=1e-3)
    assert moving_range > stopped_range


@pytest.mark.parametrize("model_id", ["social_force", "centrifugal_force", "velocity"])
def test_run_simulation_with_each_movement_model(model_id: str) -> None:
    response = client.post("/api/cad/projects/", json={"name": f"movement-{model_id}"})
    assert response.status_code == 200, response.text
    project_id = response.json()["id"]
    scene = client.get(f"/api/cad/projects/{project_id}/scene").json()
    scene["store"]["zones"] = []
    scene["furniture"] = []

    response = client.post(
        f"/api/cad/projects/{project_id}/simulation/run",
        json={
            "scene": scene,
            "config": {
                "arrivalRatePerSecond": 0.5,
                "durationSeconds": 15,
                "maxCustomers": 6,
                "randomSeed": 3,
                "waypoints": [],
                "movementModel": model_id,
                "speedDependentRepulsion": {"compressionLambda": 0.6},
            },
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["summary"]["spawnedCustomers"] > 0
    assert payload["frames"]


@pytest.mark.parametrize("model_id", ["social_force", "centrifugal_force", "velocity"])
def test_live_simulation_runs_and_switches_movement_model(model_id: str) -> None:
    response = client.post("/api/cad/projects/", json={"name": f"live-movement-{model_id}"})
    assert response.status_code == 200, response.text
    project_id = response.json()["id"]
    scene = client.get(f"/api/cad/projects/{project_id}/scene").json()
    scene["store"]["zones"] = []
    scene["furniture"] = []
    config = {
        "arrivalRatePerSecond": 1.0,
        "maxCustomers": 10,
        "randomSeed": 4,
        "waypoints": [],
        "movementModel": model_id,
    }

    start = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/start",
        json={"scene": scene, "config": config},
    )
    assert start.status_code == 200, start.text
    session_id = start.json()["sessionId"]

    tick = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
        json={"steps": 40},
    )
    assert tick.status_code == 200, tick.text
    assert tick.json()["result"]["summary"]["spawnedCustomers"] > 0

    # Hot-switch to another model: carried agents are re-created with the new
    # model's parameters.
    other = next(candidate for candidate in MOVEMENT_MODEL_IDS if candidate != model_id)
    update = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/update",
        json={"scene": scene, "config": {**config, "movementModel": other}},
    )
    assert update.status_code == 200, update.text
    tick = client.post(
        f"/api/cad/projects/{project_id}/simulation/live/{session_id}/tick",
        json={"steps": 10},
    )
    assert tick.status_code == 200, tick.text

"""Pluggable pedestrian micro-movement models (Strategy + Factory pattern).

Three operational models from JuPedSim can drive the agents:

* ``social_force``      – Option A: Social Force Model (Helbing & Molnár).
  Second-order model: agents are accelerated by a driving force towards their
  goal and pushed away by exponential social / physical forces.
* ``centrifugal_force`` – Option B: Generalized Centrifugal Force Model
  (Chraibi et al.).  Repulsion depends on the relative velocity of the agents
  and is restricted to the field of view (agents only react to what is ahead).
  Bodies are speed-dependent ellipses.
* ``velocity``          – Option C: Velocity-based model (Collision-Free Speed
  Model, Tordeux et al.).  First-order model: the optimal velocity vector is
  computed directly from the free headway, which removes the oscillations and
  overlaps typical of force-based models.  This is the default.

All strategies share a *speed-dependent social repulsion range*::

    B(v) = B_marche * (1 - λ * exp(-v / v0))

* ``B_marche`` – social bubble radius at nominal walking speed (e.g. 0.8 m),
* ``v``        – instantaneous speed of the agent,
* ``v0``       – reference / desired speed (e.g. 1.34 m/s),
* ``λ``        – compression coefficient at standstill (λ ∈ [0.4, 0.7]).

When ``v → 0`` the range shrinks to ``B_marche * (1 - λ)``: stopped agents
accept a closer physical proximity, which lets the simulated density rise from
~2.5 pers/m² (free flow) to 4+ pers/m² (standstill / congestion, e.g. queues).

Each model has its own native "range" parameter, calibrated on the literature
for a reference bubble of ``REFERENCE_BUBBLE_M``.  B(v) is converted to the
native unit with ``native = native_reference * B(v) / REFERENCE_BUBBLE_M`` so
that ``B_marche`` stays a meaningful, model-independent tuning knob.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable

try:
    import jupedsim as jps
except ImportError:  # pragma: no cover - handled at runtime
    jps = None

# Social bubble radius (m) the native model constants below are calibrated for.
REFERENCE_BUBBLE_M = 0.8

DEFAULT_WALKING_RANGE_M = 0.8
DEFAULT_COMPRESSION_LAMBDA = 0.55
DEFAULT_REFERENCE_SPEED_MPS = 1.34
MIN_COMPRESSION_LAMBDA = 0.4
MAX_COMPRESSION_LAMBDA = 0.7

DEFAULT_MOVEMENT_MODEL = "velocity"


def speed_dependent_range(
    speed: float,
    walking_range_m: float = DEFAULT_WALKING_RANGE_M,
    compression_lambda: float = DEFAULT_COMPRESSION_LAMBDA,
    reference_speed_mps: float = DEFAULT_REFERENCE_SPEED_MPS,
) -> float:
    """Return B(v) = B_marche * (1 - λ * exp(-v / v0)) in metres.

    ``speed`` is clamped to ``>= 0`` and ``λ`` to ``[0.4, 0.7]``.
    """
    lam = min(MAX_COMPRESSION_LAMBDA, max(MIN_COMPRESSION_LAMBDA, float(compression_lambda)))
    v0 = max(1e-6, float(reference_speed_mps))
    v = max(0.0, float(speed))
    return float(walking_range_m) * (1.0 - lam * math.exp(-v / v0))


@dataclass(frozen=True)
class RepulsionSettings:
    """Runtime parameters of the speed-dependent repulsion range."""

    enabled: bool = True
    walking_range_m: float = DEFAULT_WALKING_RANGE_M
    compression_lambda: float = DEFAULT_COMPRESSION_LAMBDA
    reference_speed_mps: float = DEFAULT_REFERENCE_SPEED_MPS

    @classmethod
    def from_config(cls, config: Any) -> "RepulsionSettings":
        """Build settings from a ``SpeedDependentRepulsionConfig`` (or None)."""
        if config is None:
            return cls()
        return cls(
            enabled=bool(config.enabled),
            walking_range_m=float(config.walkingRangeM),
            compression_lambda=float(config.compressionLambda),
            reference_speed_mps=float(config.referenceSpeedMps),
        )

    def range_m(self, speed: float) -> float:
        """Social repulsion range B(v) in metres (B_marche when disabled)."""
        if not self.enabled:
            return self.walking_range_m
        return speed_dependent_range(
            speed,
            self.walking_range_m,
            self.compression_lambda,
            self.reference_speed_mps,
        )

    def scale(self, speed: float) -> float:
        """Ratio B(v) / REFERENCE_BUBBLE_M applied to native model ranges."""
        return self.range_m(speed) / REFERENCE_BUBBLE_M


class MovementModelStrategy(ABC):
    """Common interface of a JuPedSim operational (micro-movement) model."""

    model_id: str = ""
    label: str = ""
    # Number of JuPedSim iterations per application step.  Second-order
    # (force-based) models are stiff and need a finer time step than the
    # application's 0.1 s to stay numerically stable.
    substeps: int = 1

    def __init__(self, repulsion: RepulsionSettings, agent_radius_m: float) -> None:
        self.repulsion = repulsion
        self.agent_radius_m = float(agent_radius_m)
        # Last known position per agent id, used to measure the instantaneous
        # speed of models whose state does not expose it.
        self._previous_positions: dict[int, tuple[float, float]] = {}

    # -- model construction -------------------------------------------------

    @abstractmethod
    def create_model(self) -> Any:
        """Return the JuPedSim operational model instance."""

    @abstractmethod
    def build_agent_params(
        self,
        position: tuple[float, float],
        journey_id: int,
        stage_id: int,
        desired_speed: float,
    ) -> Any:
        """Return the JuPedSim agent parameters for this model.

        New agents start at rest, so their range is initialised with B(0).
        """

    # -- time stepping -------------------------------------------------------

    def simulation_dt(self, step_dt: float) -> float:
        """JuPedSim ``dt`` for an application step of ``step_dt`` seconds."""
        return float(step_dt) / self.substeps

    def advance(self, sim: Any, step_dt: float) -> list[int]:
        """Advance ``sim`` by one application step, then update B(v).

        Returns the ids of every agent removed during the step (JuPedSim only
        reports the removals of the *last* internal iteration).
        """
        removed: list[int] = []
        for _ in range(self.substeps):
            sim.iterate()
            removed.extend(int(agent_id) for agent_id in sim.removed_agents())
        self.apply_speed_dependent_repulsion(sim, step_dt)
        return removed

    # -- per-step dynamics ---------------------------------------------------

    @abstractmethod
    def _measure_speed(self, agent: Any, dt: float) -> float:
        """Instantaneous speed (m/s) of ``agent`` after the last iteration."""

    @abstractmethod
    def _apply_range(self, model_state: Any, scale: float) -> None:
        """Write the native repulsion range for ``scale = B(v) / B_ref``."""

    def _displacement_speed(self, agent: Any, dt: float) -> float:
        agent_id = int(agent.id)
        position = (float(agent.position[0]), float(agent.position[1]))
        previous = self._previous_positions.get(agent_id)
        if previous is None or dt <= 0:
            return 0.0
        return math.hypot(position[0] - previous[0], position[1] - previous[1]) / dt

    def apply_speed_dependent_repulsion(self, sim: Any, dt: float) -> None:
        """Update every agent's repulsion range from its current speed.

        Must be called once per ``sim.iterate()``.  No-op when disabled.
        """
        if not self.repulsion.enabled:
            return
        seen: dict[int, tuple[float, float]] = {}
        for agent in sim.agents():
            speed = self._measure_speed(agent, dt)
            self._apply_range(agent.model, self.repulsion.scale(speed))
            seen[int(agent.id)] = (float(agent.position[0]), float(agent.position[1]))
        # Dropping unseen ids also forgets agents removed by the simulation.
        self._previous_positions = seen


class SocialForceStrategy(MovementModelStrategy):
    """Option A – Social Force Model (acceleration forces).

    The social repulsion ``A * exp((r_ij - d_ij) / B)`` uses the per-agent
    ``force_distance`` (B).  Helbing & Molnár calibration: A = 2000 N,
    B = 0.08 m for the reference bubble.
    """

    model_id = "social_force"
    label = "Social Force Model"
    substeps = 5

    MASS_KG = 80.0
    REACTION_TIME_S = 0.5
    AGENT_SCALE_N = 2000.0
    OBSTACLE_SCALE_N = 2000.0
    FORCE_DISTANCE_REF_M = 0.08

    def create_model(self) -> Any:
        return jps.SocialForceModel()

    def build_agent_params(self, position, journey_id, stage_id, desired_speed):
        return jps.SocialForceModelAgentParameters(
            position=position,
            journey_id=journey_id,
            stage_id=stage_id,
            desired_speed=desired_speed,
            radius=self.agent_radius_m,
            mass=self.MASS_KG,
            reaction_time=self.REACTION_TIME_S,
            agent_scale=self.AGENT_SCALE_N,
            obstacle_scale=self.OBSTACLE_SCALE_N,
            force_distance=self.FORCE_DISTANCE_REF_M * self.repulsion.scale(0.0),
        )

    def _measure_speed(self, agent, dt):
        vx, vy = agent.model.velocity
        return math.hypot(float(vx), float(vy))

    def _apply_range(self, model_state, scale):
        model_state.force_distance = self.FORCE_DISTANCE_REF_M * scale


class CentrifugalForceStrategy(MovementModelStrategy):
    """Option B – Generalized Centrifugal Force Model.

    Repulsion is driven by the relative velocity and limited to the vision
    cone; bodies are ellipses whose semi-axes set the interaction range.
    B(v) scales those semi-axes (a_min, b_min, b_max).  The scale is floored
    at ``MIN_BODY_SCALE`` to keep a physical body core and avoid overlaps.
    """

    model_id = "centrifugal_force"
    label = "Centrifugal Force Model"
    substeps = 10
    MASS = 1.0
    TAU_S = 0.5
    A_V = 1.0
    A_MIN_REF_M = 0.2
    B_MIN_REF_M = 0.2
    B_MAX_REF_M = 0.4
    MIN_BODY_SCALE = 0.5

    def create_model(self) -> Any:
        return jps.GeneralizedCentrifugalForceModel()

    def _semi_axes(self, scale: float) -> tuple[float, float, float]:
        body_scale = max(self.MIN_BODY_SCALE, scale)
        return (
            self.A_MIN_REF_M * body_scale,
            self.B_MIN_REF_M * body_scale,
            self.B_MAX_REF_M * body_scale,
        )

    def build_agent_params(self, position, journey_id, stage_id, desired_speed):
        a_min, b_min, b_max = self._semi_axes(self.repulsion.scale(0.0))
        return jps.GeneralizedCentrifugalForceModelAgentParameters(
            position=position,
            journey_id=journey_id,
            stage_id=stage_id,
            desired_speed=desired_speed,
            mass=self.MASS,
            tau=self.TAU_S,
            a_v=self.A_V,
            a_min=a_min,
            b_min=b_min,
            b_max=b_max,
        )

    def _measure_speed(self, agent, dt):
        return abs(float(agent.model.speed))

    def _apply_range(self, model_state, scale):
        a_min, b_min, b_max = self._semi_axes(scale)
        model_state.a_min = a_min
        model_state.b_min = b_min
        model_state.b_max = b_max


class VelocityBasedStrategy(MovementModelStrategy):
    """Option C – Velocity-based model (Collision-Free Speed Model V2).

    The optimal velocity is computed directly (speed from the free headway,
    direction from exponential neighbour repulsion), which avoids the
    oscillations of force-based models.  B(v) drives the per-agent
    ``range_neighbor_repulsion`` (0.1 m for the reference bubble).
    """

    model_id = "velocity"
    label = "Velocity-Based Model"

    TIME_GAP_S = 1.0
    STRENGTH_NEIGHBOR_REPULSION = 8.0
    RANGE_NEIGHBOR_REPULSION_REF_M = 0.1
    STRENGTH_GEOMETRY_REPULSION = 5.0
    RANGE_GEOMETRY_REPULSION_M = 0.02

    def create_model(self) -> Any:
        return jps.CollisionFreeSpeedModelV2()

    def build_agent_params(self, position, journey_id, stage_id, desired_speed):
        return jps.CollisionFreeSpeedModelV2AgentParameters(
            position=position,
            journey_id=journey_id,
            stage_id=stage_id,
            desired_speed=desired_speed,
            radius=self.agent_radius_m,
            time_gap=self.TIME_GAP_S,
            strength_neighbor_repulsion=self.STRENGTH_NEIGHBOR_REPULSION,
            range_neighbor_repulsion=self.RANGE_NEIGHBOR_REPULSION_REF_M * self.repulsion.scale(0.0),
            strength_geometry_repulsion=self.STRENGTH_GEOMETRY_REPULSION,
            range_geometry_repulsion=self.RANGE_GEOMETRY_REPULSION_M,
        )

    def _measure_speed(self, agent, dt):
        # The CFSM state does not expose the speed: derive it from displacement.
        return self._displacement_speed(agent, dt)

    def _apply_range(self, model_state, scale):
        model_state.range_neighbor_repulsion = self.RANGE_NEIGHBOR_REPULSION_REF_M * scale


_STRATEGIES: dict[str, Callable[[RepulsionSettings, float], MovementModelStrategy]] = {
    SocialForceStrategy.model_id: SocialForceStrategy,
    CentrifugalForceStrategy.model_id: CentrifugalForceStrategy,
    VelocityBasedStrategy.model_id: VelocityBasedStrategy,
}

MOVEMENT_MODEL_IDS: tuple[str, ...] = tuple(_STRATEGIES)


def create_movement_strategy(
    model_id: str | None,
    repulsion: RepulsionSettings | None = None,
    agent_radius_m: float = 0.25,
) -> MovementModelStrategy:
    """Factory: instantiate the strategy registered under ``model_id``."""
    key = model_id or DEFAULT_MOVEMENT_MODEL
    factory = _STRATEGIES.get(key)
    if factory is None:
        raise ValueError(f"Unknown movement model '{key}'. Expected one of: {', '.join(MOVEMENT_MODEL_IDS)}")
    return factory(repulsion or RepulsionSettings(), agent_radius_m)


def strategy_from_config(config: Any, agent_radius_m: float) -> MovementModelStrategy:
    """Build the strategy selected by a ``SimulationConfig``."""
    return create_movement_strategy(
        getattr(config, "movementModel", None),
        RepulsionSettings.from_config(getattr(config, "speedDependentRepulsion", None)),
        agent_radius_m,
    )

from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


_FACE_VALUES = ("front", "back", "left", "right", "top", "bottom")


class CADBaseModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    @staticmethod
    def _validate_triplet(value: list[float], field_name: str) -> list[float]:
        if len(value) != 3:
            raise ValueError(f"{field_name} must contain exactly 3 values")
        return [float(component) for component in value]

    @staticmethod
    def _validate_dimensions(value: dict[str, float]) -> dict[str, float]:
        required = {"width", "depth", "height"}
        if set(value.keys()) != required:
            raise ValueError("dimensions must contain width, depth, and height")
        return {key: float(value[key]) for key in required}


class Face(str, Enum):
    front = "front"
    back = "back"
    left = "left"
    right = "right"
    top = "top"
    bottom = "bottom"


class ProjectSettings(CADBaseModel):
    gridSize: float = 100.0
    snapEnabled: bool = True
    showGrid: bool = True
    unit: str = "cm"
    cameraMode: str = "perspective"
    ambientLight: float = 0.8
    simulation: "SimulationConfig" = Field(default_factory=lambda: SimulationConfig())


class SimulationWaypoint(CADBaseModel):
    id: str
    label: str = "Point de passage"
    type: Literal["entry", "transit", "exit"] = "transit"
    x: float
    z: float
    radiusCm: float = 120.0
    optional: bool = False
    visitProbability: float = 0.65
    retentionSeconds: float = 0.0
    visionAngleDeg: float = 70.0
    visionRangeCm: float = 220.0


class SimulationConfig(CADBaseModel):
    enabled: bool = True
    arrivalRatePerSecond: float = 0.25
    durationSeconds: int = 120
    maxCustomers: int = 80
    randomSeed: int = 42
    desiredSpeedMps: float = 1.25
    speedVariation: float = 0.2
    waypoints: list[SimulationWaypoint] = Field(default_factory=list)


class SimulationAgentFrame(CADBaseModel):
    id: int
    xCm: float
    zCm: float
    headingX: float = 1.0
    headingZ: float = 0.0
    visionAngleDeg: float = 70.0
    visionRangeCm: float = 220.0
    # Set while the agent is retained at a product pickup queue (imported
    # pedestrian CSV journeys only); None otherwise.
    pickingEan: str | None = None
    pickingProductName: str | None = None
    pickingStartedAtSeconds: float | None = None
    pickingDurationSeconds: float | None = None


class WaypointSample(CADBaseModel):
    timeSeconds: float
    activeAgents: int
    releasedAgents: int


class WaypointMetrics(CADBaseModel):
    waypointId: str
    waypointLabel: str
    waypointType: Literal["entry", "transit", "exit"]
    retentionSeconds: float
    maxActiveAgents: int
    releasedAgents: int
    samples: list[WaypointSample] = Field(default_factory=list)
    # Queue (retention) statistics: how long agents actually stayed in the queue.
    queuedAgents: int = 0
    completedWaits: int = 0
    averageWaitSeconds: float = 0.0
    maxWaitSeconds: float = 0.0
    currentMaxWaitSeconds: float = 0.0


class SimulationHeatmap(CADBaseModel):
    """Cumulative agent occupancy grid, expressed in store coordinates (cm)."""

    cellSizeCm: float
    originXCm: float
    originZCm: float
    cols: int
    rows: int
    maxCount: int = 0
    # Row-major counts, ``rows * cols`` entries (row = Z axis, col = X axis).
    counts: list[int] = Field(default_factory=list)


class AgentTrajectory(CADBaseModel):
    agentId: int
    active: bool = True
    # Flat [x0, z0, x1, z1, …] list in cm, keeps the payload compact.
    pointsCm: list[float] = Field(default_factory=list)


class CustomerJourney(CADBaseModel):
    customerId: int
    entryTimeSeconds: float
    exitTimeSeconds: float | None = None
    totalTimeSeconds: float = 0.0
    distanceCm: float = 0.0
    active: bool = True


class SimulationAnalytics(CADBaseModel):
    timeSeconds: float = 0.0
    heatmap: SimulationHeatmap | None = None
    # Number of *agent entries* per cell (an agent walking into a cell counts
    # once, however long it stays).  Divided by ``timeSeconds`` it yields an
    # absolute client flow in persons per second, independent of the tick rate.
    visitHeatmap: SimulationHeatmap | None = None
    trajectories: list[AgentTrajectory] = Field(default_factory=list)
    customers: list[CustomerJourney] = Field(default_factory=list)


class SimulationFrame(CADBaseModel):
    timeSeconds: float
    agents: list[SimulationAgentFrame] = Field(default_factory=list)


class SimulationSummary(CADBaseModel):
    spawnedCustomers: int
    completedCustomers: int
    activeCustomers: int
    averageWaypointLoad: float
    maxWaypointLoad: int
    averageConfiguredRetentionSeconds: float


class PickupEvent(CADBaseModel):
    """One completed product pickup, emitted the tick it happens (for the
    frontend's gamified popup and the live 'produits pris' feed).
    """

    agentId: int
    pedestrianId: int
    ean: str
    name: str | None = None
    timeSeconds: float


class SimulationResult(CADBaseModel):
    frames: list[SimulationFrame] = Field(default_factory=list)
    waypoints: list[WaypointMetrics] = Field(default_factory=list)
    summary: SimulationSummary
    analytics: SimulationAnalytics | None = None
    # Product pickups completed since the previous tick (imported pedestrian
    # CSV journeys only) — drives the frontend's gamified pickup popup.
    pickupEvents: list["PickupEvent"] = Field(default_factory=list)


class Wall(CADBaseModel):
    id: str
    name: str
    position: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0])
    rotation: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0])
    dimensions: dict[str, float]
    materialId: str | None = None
    visible: bool = True
    locked: bool = False

    @field_validator("position")
    @classmethod
    def validate_position(cls, value: list[float]) -> list[float]:
        return cls._validate_triplet(value, "position")

    @field_validator("rotation")
    @classmethod
    def validate_rotation(cls, value: list[float]) -> list[float]:
        return cls._validate_triplet(value, "rotation")

    @field_validator("dimensions")
    @classmethod
    def validate_dimensions(cls, value: dict[str, float]) -> dict[str, float]:
        return cls._validate_dimensions(value)


class ZoneTypeEnum(str, Enum):
    entrance = "entrance"
    exit = "exit"
    supply = "supply"


class FloorZone(CADBaseModel):
    id: str
    type: ZoneTypeEnum
    label: str
    x: float
    z: float
    width: float
    depth: float
    rows: int | None = None
    cols: int | None = None


class Store(CADBaseModel):
    id: str
    name: str
    position: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0])
    rotation: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0])
    dimensions: dict[str, float]
    walls: list[Wall] = Field(default_factory=list)
    floorColor: str = '#1e2230'
    wallColor: str = '#404060'
    zones: list[FloorZone] = Field(default_factory=list)

    @field_validator("position")
    @classmethod
    def validate_position(cls, value: list[float]) -> list[float]:
        return cls._validate_triplet(value, "position")

    @field_validator("rotation")
    @classmethod
    def validate_rotation(cls, value: list[float]) -> list[float]:
        return cls._validate_triplet(value, "rotation")

    @field_validator("dimensions")
    @classmethod
    def validate_dimensions(cls, value: dict[str, float]) -> dict[str, float]:
        return cls._validate_dimensions(value)


class FurnitureInstance(CADBaseModel):
    id: str
    name: str
    type: str
    libraryId: str
    position: list[float]
    rotation: list[float]
    dimensions: dict[str, float]
    materialId: str | None = None
    visible: bool = True
    locked: bool = False
    mounted: bool = True
    parentId: str | None = None
    childIds: list[str] = Field(default_factory=list)
    faces: dict[str, str | None] = Field(
        default_factory=lambda: {face: None for face in _FACE_VALUES}
    )

    @field_validator("position")
    @classmethod
    def validate_position(cls, value: list[float]) -> list[float]:
        return cls._validate_triplet(value, "position")

    @field_validator("rotation")
    @classmethod
    def validate_rotation(cls, value: list[float]) -> list[float]:
        return cls._validate_triplet(value, "rotation")

    @field_validator("dimensions")
    @classmethod
    def validate_dimensions(cls, value: dict[str, float]) -> dict[str, float]:
        return cls._validate_dimensions(value)

    @field_validator("faces")
    @classmethod
    def validate_faces(cls, value: dict[str, str | None]) -> dict[str, str | None]:
        normalized = {str(key): planogram_id for key, planogram_id in value.items()}
        invalid = set(normalized) - set(_FACE_VALUES)
        if invalid:
            raise ValueError(f"Unknown furniture faces: {sorted(invalid)}")
        return {face: normalized.get(face) for face in _FACE_VALUES}


class FurnitureDefinition(CADBaseModel):
    id: str
    type: str
    name: str
    category: str
    defaultDimensions: dict[str, float]
    hasFaces: list[Face] = Field(default_factory=list)
    defaultMaterial: str
    description: str | None = None

    @field_validator("defaultDimensions")
    @classmethod
    def validate_dimensions(cls, value: dict[str, float]) -> dict[str, float]:
        return cls._validate_dimensions(value)


class PlanogramCell(CADBaseModel):
    id: str
    ean: str
    row: int
    col: int
    rotation: Literal[0, 90, 180, 270] = 0


class Planogram(CADBaseModel):
    id: str
    name: str
    furnitureId: str
    face: Face
    rows: int
    cols: int
    widthCm: float
    heightCm: float
    cells: list[PlanogramCell] = Field(default_factory=list)
    colWidthsCm: list[float] | None = None
    rowHeightsCm: list[float] | None = None
    cellWidthOverrides: dict[str, float] | None = None
    cellHeightOverrides: dict[str, float] | None = None
    rowColCounts: list[int] | None = None
    mergedSpans: dict[str, int] | None = None
    # §6 — new boundary-based internal model; when present, is the source of truth.
    gondola: Optional[Any] = None


class Product(CADBaseModel):
    ean: str
    name: str
    brand: str
    category: str
    subcategory: str | None = None
    productRange: str | None = None
    format: str | None = None
    widthCm: float
    depthCm: float
    heightCm: float
    weightG: float
    imageUrl: str | None = None
    priceBuyEur: float | None = None
    marginPct: float | None = None
    priceSellEur: float | None = None


class Catalog(CADBaseModel):
    products: list[Product] = Field(default_factory=list)


class Material(CADBaseModel):
    id: str
    name: str
    type: Literal["wood", "metal", "glass", "plastic", "solid_color", "texture"]
    color: str
    roughness: float = 0.5
    metalness: float = 0.0


class SceneData(CADBaseModel):
    store: Store
    furniture: list[FurnitureInstance] = Field(default_factory=list)


# ─── Pedestrian CSV import & pickup planning ────────────────────────────────
#
# A pedestrian CSV describes simulated visitors together with the products
# they intend to pick up (by EAN). One row per (pedestrian, product) pair;
# a pedestrian who buys nothing is represented by a single row with an empty
# ``ean``. See services/pedestrian_import.py for parsing/validation and
# services/pickup_planning.py for EAN → shelf-position resolution.


class PedestrianRecord(CADBaseModel):
    """One pedestrian aggregated from the imported CSV rows."""

    pedestrianId: int
    startUnixTs: int
    speedMps: float
    profile: dict[str, Any] = Field(default_factory=dict)
    wantedProducts: list[str] = Field(default_factory=list)


class PickupPlanItem(CADBaseModel):
    """One product of a pedestrian's basket, resolved to a shelf position."""

    ean: str
    name: str | None = None
    found: bool
    reasonNotFound: str | None = None
    xCm: float | None = None
    zCm: float | None = None
    pickupDurationSeconds: float | None = None


class PedestrianPickupPlan(CADBaseModel):
    """Ordered visit plan for one pedestrian: pickups between entry and exit."""

    pedestrianId: int
    startUnixTs: int
    speedMps: float
    profile: dict[str, Any] = Field(default_factory=dict)
    items: list[PickupPlanItem] = Field(default_factory=list)


class PedestrianImportAnomaly(CADBaseModel):
    """A row or product that could not be fully processed, for UI/log display."""

    rowNumber: int | None = None
    pedestrianId: int | None = None
    ean: str | None = None
    reason: str




class PedestrianImportResult(CADBaseModel):
    pedestrianCount: int
    rowCount: int
    plans: list[PedestrianPickupPlan] = Field(default_factory=list)
    anomalies: list[PedestrianImportAnomaly] = Field(default_factory=list)


class AgentBasketItem(CADBaseModel):
    """One product of a pedestrian's basket, with its live pickup status."""

    ean: str
    name: str | None = None
    found: bool
    reasonNotFound: str | None = None
    picked: bool = False
    pickedAtSeconds: float | None = None


class AgentBasket(CADBaseModel):
    """Detail panel payload for one pedestrian clicked in the 3D view."""

    pedestrianId: int
    agentId: int | None = None
    profile: dict[str, Any] = Field(default_factory=dict)
    items: list[AgentBasketItem] = Field(default_factory=list)
    active: bool = True

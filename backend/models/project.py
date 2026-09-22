from __future__ import annotations

import re
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


_FACE_VALUES = ("front", "back", "left", "right", "top", "bottom")
_FACE_ALIASES = {
    "waterfront": "front",
    "roadside": "back",
}
_CARDINAL_FACE_ALIASES = {
    "north": "back",
    "south": "front",
    "east": "right",
    "west": "left",
}
_DIMENSION_ALIASES = {
    "width": "width",
    "widthcm": "width",
    "depth": "depth",
    "depthcm": "depth",
    "length": "depth",
    "lengthcm": "depth",
    "height": "height",
    "heightcm": "height",
}


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
        normalized: dict[str, float] = {}
        for key, raw_component in value.items():
            canonical_key = _DIMENSION_ALIASES.get(str(key).strip().lower())
            if canonical_key is None:
                raise ValueError("dimensions must contain width, depth, and height")
            component = float(raw_component)
            if canonical_key in normalized and normalized[canonical_key] != component:
                raise ValueError("dimensions contain conflicting aliases")
            normalized[canonical_key] = component
        if set(normalized.keys()) != required:
            raise ValueError("dimensions must contain width, depth, and height")
        return {key: normalized[key] for key in required}

    @staticmethod
    def _normalize_face_name(value: Any) -> str:
        if isinstance(value, Enum):
            face = str(value.value).strip().lower()
        else:
            face = str(value).strip().lower()
        alias = _FACE_ALIASES.get(face)
        if alias is not None:
            return alias
        if face in _FACE_VALUES:
            return face
        tokens = [token for token in re.split(r"[^a-z0-9]+", face) if token]
        if not tokens:
            return face
        leading_token = tokens[0]
        if leading_token in _FACE_VALUES:
            return leading_token
        mapped = _CARDINAL_FACE_ALIASES.get(leading_token)
        if mapped is not None:
            return mapped
        return face


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


class SimulationWaypointSystem(CADBaseModel):
    id: str
    label: str = "Système JuPedSim"
    color: str = "#3b82f6"
    waypoints: list[SimulationWaypoint] = Field(default_factory=list)


class SimulationConfig(CADBaseModel):
    enabled: bool = True
    arrivalRatePerSecond: float = 0.25
    durationSeconds: int = 120
    maxCustomers: int = 80
    randomSeed: int = 42
    desiredSpeedMps: float = 1.25
    speedVariation: float = 0.2
    waypoints: list[SimulationWaypoint] = Field(default_factory=list)
    waypointSystems: list[SimulationWaypointSystem] = Field(default_factory=list)
    activeWaypointSystemId: str | None = None


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
    forbidden = "forbidden"


class ZoneShapeEnum(str, Enum):
    rectangle = "rectangle"
    circle = "circle"
    diamond = "diamond"
    polygon = "polygon"


def _default_zone_label(zone_type: "ZoneTypeEnum") -> str:
    if zone_type == ZoneTypeEnum.entrance:
        return "Entrée"
    if zone_type == ZoneTypeEnum.exit:
        return "Sortie sans achat"
    if zone_type == ZoneTypeEnum.supply:
        return "Fournitures"
    return "Zone interdite"


class FloorZonePoint(CADBaseModel):
    x: float
    z: float
    corner: bool | None = None


class FloorZone(CADBaseModel):
    id: str
    type: ZoneTypeEnum
    label: str
    x: float
    z: float
    width: float
    depth: float
    rotationDeg: float = 0.0
    rows: int | None = None
    cols: int | None = None
    shape: ZoneShapeEnum = ZoneShapeEnum.rectangle
    color: str | None = None
    points: list[FloorZonePoint] | None = None
    pathMode: Literal["linear", "smooth"] = "linear"
    mounted: bool = False
    heightCm: float = 120.0

    @model_validator(mode="before")
    @classmethod
    def normalize_dimension_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        for canonical_key in ("width", "depth"):
            matched_values = [
                (str(raw_key).strip().lower(), raw_value)
                for raw_key, raw_value in value.items()
                if _DIMENSION_ALIASES.get(str(raw_key).strip().lower()) == canonical_key
            ]
            if not matched_values:
                continue
            canonical_values = [raw_value for key, raw_value in matched_values if key == canonical_key]
            alias_values = [raw_value for key, raw_value in matched_values if key != canonical_key]
            if canonical_values:
                canonical_value = float(canonical_values[0])
                if any(float(alias) != canonical_value for alias in alias_values):
                    raise ValueError(f"Zone dimensions contain conflicting aliases for {canonical_key}")
                if any(
                    float(candidate) != canonical_value
                    for candidate in canonical_values[1:]
                ):
                    raise ValueError(f"Zone dimensions contain conflicting aliases for {canonical_key}")
                normalized[canonical_key] = canonical_values[0]
            else:
                first_alias = float(alias_values[0])
                if any(float(alias) != first_alias for alias in alias_values[1:]):
                    raise ValueError(f"Zone dimensions contain conflicting aliases for {canonical_key}")
                normalized[canonical_key] = alias_values[0]
        if "type" not in normalized or normalized["type"] in (None, ""):
            normalized["type"] = ZoneTypeEnum.forbidden.value
        zone_type = ZoneTypeEnum(str(normalized["type"]).strip().lower())
        if "label" not in normalized or normalized["label"] in (None, ""):
            normalized["label"] = _default_zone_label(zone_type)
        normalized.setdefault("x", 0.0)
        normalized.setdefault("z", 0.0)
        return normalized


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
        normalized: dict[str, str | None] = {}
        for key, planogram_id in value.items():
            canonical_face = cls._normalize_face_name(key)
            if canonical_face in normalized and normalized[canonical_face] != planogram_id:
                raise ValueError(f"Duplicate furniture face alias for {canonical_face}")
            normalized[canonical_face] = planogram_id
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

    @field_validator("face", mode="before")
    @classmethod
    def validate_face(cls, value: Any) -> str:
        return cls._normalize_face_name(value)


class Product(CADBaseModel):
    ean: str
    name: str
    brand: str
    category: str
    subcategory: str | None = None
    productRange: str | None = None
    format: str | None = None
    description: str | None = None
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

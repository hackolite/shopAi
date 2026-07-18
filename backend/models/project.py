from __future__ import annotations

from enum import Enum
from typing import Literal

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


class FloorZone(CADBaseModel):
    id: str
    type: ZoneTypeEnum
    label: str
    x: float
    z: float
    width: float
    depth: float


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


class Product(CADBaseModel):
    ean: str
    name: str
    brand: str
    category: str
    widthCm: float
    depthCm: float
    heightCm: float
    weightG: float
    imageUrl: str | None = None


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

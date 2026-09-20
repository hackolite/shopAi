from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints
from typing_extensions import Annotated

Category = Literal["layout-create", "layout-modify", "assortment-full", "assortment-modify", "freestyle"]
Identifier = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")]
Name = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=120)]
Number = Annotated[float, Field(allow_inf_nan=False, ge=-100000, le=100000)]
Positive = Annotated[float, Field(allow_inf_nan=False, gt=0, le=100000)]
Triplet = tuple[Number, Number, Number]


class PlanModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WebhookRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projectId: Identifier
    prompt: Annotated[
        str,
        StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=2000),
    ]
    confirm: StrictBool = False
    category: Category | None = None
    confirmationToken: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=512)] | None = None


class WebhookResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str
    requiresConfirmation: bool
    changed: bool
    projectId: str | None = None
    steps: list[str] = Field(default_factory=list)
    confirmationToken: str | None = None


class StoreDimensions(PlanModel):
    width: Positive
    depth: Positive
    height: Positive


class FurnitureChange(PlanModel):
    action: Literal["add", "update", "delete"]
    id: Identifier | None = None
    libraryId: Identifier | None = None
    name: Name | None = None
    position: Triplet | None = None
    rotation: Triplet | None = None
    dimensions: StoreDimensions | None = None


class ProductSpec(PlanModel):
    ean: Identifier
    name: Name
    brand: Name
    category: Name
    subcategory: str | None = None
    widthCm: Positive
    depthCm: Positive
    heightCm: Positive
    weightG: Positive
    imageUrl: str | None = None
    priceBuyEur: Annotated[float, Field(allow_inf_nan=False, ge=0)] | None = None
    priceSellEur: Annotated[float, Field(allow_inf_nan=False, ge=0)] | None = None
    marginPct: Annotated[float, Field(allow_inf_nan=False, ge=-100, le=100)] | None = None


class CellSpec(PlanModel):
    ean: Identifier
    row: Annotated[int, Field(strict=True, ge=0, le=49)]
    col: Annotated[int, Field(strict=True, ge=0, le=49)]


class PlanogramSpec(PlanModel):
    id: Identifier | None = None
    name: Name
    furnitureId: Identifier
    face: Literal["front", "back", "left", "right", "top", "bottom"]
    rows: Annotated[int, Field(strict=True, ge=1, le=50)] = 4
    cols: Annotated[int, Field(strict=True, ge=1, le=50)] = 6
    cells: list[CellSpec] = Field(default_factory=list, max_length=500)


class OrchestrationPlan(PlanModel):
    intent: Literal[
        "build_complete_store", "layout-create", "layout-modify",
        "assortment-full", "assortment-modify", "other",
    ]
    project_name: Name = "Magasin IA"
    store: StoreDimensions | None = None
    max_products: Annotated[int, Field(strict=True, ge=1, le=500)] = 200
    furniture: list[FurnitureChange] = Field(default_factory=list, max_length=80)
    products: list[ProductSpec] = Field(default_factory=list, max_length=500)
    planograms: list[PlanogramSpec] = Field(default_factory=list, max_length=100)

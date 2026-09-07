"""EAN → shelf position resolution and pickup-plan generation.

Ports the horizontal-layout maths of ``frontend/src/engine/planogramLayout.ts``
and ``frontend/src/engine/marginHeatmap.ts`` (``cellSpan`` / ``columnRect`` /
``isPointInMarginSource``) to Python so the backend can resolve a product's
EAN to a world-space (x, z) pickup position, the same way the 3D editor
positions the proximity disc and margin heatmap bands.
"""

from __future__ import annotations

import math
import random

from models.project import (
    Catalog,
    FurnitureInstance,
    PedestrianPickupPlan,
    PedestrianRecord,
    PickupPlanItem,
    Planogram,
    SceneData,
)

# Variable picking retention: 1s–4s per product, as requested.
MIN_PICKUP_DURATION_S = 1.0
MAX_PICKUP_DURATION_S = 4.0


def _effective_col_widths(planogram: Planogram) -> list[float]:
    cols = max(1, planogram.cols)
    if planogram.colWidthsCm and len(planogram.colWidthsCm) == planogram.cols:
        return list(planogram.colWidthsCm)
    return [planogram.widthCm / cols] * cols


def _row_cell_count(planogram: Planogram, row: int) -> int:
    if planogram.rowColCounts and row < len(planogram.rowColCounts):
        return max(1, planogram.rowColCounts[row])
    return max(1, planogram.cols)


def _row_cell_offsets_cm(planogram: Planogram, row: int) -> list[float]:
    count = _row_cell_count(planogram, row)
    total_width = max(0.0, planogram.widthCm)
    col_widths = _effective_col_widths(planogram)
    offsets = [0.0]
    cursor = 0.0
    for col in range(count):
        width = col_widths[col] if col < len(col_widths) else total_width / count
        if planogram.cellWidthOverrides:
            width = planogram.cellWidthOverrides.get(f"{row}-{col}", width)
        cursor = min(total_width, cursor + max(0.0, width))
        offsets.append(cursor)
    offsets[count] = total_width
    for index in range(count - 1, 0, -1):
        offsets[index] = min(offsets[index], offsets[index + 1])
    return offsets


def _cell_span(planogram: Planogram, row: int, col: int) -> tuple[float, float]:
    offsets = _row_cell_offsets_cm(planogram, row)
    index = min(max(0, col), len(offsets) - 2)
    x_cm = offsets[index]
    width_cm = offsets[index + 1] - offsets[index]
    total = max(1.0, planogram.widthCm)
    return x_cm / total, min(1.0, (x_cm + width_cm) / total)


def _column_rect(
    planogram: Planogram, furniture: FurnitureInstance, t0: float, t1: float
) -> tuple[float, float, float, float]:
    """Local-frame rectangle (x0, x1, z0, z1) the column radiates from."""
    width = furniture.dimensions["width"]
    depth = furniture.dimensions["depth"]
    face = planogram.face.value if hasattr(planogram.face, "value") else planogram.face
    if face == "back":
        return width / 2 - t1 * width, width / 2 - t0 * width, -depth / 2, 0.0
    if face == "right":
        return 0.0, width / 2, depth / 2 - t1 * depth, depth / 2 - t0 * depth
    if face == "left":
        return -width / 2, 0.0, t0 * depth - depth / 2, t1 * depth - depth / 2
    if face == "front":
        return t0 * width - width / 2, t1 * width - width / 2, 0.0, depth / 2
    # top/bottom: no aisle side, band covers the whole footprint depth.
    return t0 * width - width / 2, t1 * width - width / 2, -depth / 2, depth / 2


def _local_to_world(furniture: FurnitureInstance, local_x: float, local_z: float) -> tuple[float, float]:
    center_x = furniture.position[0] + furniture.dimensions["width"] / 2
    center_z = furniture.position[2] + furniture.dimensions["depth"] / 2
    theta = math.radians(furniture.rotation[1] if len(furniture.rotation) > 1 else 0.0)
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    # Inverse of the world→local rotation used by the 3D editor
    # (localX = dx*cos - dz*sin, localZ = dx*sin + dz*cos).
    dx = local_x * cos_t + local_z * sin_t
    dz = -local_x * sin_t + local_z * cos_t
    return center_x + dx, center_z + dz


def resolve_ean_position(
    ean: str,
    planograms: list[Planogram],
    furniture_by_id: dict[str, FurnitureInstance],
) -> tuple[float, float] | None:
    """Return the world (x_cm, z_cm) pickup position of the first shelf slot
    holding ``ean``, or ``None`` when the EAN is not placed in any planogram.
    """
    for planogram in planograms:
        furniture = furniture_by_id.get(planogram.furnitureId)
        if furniture is None:
            continue
        for cell in planogram.cells:
            if cell.ean != ean:
                continue
            t0, t1 = _cell_span(planogram, cell.row, cell.col)
            x0, x1, z0, z1 = _column_rect(planogram, furniture, t0, t1)
            local_x = (x0 + x1) / 2
            local_z = (z0 + z1) / 2
            return _local_to_world(furniture, local_x, local_z)
    return None


def _entry_point(scene: SceneData) -> tuple[float, float] | None:
    waypoints = scene.store.zones if hasattr(scene.store, "zones") else []
    for zone in waypoints or []:
        if getattr(zone, "type", None) == "entrance":
            return zone.x, zone.z
    return None


def build_pedestrian_plan(
    record: PedestrianRecord,
    scene: SceneData,
    planograms: list[Planogram],
    catalog: Catalog,
    rng: random.Random | None = None,
) -> PedestrianPickupPlan:
    """Resolve every EAN of a pedestrian's basket to a shelf pickup position.

    EAN not found in the catalog or not placed in any planogram are kept in
    the plan with ``found=False`` and a reason, instead of being silently
    dropped, so the frontend can surface an anomaly per product.

    Items are ordered by proximity (nearest-neighbour) starting from the
    store's entrance zone when one is defined, otherwise the CSV order of
    the basket is preserved.
    """
    rng = rng or random.Random()
    furniture_by_id = {furniture.id: furniture for furniture in scene.furniture}
    products_by_ean = {product.ean: product for product in catalog.products}

    items: list[PickupPlanItem] = []
    for ean in record.wantedProducts:
        product = products_by_ean.get(ean)
        if product is None:
            items.append(
                PickupPlanItem(ean=ean, found=False, reasonNotFound="EAN absent du catalogue")
            )
            continue

        position = resolve_ean_position(ean, planograms, furniture_by_id)
        if position is None:
            items.append(
                PickupPlanItem(
                    ean=ean,
                    name=product.name,
                    found=False,
                    reasonNotFound="Produit non placé dans un planogramme",
                )
            )
            continue

        x_cm, z_cm = position
        items.append(
            PickupPlanItem(
                ean=ean,
                name=product.name,
                found=True,
                xCm=x_cm,
                zCm=z_cm,
                pickupDurationSeconds=round(
                    rng.uniform(MIN_PICKUP_DURATION_S, MAX_PICKUP_DURATION_S), 2
                ),
            )
        )

    items = _order_by_proximity(items, _entry_point(scene))

    return PedestrianPickupPlan(
        pedestrianId=record.pedestrianId,
        startUnixTs=record.startUnixTs,
        speedMps=record.speedMps,
        profile=record.profile,
        items=items,
    )


def _order_by_proximity(
    items: list[PickupPlanItem], start: tuple[float, float] | None
) -> list[PickupPlanItem]:
    """Greedy nearest-neighbour ordering of the found items; not-found items
    are appended at the end (in CSV order) since they carry no position.
    """
    found = [item for item in items if item.found and item.xCm is not None and item.zCm is not None]
    not_found = [item for item in items if not item.found]
    if len(found) <= 1:
        return found + not_found

    current = start if start is not None else (found[0].xCm, found[0].zCm)
    remaining = list(found)
    ordered: list[PickupPlanItem] = []
    while remaining:
        remaining.sort(key=lambda item: math.hypot(item.xCm - current[0], item.zCm - current[1]))
        nxt = remaining.pop(0)
        ordered.append(nxt)
        current = (nxt.xCm, nxt.zCm)
    return ordered + not_found


def build_pickup_plans(
    records: dict[int, PedestrianRecord],
    scene: SceneData,
    planograms: list[Planogram],
    catalog: Catalog,
) -> list[PedestrianPickupPlan]:
    """Build one ordered pickup plan per pedestrian, sorted by start time."""
    plans = [
        build_pedestrian_plan(record, scene, planograms, catalog, rng=random.Random(record.pedestrianId))
        for record in records.values()
    ]
    plans.sort(key=lambda plan: plan.startUnixTs)
    return plans

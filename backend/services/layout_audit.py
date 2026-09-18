from __future__ import annotations

import math
from typing import Any

from models.project import Catalog, FurnitureInstance, Planogram, SceneData, Store
from services.retail_layout import build_retail_layout

LAYOUT_TOLERANCE_CM = 0.5


def _face_dimensions(furniture: FurnitureInstance, face: str) -> tuple[float, float]:
    width = float(furniture.dimensions["width"])
    depth = float(furniture.dimensions["depth"])
    height = float(furniture.dimensions["height"])
    face_lower = face.lower()
    if face_lower in {"front", "back"}:
        return width, height
    if face_lower in {"left", "right"}:
        return depth, height
    if face_lower in {"top", "bottom"}:
        return width, depth
    return width, height


def furniture_rotated_bounds(item: FurnitureInstance) -> tuple[float, float, float, float]:
    width = float(item.dimensions["width"])
    depth = float(item.dimensions["depth"])
    radians = math.radians(item.rotation[1])
    half_x = (abs(math.cos(radians)) * width + abs(math.sin(radians)) * depth) / 2
    half_z = (abs(math.sin(radians)) * width + abs(math.cos(radians)) * depth) / 2
    centre_x = item.position[0] + width / 2
    centre_z = item.position[2] + depth / 2
    return centre_x - half_x, centre_x + half_x, centre_z - half_z, centre_z + half_z


def validate_store(store: Store) -> list[str]:
    issues: list[str] = []
    width = float(store.dimensions["width"])
    depth = float(store.dimensions["depth"])
    height = float(store.dimensions["height"])
    if width <= 0:
        issues.append("Store width must be strictly positive")
    if depth <= 0:
        issues.append("Store depth must be strictly positive")
    if height <= 0:
        issues.append("Store height must be strictly positive")
    return issues


def validate_furniture_bounds(item: FurnitureInstance, store: Store) -> list[str]:
    issues: list[str] = []
    sx = float(store.position[0])
    sz = float(store.position[2])
    sw = float(store.dimensions["width"])
    sd = float(store.dimensions["depth"])
    min_x = float(item.position[0])
    min_z = float(item.position[2])
    max_x = min_x + float(item.dimensions["width"])
    max_z = min_z + float(item.dimensions["depth"])
    if min_x < sx - LAYOUT_TOLERANCE_CM or max_x > sx + sw + LAYOUT_TOLERANCE_CM:
        issues.append(f"{item.name}: furniture footprint exceeds store width bounds")
    if min_z < sz - LAYOUT_TOLERANCE_CM or max_z > sz + sd + LAYOUT_TOLERANCE_CM:
        issues.append(f"{item.name}: furniture footprint exceeds store depth bounds")
    return issues


def validate_planogram(
    planogram: Planogram,
    furniture: FurnitureInstance,
    valid_eans: set[str],
    *,
    strict_catalog: bool = True,
) -> list[str]:
    issues: list[str] = []
    if planogram.rows < 1:
        issues.append(f"{planogram.name}: rows must be >= 1")
    if planogram.cols < 1:
        issues.append(f"{planogram.name}: cols must be >= 1")
    if planogram.widthCm <= 0:
        issues.append(f"{planogram.name}: widthCm must be > 0")
    if planogram.heightCm <= 0:
        issues.append(f"{planogram.name}: heightCm must be > 0")

    face_width_cm, face_height_cm = _face_dimensions(furniture, planogram.face.value)
    if planogram.widthCm > face_width_cm + LAYOUT_TOLERANCE_CM:
        issues.append(
            f"{planogram.name}: width {planogram.widthCm:.1f} cm exceeds face width {face_width_cm:.1f} cm"
        )
    if planogram.heightCm > face_height_cm + LAYOUT_TOLERANCE_CM:
        issues.append(
            f"{planogram.name}: height {planogram.heightCm:.1f} cm exceeds face height {face_height_cm:.1f} cm"
        )

    if planogram.colWidthsCm is not None and len(planogram.colWidthsCm) != planogram.cols:
        issues.append(f"{planogram.name}: colWidthsCm length must equal cols")
    if planogram.rowHeightsCm is not None and len(planogram.rowHeightsCm) != planogram.rows:
        issues.append(f"{planogram.name}: rowHeightsCm length must equal rows")
    if planogram.rowColCounts is not None:
        if len(planogram.rowColCounts) != planogram.rows:
            issues.append(f"{planogram.name}: rowColCounts length must equal rows")
        elif any(count < 1 for count in planogram.rowColCounts):
            issues.append(f"{planogram.name}: rowColCounts values must be >= 1")

    seen_positions: set[tuple[int, int]] = set()
    for cell in planogram.cells:
        if strict_catalog and valid_eans and cell.ean not in valid_eans:
            issues.append(f"{planogram.name}: unknown product EAN '{cell.ean}'")
        if cell.row < 0 or cell.row >= planogram.rows:
            issues.append(f"{planogram.name}: cell '{cell.id}' row {cell.row} is outside [0, {planogram.rows - 1}]")
            continue
        row_col_cap = planogram.rowColCounts[cell.row] if planogram.rowColCounts else planogram.cols
        if cell.col < 0 or cell.col >= row_col_cap:
            issues.append(
                f"{planogram.name}: cell '{cell.id}' col {cell.col} is outside [0, {row_col_cap - 1}] for row {cell.row}"
            )
        key = (cell.row, cell.col)
        if key in seen_positions:
            issues.append(f"{planogram.name}: duplicate cell at row {cell.row}, col {cell.col}")
        seen_positions.add(key)
    return issues


def validate_layout_slots(scene: SceneData, planograms: list[Planogram], metadata: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    layout = build_retail_layout(
        project_id=str(metadata.get("id", scene.store.id)),
        scene=scene.model_dump(mode="json"),
        planograms=[planogram.model_dump(mode="json") for planogram in planograms],
        metadata=metadata,
    )
    furniture_by_id = {item.id: item for item in scene.furniture}

    for furniture_item in layout.get("furniture", []):
        furniture = furniture_by_id.get(furniture_item.get("id", ""))
        if furniture is None:
            continue
        px, py, pz = furniture.position
        fw = float(furniture.dimensions["width"])
        fd = float(furniture.dimensions["depth"])
        fh = float(furniture.dimensions["height"])
        for placement in furniture_item.get("placements", []):
            face = str(placement.get("face", "")).lower()
            for slot in placement.get("slots", []):
                pos = slot.get("absolutePositionCm", {})
                x = float(pos.get("x", 0.0))
                y = float(pos.get("y", 0.0))
                z = float(pos.get("z", 0.0))
                prefix = f"{furniture.name} {face} slot {slot.get('cellId', '?')}"
                if face == "front":
                    if abs(z - pz) > LAYOUT_TOLERANCE_CM:
                        issues.append(f"{prefix}: z must sit on the front face")
                    if not (px - LAYOUT_TOLERANCE_CM <= x <= px + fw + LAYOUT_TOLERANCE_CM):
                        issues.append(f"{prefix}: x lies outside furniture width")
                    if not (py - LAYOUT_TOLERANCE_CM <= y <= py + fh + LAYOUT_TOLERANCE_CM):
                        issues.append(f"{prefix}: y lies outside furniture height")
                elif face == "back":
                    if abs(z - (pz + fd)) > LAYOUT_TOLERANCE_CM:
                        issues.append(f"{prefix}: z must sit on the back face")
                elif face == "left":
                    if abs(x - px) > LAYOUT_TOLERANCE_CM:
                        issues.append(f"{prefix}: x must sit on the left face")
                elif face == "right":
                    if abs(x - (px + fw)) > LAYOUT_TOLERANCE_CM:
                        issues.append(f"{prefix}: x must sit on the right face")
                elif face == "top":
                    if abs(y - (py + fh)) > LAYOUT_TOLERANCE_CM:
                        issues.append(f"{prefix}: y must sit on the top face")
                if not (px - LAYOUT_TOLERANCE_CM <= x <= px + fw + LAYOUT_TOLERANCE_CM):
                    issues.append(f"{prefix}: x lies outside furniture bounds")
                if not (py - LAYOUT_TOLERANCE_CM <= y <= py + fh + LAYOUT_TOLERANCE_CM):
                    issues.append(f"{prefix}: y lies outside furniture bounds")
                if not (pz - LAYOUT_TOLERANCE_CM <= z <= pz + fd + LAYOUT_TOLERANCE_CM):
                    issues.append(f"{prefix}: z lies outside furniture bounds")
    return issues


def audit_project_layout(
    metadata: dict[str, Any],
    scene: SceneData,
    catalog: Catalog,
    planograms: list[Planogram],
) -> dict[str, Any]:
    store_issues = validate_store(scene.store)
    furniture_issues: list[str] = []
    for item in scene.furniture:
        furniture_issues.extend(validate_furniture_bounds(item, scene.store))

    product_eans = {product.ean for product in catalog.products}
    furniture_by_id = {item.id: item for item in scene.furniture}
    planogram_issues: list[str] = []
    for planogram in planograms:
        furniture = furniture_by_id.get(planogram.furnitureId)
        if furniture is None:
            planogram_issues.append(
                f"{planogram.name}: furniture '{planogram.furnitureId}' does not exist"
            )
            continue
        planogram_issues.extend(validate_planogram(planogram, furniture, product_eans))

    slot_issues = validate_layout_slots(scene, planograms, metadata)
    all_issues = store_issues + furniture_issues + planogram_issues + slot_issues
    return {
        "projectId": str(metadata.get("id", scene.store.id)),
        "projectName": str(metadata.get("name", scene.store.name)),
        "capabilities": {
            "storeDimensioning": True,
            "furniturePlacement": True,
            "productPlacement": True,
            "productPositionVerification": True,
        },
        "agentPilot": {
            "script": "scripts/astra_build_store.py",
            "supportedLayoutModes": ["agent-generated", "user-supplied --layout"],
            "verificationSource": "export/retail-layout absolutePositionCm",
        },
        "checks": {
            "storeDimensions": {"ok": not store_issues, "issues": store_issues},
            "furnitureBounds": {"ok": not furniture_issues, "issues": furniture_issues},
            "planograms": {"ok": not planogram_issues, "issues": planogram_issues},
            "slotPositions": {"ok": not slot_issues, "issues": slot_issues},
        },
        "ok": not all_issues,
        "issueCount": len(all_issues),
    }

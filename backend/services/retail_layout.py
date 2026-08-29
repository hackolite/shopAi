"""Retail layout: fusion export and split import.

Export (build_retail_layout)
    Joins scene.json (furniture positions) and planograms.json (EAN placements)
    into a single denormalised RetailLayout document suitable for exchange with
    WMS / ERP / space-planning tools.  Each furniture item carries its planograms
    inline.  Each planogram slot exposes the absolute position of the product in
    the store coordinate system (cm, origin at store bottom-left corner).

Import (split_retail_layout)
    Reconstructs the two internal files from a RetailLayout document while
    preserving all IDs so that furniture ↔ planogram links remain intact.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slot_absolute_position(
    furniture_position: list[float],
    furniture_dimensions: dict[str, float],
    face: str,
    planogram_width_cm: float,
    planogram_height_cm: float,
    rows: int,
    cols: int,
    row: int,
    col: int,
    col_widths: list[float] | None,
    row_heights: list[float] | None,
) -> dict[str, float]:
    """Return the absolute centre position (x, y, z) of a planogram slot in cm.

    furniture.position is the bottom-left corner of the bounding box.
    The Three.js group is placed at (px + W/2, py + H/2, pz + D/2).
    """
    px, py, pz = furniture_position[0], furniture_position[1], furniture_position[2]
    fw = furniture_dimensions.get("width", 0.0)
    fh = furniture_dimensions.get("height", 0.0)
    fd = furniture_dimensions.get("depth", 0.0)

    cell_w = (col_widths[col] if col_widths and col < len(col_widths)
              else planogram_width_cm / cols if cols else 0.0)
    cell_h = (row_heights[row] if row_heights and row < len(row_heights)
              else planogram_height_cm / rows if rows else 0.0)

    # Horizontal offset within the planogram face (left to right)
    x_offset = sum(
        col_widths[c] if col_widths and c < len(col_widths)
        else planogram_width_cm / cols
        for c in range(col)
    ) + cell_w / 2.0

    # Vertical offset within the planogram face (bottom to top)
    rows_from_bottom = rows - 1 - row
    y_offset = sum(
        row_heights[r] if row_heights and r < len(row_heights)
        else planogram_height_cm / rows
        for r in range(rows_from_bottom)
    ) + cell_h / 2.0

    face_lower = face.lower()

    if face_lower == "front":
        x = px + x_offset
        y = py + y_offset
        z = pz
    elif face_lower == "back":
        x = px + fw - x_offset
        y = py + y_offset
        z = pz + fd
    elif face_lower == "left":
        x = px
        y = py + y_offset
        z = pz + x_offset
    elif face_lower == "right":
        x = px + fw
        y = py + y_offset
        z = pz + fd - x_offset
    elif face_lower == "top":
        x = px + x_offset
        y = py + fh
        z = pz + y_offset
    elif face_lower == "bottom":
        x = px + x_offset
        y = py
        z = pz + y_offset
    else:
        x, y, z = px, py, pz

    return {"x": round(x, 4), "y": round(y, 4), "z": round(z, 4)}


# ---------------------------------------------------------------------------
# Build (export)
# ---------------------------------------------------------------------------

def build_retail_layout(
    project_id: str,
    scene: dict[str, Any],
    planograms: list[dict[str, Any]],
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Produce a denormalised RetailLayout dict from scene + planograms data.

    Parameters
    ----------
    project_id:
        The project identifier (included for traceability).
    scene:
        Parsed content of scene.json  {"store": {...}, "furniture": [...]}.
    planograms:
        List of raw planogram objects from planograms.json["planograms"].
    metadata:
        Optional project.json metadata (name, createdAt, updatedAt).

    Returns
    -------
    dict
        Retail layout document ready for JSON serialisation.
    """
    # Index planograms by ID for O(1) lookup
    plano_by_id: dict[str, dict[str, Any]] = {p["id"]: p for p in planograms}

    store = scene.get("store", {})
    store_dims = store.get("dimensions", {})

    furniture_items: list[dict[str, Any]] = []

    for furn in scene.get("furniture", []):
        furn_id = furn.get("id", "")
        furn_pos = furn.get("position", [0.0, 0.0, 0.0])
        furn_rot = furn.get("rotation", [0.0, 0.0, 0.0])
        furn_dims = furn.get("dimensions", {})

        placements: list[dict[str, Any]] = []

        for face, plano_id in (furn.get("faces") or {}).items():
            if not plano_id:
                continue
            plano = plano_by_id.get(plano_id)
            if plano is None:
                continue

            rows = plano.get("rows", 1)
            cols = plano.get("cols", 1)
            width_cm = plano.get("widthCm", 0.0)
            height_cm = plano.get("heightCm", 0.0)
            col_widths = plano.get("colWidthsCm")
            row_heights = plano.get("rowHeightsCm")

            slots: list[dict[str, Any]] = []
            for cell in plano.get("cells", []):
                abs_pos = _slot_absolute_position(
                    furn_pos, furn_dims, face,
                    width_cm, height_cm,
                    rows, cols,
                    cell.get("row", 0), cell.get("col", 0),
                    col_widths, row_heights,
                )
                slots.append({
                    "cellId": cell.get("id", ""),
                    "ean": cell.get("ean", ""),
                    "row": cell.get("row", 0),
                    "col": cell.get("col", 0),
                    "rotation": cell.get("rotation", 0),
                    "absolutePositionCm": abs_pos,
                })

            placements.append({
                "face": face,
                "planogramId": plano_id,
                "planogramName": plano.get("name", ""),
                "rows": rows,
                "cols": cols,
                "widthCm": width_cm,
                "heightCm": height_cm,
                "slots": slots,
            })

        furniture_items.append({
            "id": furn_id,
            "name": furn.get("name", ""),
            "type": furn.get("type", ""),
            "libraryId": furn.get("libraryId", ""),
            "position": {
                "x": furn_pos[0],
                "y": furn_pos[1],
                "z": furn_pos[2],
            },
            "rotation": {
                "x": furn_rot[0],
                "y": furn_rot[1],
                "z": furn_rot[2],
            },
            "dimensions": furn_dims,
            "placements": placements,
        })

    return {
        "version": "1.0",
        "projectId": project_id,
        "projectName": (metadata or {}).get("name", project_id),
        "exportedAt": _utc_now(),
        "unit": "cm",
        "store": {
            "id": store.get("id", ""),
            "name": store.get("name", ""),
            "dimensions": store_dims,
        },
        "furniture": furniture_items,
    }


# ---------------------------------------------------------------------------
# Split (import)
# ---------------------------------------------------------------------------

def split_retail_layout(
    layout: dict[str, Any],
    project_name: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Reconstruct scene dict and planograms list from a RetailLayout document.

    IDs are preserved so that furniture.faces → planogramId links remain intact.
    All planogram cells and gondola data are round-tripped verbatim from the
    original planogram objects embedded in each placement.

    Parameters
    ----------
    layout:
        Parsed RetailLayout document (output of build_retail_layout or JSON file).
    project_name:
        Optional name override for the store (falls back to layout["projectName"]).

    Returns
    -------
    (scene_dict, planograms_list)
        ``scene_dict``  — ready to write as scene.json
        ``planograms_list`` — ready to wrap in {"planograms": [...]} and write
                               as planograms.json
    """
    store_raw = layout.get("store", {})
    store_name = project_name or layout.get("projectName", store_raw.get("name", ""))

    furniture_out: list[dict[str, Any]] = []
    planograms_out: list[dict[str, Any]] = []

    for furn in layout.get("furniture", []):
        pos_raw = furn.get("position", {})
        rot_raw = furn.get("rotation", {})

        faces: dict[str, str | None] = {}
        for placement in furn.get("placements", []):
            face = placement.get("face", "")
            plano_id = placement.get("planogramId", "")
            if face and plano_id:
                faces[face] = plano_id

            # Reconstruct planogram from placement data.
            # Slots → cells (drop absolutePositionCm which is derived).
            cells = [
                {
                    "id": s.get("cellId", ""),
                    "ean": s.get("ean", ""),
                    "row": s.get("row", 0),
                    "col": s.get("col", 0),
                    "rotation": s.get("rotation", 0),
                }
                for s in placement.get("slots", [])
            ]

            planogram: dict[str, Any] = {
                "id": plano_id,
                "name": placement.get("planogramName", ""),
                "furnitureId": furn.get("id", ""),
                "face": face,
                "rows": placement.get("rows", 1),
                "cols": placement.get("cols", 1),
                "widthCm": placement.get("widthCm", 0.0),
                "heightCm": placement.get("heightCm", 0.0),
                "cells": cells,
            }
            # Preserve optional fields when present in the placement
            for optional_key in (
                "colWidthsCm",
                "rowHeightsCm",
                "cellWidthOverrides",
                "cellHeightOverrides",
                "rowColCounts",
                "mergedSpans",
                "gondola",
            ):
                if optional_key in placement:
                    planogram[optional_key] = placement[optional_key]

            planograms_out.append(planogram)

        furniture_out.append({
            "id": furn.get("id", ""),
            "name": furn.get("name", ""),
            "type": furn.get("type", ""),
            "libraryId": furn.get("libraryId", ""),
            "position": [
                pos_raw.get("x", 0.0),
                pos_raw.get("y", 0.0),
                pos_raw.get("z", 0.0),
            ],
            "rotation": [
                rot_raw.get("x", 0.0),
                rot_raw.get("y", 0.0),
                rot_raw.get("z", 0.0),
            ],
            "dimensions": furn.get("dimensions", {"width": 0.0, "depth": 0.0, "height": 0.0}),
            "materialId": furn.get("materialId"),
            "visible": furn.get("visible", True),
            "locked": furn.get("locked", False),
            "mounted": furn.get("mounted", True),
            "parentId": furn.get("parentId"),
            "childIds": furn.get("childIds", []),
            "faces": faces,
        })

    store_dict: dict[str, Any] = {
        "id": store_raw.get("id", ""),
        "name": store_name,
        "position": [0.0, 0.0, 0.0],
        "rotation": [0.0, 0.0, 0.0],
        "dimensions": store_raw.get("dimensions", {
            "width": 5000.0,
            "depth": 3000.0,
            "height": 400.0,
        }),
        "walls": [],
    }

    scene_dict: dict[str, Any] = {
        "store": store_dict,
        "furniture": furniture_out,
    }

    return scene_dict, planograms_out

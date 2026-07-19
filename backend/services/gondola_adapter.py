"""§6 Adaptation layer: Gondola ↔ legacy Planogram.

These functions ensure that the REST API and the 3D view continue to receive
cells/rows/cols-based Planogram data while the internal model is Gondola.

Functions:
  gondola_to_legacy_cells  — Gondola → (cells, rows, cols, …) for the REST API response
  legacy_cells_to_gondola  — legacy Planogram → Gondola for existing projects migration
"""
from __future__ import annotations

from uuid import uuid4

from models.gondola import (
    GondolaData,
    GondolaProductPlacement,
    GondolaShelf,
    GondolaSeparator,
)
from models.project import Planogram, PlanogramCell

DEFAULT_GONDOLA_DEPTH_CM = 45.0


def _sorted_seps(shelf: GondolaShelf) -> list[GondolaSeparator]:
    return sorted(shelf.separators, key=lambda s: s.position_cm)


def gondola_to_legacy_cells(gondola: GondolaData, base_planogram: Planogram) -> Planogram:
    """Derive cells, rows, cols, colWidths, rowHeights from a Gondola.

    The resulting Planogram is equivalent to the gondola's content and can be
    consumed by the 3D view (PlanogramFaceOverlay) without modification.

    Display order: row 0 = top shelf = shelves[-1], row N-1 = shelves[0].
    """
    shelf_count = len(gondola.shelves)
    rows = shelf_count
    cells: list[PlanogramCell] = []

    # Per-row heights (display order: row 0 = top)
    row_heights_cm: list[float] = []
    row_col_counts: list[int] = []
    cell_width_overrides: dict[str, float] = {}

    for display_row in range(shelf_count):
        phys_idx = shelf_count - 1 - display_row
        shelf = gondola.shelves[phys_idx]
        seps = _sorted_seps(shelf)
        box_count = max(0, len(seps) - 1)

        row_heights_cm.append(shelf.height_cm)
        row_col_counts.append(box_count)

        for bi in range(box_count):
            left_sep = seps[bi]
            right_sep = seps[bi + 1]
            width_cm = right_sep.position_cm - left_sep.position_cm
            cell_width_overrides[f"{display_row}-{bi}"] = width_cm

            # Find product placement
            placement = next(
                (p for p in gondola.productPlacements
                 if p.shelfId == shelf.id
                 and p.leftSeparatorId == left_sep.id
                 and p.rightSeparatorId == right_sep.id),
                None,
            )
            if placement:
                cells.append(PlanogramCell(
                    id=placement.cellId or str(uuid4()),
                    ean=placement.productId,
                    row=display_row,
                    col=bi,
                    rotation=placement.rotation,
                ))

    # Global cols = max box count across all shelves
    max_cols = max(row_col_counts) if row_col_counts else 1

    # Simplify rowColCounts: omit if every row has the same count as max_cols
    row_col_counts_out = None if all(c == max_cols for c in row_col_counts) else row_col_counts

    return base_planogram.model_copy(update={
        "rows": rows,
        "cols": max_cols,
        "widthCm": gondola.width_cm,
        "heightCm": gondola.height_cm,
        "cells": cells,
        "colWidthsCm": None,
        "rowHeightsCm": row_heights_cm if row_heights_cm else None,
        "rowColCounts": row_col_counts_out,
        "cellWidthOverrides": cell_width_overrides if cell_width_overrides else None,
        "cellHeightOverrides": None,
        "mergedSpans": None,
    })


def legacy_cells_to_gondola(planogram: Planogram) -> GondolaData:
    """Convert a legacy (cells-based) Planogram to a GondolaData.

    A regular grid of cells is translated to equidistant separators per shelf.
    display row 0 → shelves[-1] (top physical shelf); display row N-1 → shelves[0].
    """
    shelf_count = planogram.rows
    gondola_id = planogram.id

    # Effective column widths (global)
    if planogram.colWidthsCm and len(planogram.colWidthsCm) == planogram.cols:
        global_col_widths = planogram.colWidthsCm
    else:
        w = planogram.widthCm / max(planogram.cols, 1)
        global_col_widths = [w] * planogram.cols

    # Effective row heights
    if planogram.rowHeightsCm and len(planogram.rowHeightsCm) == planogram.rows:
        row_heights = planogram.rowHeightsCm
    else:
        h = planogram.heightCm / max(planogram.rows, 1)
        row_heights = [h] * planogram.rows

    shelves_by_phys: dict[int, GondolaShelf] = {}
    placements: list[GondolaProductPlacement] = []

    for display_row in range(shelf_count):
        phys_idx = shelf_count - 1 - display_row
        row_col_count = (planogram.rowColCounts[display_row]
                         if planogram.rowColCounts and display_row < len(planogram.rowColCounts)
                         else planogram.cols)

        shelf_id = str(uuid4())
        seps: list[GondolaSeparator] = []

        # Left boundary
        seps.append(GondolaSeparator(
            id=str(uuid4()), position_cm=0.0, type="virtual", movable=False,
        ))

        pos_x = 0.0
        for c in range(row_col_count):
            key = f"{display_row}-{c}"
            cell_w = (
                (planogram.cellWidthOverrides or {}).get(key)
                or (global_col_widths[c] if c < len(global_col_widths) else planogram.widthCm / max(planogram.cols, 1))
            )
            pos_x += cell_w
            if c < row_col_count - 1:
                seps.append(GondolaSeparator(
                    id=str(uuid4()), position_cm=pos_x, type="virtual", movable=True,
                ))

        # Right boundary
        seps.append(GondolaSeparator(
            id=str(uuid4()), position_cm=planogram.widthCm, type="virtual", movable=False,
        ))

        shelf = GondolaShelf(
            id=shelf_id,
            height_cm=row_heights[display_row],
            separators=seps,
        )
        shelves_by_phys[phys_idx] = shelf

        # Product placements
        for c in range(row_col_count):
            cell = next(
                (cl for cl in planogram.cells if cl.row == display_row and cl.col == c),
                None,
            )
            if cell:
                placements.append(GondolaProductPlacement(
                    productId=cell.ean,
                    shelfId=shelf_id,
                    leftSeparatorId=seps[c].id,
                    rightSeparatorId=seps[c + 1].id,
                    rotation=cell.rotation,
                    cellId=cell.id,
                ))

    shelves = [shelves_by_phys[i] for i in range(shelf_count)]

    return GondolaData(
        id=gondola_id,
        width_cm=planogram.widthCm,
        height_cm=planogram.heightCm,
        depth_cm=DEFAULT_GONDOLA_DEPTH_CM,
        shelves=shelves,
        productPlacements=placements,
    )

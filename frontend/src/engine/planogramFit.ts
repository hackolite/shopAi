import type { Planogram, PlanogramCell } from '../types/cad';

/**
 * Intelligent planogram fitting.
 *
 * A planogram is a merchandising face: it can never be wider or taller than the
 * furniture face it is mounted on, otherwise facings float in the void in 3D and
 * the shelf capacity is over-estimated. Rather than squashing every facing
 * (which would make products physically unrealistic), the fit keeps facings at
 * their real size and drops the columns / rows that no longer fit the face —
 * exactly what a catmanager does when a module is narrowed: the tail of the
 * linear is de-listed. A facing wider than the whole face is the only case that
 * is scaled down, since there is nothing left to drop.
 */

/** Below this width a facing is not readable/pickable anymore (cm). */
export const MIN_FACING_WIDTH_CM = 2;
/** Below this height a shelf cannot hold a product (cm). */
export const MIN_ROW_HEIGHT_CM = 2;
/** Dimensional slack tolerated before a planogram is considered oversized (cm). */
export const FIT_TOLERANCE_CM = 0.5;

function effectiveColWidths(planogram: Planogram): number[] {
  return planogram.colWidthsCm?.length === planogram.cols
    ? [...planogram.colWidthsCm]
    : Array(planogram.cols).fill(planogram.widthCm / planogram.cols);
}

function effectiveRowHeights(planogram: Planogram): number[] {
  return planogram.rowHeightsCm?.length === planogram.rows
    ? [...planogram.rowHeightsCm]
    : Array(planogram.rows).fill(planogram.heightCm / planogram.rows);
}

function cellWidth(planogram: Planogram, colWidths: number[], row: number, col: number): number {
  return (
    planogram.cellWidthOverrides?.[`${row}-${col}`] ??
    colWidths[col] ??
    planogram.widthCm / planogram.cols
  );
}

function pickRecord(
  record: Record<string, number> | undefined,
  keep: (row: number, col: number) => boolean,
): Record<string, number> | undefined {
  if (!record) return undefined;
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const [row, col] = key.split('-').map(Number);
    if (Number.isFinite(row) && Number.isFinite(col) && keep(row, col)) next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** True when the planogram exceeds the face it is mounted on. */
export function isPlanogramOversized(
  planogram: Planogram,
  faceWidthCm: number,
  faceHeightCm: number,
  toleranceCm = FIT_TOLERANCE_CM,
): boolean {
  return (
    planogram.widthCm > faceWidthCm + toleranceCm ||
    planogram.heightCm > faceHeightCm + toleranceCm
  );
}

/**
 * Resize a planogram so it fits the given furniture face.
 *
 * Returns the planogram unchanged when it already fits. The returned planogram
 * always keeps at least one row and one column so the face stays editable.
 */
export function fitPlanogramToFace(
  planogram: Planogram,
  faceWidthCm: number,
  faceHeightCm: number,
): Planogram {
  if (!isPlanogramOversized(planogram, faceWidthCm, faceHeightCm)) return planogram;

  const targetWidth = Math.max(MIN_FACING_WIDTH_CM, faceWidthCm);
  const targetHeight = Math.max(MIN_ROW_HEIGHT_CM, faceHeightCm);
  const colWidths = effectiveColWidths(planogram);
  const rowHeights = effectiveRowHeights(planogram);

  // ─── Rows: drop the bottom shelves that no longer fit the face height ───────
  let keptRows = planogram.rows;
  if (planogram.heightCm > targetHeight + FIT_TOLERANCE_CM) {
    let used = 0;
    keptRows = 0;
    for (const height of rowHeights) {
      if (keptRows > 0 && used + height > targetHeight + FIT_TOLERANCE_CM) break;
      used += height;
      keptRows += 1;
    }
    keptRows = Math.max(1, keptRows);
  }
  const keptRowHeights = rowHeights.slice(0, keptRows);
  // A single remaining row taller than the face is clipped to the face.
  if (keptRowHeights.length === 1 && keptRowHeights[0] > targetHeight) {
    keptRowHeights[0] = targetHeight;
  }

  // ─── Columns: keep the facings that physically fit, row by row ──────────────
  const keptColsByRow: number[] = [];
  const widthOverrides: Record<string, number> = { ...(planogram.cellWidthOverrides ?? {}) };
  for (let row = 0; row < keptRows; row++) {
    const rowCols = planogram.rowColCounts?.[row] ?? planogram.cols;
    let used = 0;
    let kept = 0;
    for (let col = 0; col < rowCols; col++) {
      const width = cellWidth(planogram, colWidths, row, col);
      if (kept > 0 && used + width > targetWidth + FIT_TOLERANCE_CM) break;
      used += width;
      kept += 1;
    }
    kept = Math.max(1, kept);
    // The only facing left is wider than the face: scale it down, nothing to drop.
    if (kept === 1 && cellWidth(planogram, colWidths, row, 0) > targetWidth) {
      widthOverrides[`${row}-0`] = targetWidth;
    }
    keptColsByRow.push(kept);
  }

  const cols = Math.max(1, ...keptColsByRow);
  const cells: PlanogramCell[] = planogram.cells.filter(
    (cell) => cell.row < keptRows && cell.col < (keptColsByRow[cell.row] ?? 0),
  );
  const keepCell = (row: number, col: number) =>
    row < keptRows && col < (keptColsByRow[row] ?? 0);
  const rowColCounts = keptColsByRow.every((count) => count === cols) ? undefined : keptColsByRow;

  return {
    ...planogram,
    rows: keptRows,
    cols,
    widthCm: targetWidth,
    heightCm: Math.min(planogram.heightCm, targetHeight),
    cells,
    // Widths/heights become explicit: the facings keep their physical size
    // instead of being re-derived from the (now smaller) face dimensions.
    colWidthsCm: colWidths.slice(0, cols),
    rowHeightsCm: keptRowHeights,
    cellWidthOverrides: pickRecord(widthOverrides, keepCell),
    cellHeightOverrides: pickRecord(planogram.cellHeightOverrides, keepCell),
    mergedSpans: pickRecord(planogram.mergedSpans, keepCell),
    rowColCounts,
  };
}

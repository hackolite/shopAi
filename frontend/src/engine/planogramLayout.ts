import type { Planogram } from '../types/cad';

/**
 * Horizontal layout of a planogram row, shared by every read-only consumer
 * (3D overlay texture, click hit-test, proximity disc, margin heatmap).
 *
 * The editor models a shelf as separators bounded by the gondola edges: the
 * last box of a row always ends at `widthCm`, whatever the recorded per-cell
 * widths say (see engine/gondola.legacyCellsToSeparators).  Stored planograms,
 * however, may carry per-cell widths whose sum is smaller than the planogram
 * width — typically after cells have been fused, when the merged cell keeps a
 * single-cell width.  Reading those widths literally leaves a hole on the right
 * of the row that only disappeared once the planogram had been opened in the
 * editor (Ctrl+click) and saved back.
 *
 * Normalising here makes the 3D view agree with the editor without any write.
 */

/** Effective global column widths (cm), falling back to an even split. */
export function effectiveColWidths(planogram: Pick<Planogram, 'cols' | 'widthCm' | 'colWidthsCm'>): number[] {
  const cols = Math.max(1, planogram.cols);
  return planogram.colWidthsCm?.length === planogram.cols
    ? planogram.colWidthsCm
    : Array<number>(cols).fill(planogram.widthCm / cols);
}

/** Number of cells on a row (per-row counts win over the global `cols`). */
export function rowCellCount(planogram: Planogram, row: number): number {
  return Math.max(1, planogram.rowColCounts?.[row] ?? planogram.cols);
}

/**
 * Left offsets (cm) of every cell of `row`, plus the row's right edge as a last
 * entry — so the array has `rowCellCount(row) + 1` entries and always ends at
 * `widthCm`.  Offsets are monotonic and clamped to the planogram width, so a
 * row whose recorded widths overflow yields zero-width trailing cells instead
 * of drawing outside the face.
 */
export function rowCellOffsetsCm(planogram: Planogram, row: number): number[] {
  const count = rowCellCount(planogram, row);
  const totalWidth = Math.max(0, planogram.widthCm);
  const colWidths = effectiveColWidths(planogram);
  const offsets: number[] = [0];
  let cursor = 0;
  for (let col = 0; col < count; col++) {
    const width =
      planogram.cellWidthOverrides?.[`${row}-${col}`] ??
      colWidths[col] ??
      totalWidth / count;
    cursor = Math.min(totalWidth, cursor + Math.max(0, width));
    offsets.push(cursor);
  }
  // Stretch the last cell to the row's right edge, exactly like the editor does.
  offsets[count] = totalWidth;
  for (let index = count - 1; index > 0; index--) {
    offsets[index] = Math.min(offsets[index], offsets[index + 1]);
  }
  return offsets;
}

/** Effective widths (cm) of every cell of `row`; they sum to `widthCm`. */
export function rowCellWidthsCm(planogram: Planogram, row: number): number[] {
  const offsets = rowCellOffsetsCm(planogram, row);
  return offsets.slice(1).map((end, index) => end - offsets[index]);
}

/** Left offset and width (cm) of a single cell. */
export function cellRectCm(planogram: Planogram, row: number, col: number): { xCm: number; widthCm: number } {
  const offsets = rowCellOffsetsCm(planogram, row);
  const index = Math.min(Math.max(0, col), offsets.length - 2);
  return { xCm: offsets[index], widthCm: offsets[index + 1] - offsets[index] };
}

/**
 * Column hit by a normalised horizontal coordinate `t` in [0,1] across the
 * planogram width.
 */
export function columnAtRatio(planogram: Planogram, row: number, t: number): number {
  const offsets = rowCellOffsetsCm(planogram, row);
  const totalWidth = Math.max(1, planogram.widthCm);
  const x = Math.min(1, Math.max(0, t)) * totalWidth;
  for (let col = 0; col < offsets.length - 1; col++) {
    if (x <= offsets[col + 1]) return col;
  }
  return offsets.length - 2;
}

import type { CADProduct, Scene, SimulationHeatmap } from '../types/cad';
import type { PickedProductSample } from '../store/simulationStore';
import { MARGIN_HEATMAP_CELL_CM, productMarginEur } from './marginHeatmap';

/** Same payload guard as the other floor heatmaps. */
const MAX_CELLS_PER_AXIS = 120;
/**
 * Radius (cm) around a pickup point over which its margin "radiates" on the
 * floor grid, so the heatmap shows a soft blob rather than a single cell.
 */
export const PICKED_MARGIN_INFLUENCE_CM = 80;

/**
 * Build a floor grid whose intensity is the margin (€) of the products
 * actually picked up so far in the running session, accumulated at the spot
 * where each pickup happened.
 *
 * Unlike `buildMarginHeatmap` (static exposed assortment, independent of any
 * simulation), this one only reflects real pickups: it highlights where
 * shoppers actually took margin off the shelves.
 *
 * Returns `null` when no pickup carries any margin yet, so callers can skip
 * the overlay instead of drawing an empty one.
 */
export function buildPickedMarginHeatmap(
  scene: Scene,
  log: PickedProductSample[],
  products: CADProduct[],
  cellSizeCm: number = MARGIN_HEATMAP_CELL_CM,
): SimulationHeatmap | null {
  if (log.length === 0) return null;

  const marginByEan = new Map<string, number>();
  for (const product of products) marginByEan.set(product.ean, productMarginEur(product));

  const originXCm = scene.store.position?.[0] ?? 0;
  const originZCm = scene.store.position?.[2] ?? 0;
  const widthCm = Math.max(1, scene.store.dimensions.width);
  const depthCm = Math.max(1, scene.store.dimensions.depth);
  const cell = Math.max(1, cellSizeCm, widthCm / MAX_CELLS_PER_AXIS, depthCm / MAX_CELLS_PER_AXIS);
  const cols = Math.max(1, Math.floor(widthCm / cell) + 1);
  const rows = Math.max(1, Math.floor(depthCm / cell) + 1);

  const counts = new Array<number>(cols * rows).fill(0);
  let maxCount = 0;

  for (const sample of log) {
    const marginEur = marginByEan.get(sample.ean) ?? 0;
    if (marginEur <= 0) continue;

    const radiusCells = Math.max(1, Math.ceil(PICKED_MARGIN_INFLUENCE_CM / cell));
    const colCenter = (sample.xCm - originXCm) / cell - 0.5;
    const rowCenter = (sample.zCm - originZCm) / cell - 0.5;
    const colStart = Math.max(0, Math.floor(colCenter - radiusCells));
    const colEnd = Math.min(cols - 1, Math.ceil(colCenter + radiusCells));
    const rowStart = Math.max(0, Math.floor(rowCenter - radiusCells));
    const rowEnd = Math.min(rows - 1, Math.ceil(rowCenter + radiusCells));

    for (let row = rowStart; row <= rowEnd; row++) {
      const zCm = originZCm + (row + 0.5) * cell;
      for (let col = colStart; col <= colEnd; col++) {
        const xCm = originXCm + (col + 0.5) * cell;
        const distance = Math.hypot(xCm - sample.xCm, zCm - sample.zCm);
        if (distance > PICKED_MARGIN_INFLUENCE_CM) continue;
        const weight = 1 - distance / PICKED_MARGIN_INFLUENCE_CM;
        const index = row * cols + col;
        const value = counts[index] + marginEur * weight;
        counts[index] = value;
        if (value > maxCount) maxCount = value;
      }
    }
  }

  if (maxCount <= 0) return null;
  return { cellSizeCm: cell, originXCm, originZCm, cols, rows, maxCount, counts };
}

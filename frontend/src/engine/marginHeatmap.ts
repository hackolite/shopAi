import type { CADProduct, FurnitureInstance, Planogram, Scene, SimulationHeatmap } from '../types/cad';

/** Default floor cell size (cm) of the margin grid — mirrors the traffic heatmap. */
export const MARGIN_HEATMAP_CELL_CM = 50;
/** Same payload guard as the backend traffic heatmap. */
const MAX_CELLS_PER_AXIS = 120;
/**
 * Distance (cm) in front of a shelf over which its margin still "radiates" on
 * the floor: roughly the aisle band a shopper stands in to pick the product.
 */
export const MARGIN_INFLUENCE_CM = 100;

/** Unit margin (€) of a product, from explicit prices or from the margin rate. */
export function productMarginEur(product: CADProduct): number {
  if (product.priceSellEur != null && product.priceBuyEur != null) {
    return Math.max(0, product.priceSellEur - product.priceBuyEur);
  }
  if (product.priceSellEur != null && product.marginPct != null) {
    return Math.max(0, (product.priceSellEur * product.marginPct) / 100);
  }
  return 0;
}

/**
 * Total margin (€) exposed by each furniture, summed over every facing of every
 * planogram linked to it.
 */
export function marginByFurniture(
  planograms: Iterable<Planogram>,
  products: CADProduct[],
): Map<string, number> {
  const marginByEan = new Map<string, number>();
  for (const product of products) marginByEan.set(product.ean, productMarginEur(product));

  const totals = new Map<string, number>();
  for (const planogram of planograms) {
    if (!planogram.furnitureId) continue;
    let total = 0;
    for (const cell of planogram.cells) total += marginByEan.get(cell.ean) ?? 0;
    if (total <= 0) continue;
    totals.set(planogram.furnitureId, (totals.get(planogram.furnitureId) ?? 0) + total);
  }
  return totals;
}

/**
 * Distance (cm) from a floor point to a furniture footprint, 0 when the point
 * lies on the footprint.  The footprint is the axis-aligned box rotated by the
 * furniture Y rotation around its centre.
 */
function distanceToFootprintCm(furniture: FurnitureInstance, xCm: number, zCm: number): number {
  const halfWidth = furniture.dimensions.width / 2;
  const halfDepth = furniture.dimensions.depth / 2;
  const centerX = furniture.position[0] + halfWidth;
  const centerZ = furniture.position[2] + halfDepth;
  const theta = ((furniture.rotation[1] ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const dx = xCm - centerX;
  const dz = zCm - centerZ;
  // Inverse rotation brings the point into the furniture local frame.
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  const overflowX = Math.max(0, Math.abs(localX) - halfWidth);
  const overflowZ = Math.max(0, Math.abs(localZ) - halfDepth);
  return Math.hypot(overflowX, overflowZ);
}

/**
 * Build a floor grid whose intensity is the margin (€) exposed around each
 * cell, so the heatmap highlights where the value of the assortment sits.
 *
 * Returns `null` when no furniture carries any margin, so callers can fall back
 * to a neutral view instead of drawing an empty overlay.
 */
export function buildMarginHeatmap(
  scene: Scene,
  planograms: Iterable<Planogram>,
  products: CADProduct[],
  cellSizeCm: number = MARGIN_HEATMAP_CELL_CM,
): SimulationHeatmap | null {
  const totals = marginByFurniture(planograms, products);
  if (totals.size === 0) return null;

  const originXCm = scene.store.position?.[0] ?? 0;
  const originZCm = scene.store.position?.[2] ?? 0;
  const widthCm = Math.max(1, scene.store.dimensions.width);
  const depthCm = Math.max(1, scene.store.dimensions.depth);
  const cell = Math.max(
    1,
    cellSizeCm,
    widthCm / MAX_CELLS_PER_AXIS,
    depthCm / MAX_CELLS_PER_AXIS,
  );
  const cols = Math.max(1, Math.floor(widthCm / cell) + 1);
  const rows = Math.max(1, Math.floor(depthCm / cell) + 1);

  const counts = new Array<number>(cols * rows).fill(0);
  let maxCount = 0;
  const contributors = scene.furniture
    .map((furniture) => ({ furniture, margin: totals.get(furniture.id) ?? 0 }))
    .filter((entry) => entry.margin > 0);
  if (contributors.length === 0) return null;

  for (const { furniture, margin } of contributors) {
    for (let row = 0; row < rows; row++) {
      const zCm = originZCm + (row + 0.5) * cell;
      for (let col = 0; col < cols; col++) {
        const xCm = originXCm + (col + 0.5) * cell;
        const distance = distanceToFootprintCm(furniture, xCm, zCm);
        if (distance > MARGIN_INFLUENCE_CM) continue;
        // Full weight on the footprint, linear falloff across the aisle band.
        const weight = 1 - distance / MARGIN_INFLUENCE_CM;
        const index = row * cols + col;
        const value = counts[index] + margin * weight;
        counts[index] = value;
        if (value > maxCount) maxCount = value;
      }
    }
  }

  if (maxCount <= 0) return null;
  return { cellSizeCm: cell, originXCm, originZCm, cols, rows, maxCount, counts };
}

import type { CADProduct, FurnitureInstance, Planogram, Scene, SimulationHeatmap } from '../types/cad';
import { cellRectCm } from './planogramLayout';

/** Default floor cell size (cm) of the margin grid — mirrors the traffic heatmap. */
export const MARGIN_HEATMAP_CELL_CM = 50;
/** Same payload guard as the backend traffic heatmap. */
const MAX_CELLS_PER_AXIS = 120;
/**
 * Distance (cm) in front of a shelf column over which its margin still
 * "radiates" on the floor: roughly the aisle band a shopper stands in to pick
 * the product.
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
 * Margin exposed by one planogram column, together with the floor rectangle it
 * radiates from, expressed in the furniture local frame (origin = footprint
 * centre, before the furniture Y rotation).
 */
export interface MarginColumnSource {
  furnitureId: string;
  planogramId: string;
  col: number;
  marginEur: number;
  /** Local-frame rectangle of the column band, in cm. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Whether a floor point belongs to the aisle influence area of a margin source. */
export function isPointInMarginSource(
  source: MarginColumnSource,
  furniture: FurnitureInstance,
  xCm: number,
  zCm: number,
): boolean {
  const centerX = furniture.position[0] + furniture.dimensions.width / 2;
  const centerZ = furniture.position[2] + furniture.dimensions.depth / 2;
  const theta = ((furniture.rotation[1] ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const dx = xCm - centerX;
  const dz = zCm - centerZ;
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  const overflowX = Math.max(source.x0 - localX, localX - source.x1, 0);
  const overflowZ = Math.max(source.z0 - localZ, localZ - source.z1, 0);
  return Math.hypot(overflowX, overflowZ) <= MARGIN_INFLUENCE_CM;
}

/**
 * Horizontal span [t0, t1] (0..1 across the planogram width) of one cell, using
 * the same normalised row layout as the 3D overlay so the heatmap bands line up
 * with the columns as drawn.
 */
function cellSpan(planogram: Planogram, row: number, col: number): [number, number] {
  const { xCm, widthCm } = cellRectCm(planogram, row, col);
  const total = Math.max(1, planogram.widthCm);
  return [xCm / total, Math.min(1, (xCm + widthCm) / total)];
}

/**
 * Map a horizontal span of the planogram onto the local floor rectangle the
 * column radiates from.  The band covers the half of the footprint on the side
 * of the planogram face, so a front planogram lights the front aisle only.
 *
 * The `t → local axis` mapping mirrors the one used to place the proximity disc
 * in the 3D editor, so the heatmap lines up with the columns as drawn.
 */
function columnRect(
  planogram: Planogram,
  furniture: FurnitureInstance,
  t0: number,
  t1: number,
): { x0: number; x1: number; z0: number; z1: number } {
  const width = furniture.dimensions.width;
  const depth = furniture.dimensions.depth;
  switch (planogram.face) {
    case 'back':
      return { x0: width / 2 - t1 * width, x1: width / 2 - t0 * width, z0: -depth / 2, z1: 0 };
    case 'right':
      return { x0: 0, x1: width / 2, z0: depth / 2 - t1 * depth, z1: depth / 2 - t0 * depth };
    case 'left':
      return { x0: -width / 2, x1: 0, z0: t0 * depth - depth / 2, z1: t1 * depth - depth / 2 };
    case 'front':
      return { x0: t0 * width - width / 2, x1: t1 * width - width / 2, z0: 0, z1: depth / 2 };
    default:
      // Top/bottom faces have no aisle side: keep the column band over the
      // whole footprint depth.
      return { x0: t0 * width - width / 2, x1: t1 * width - width / 2, z0: -depth / 2, z1: depth / 2 };
  }
}

/**
 * Margin sources, one per planogram column: each column contributes the sum of
 * the margins of the facings it holds, positioned on its own slice of the
 * furniture footprint.
 */
export function marginColumnSources(
  planograms: Iterable<Planogram>,
  products: CADProduct[],
  furnitureById: Map<string, FurnitureInstance>,
): MarginColumnSource[] {
  const marginByEan = new Map<string, number>();
  for (const product of products) marginByEan.set(product.ean, productMarginEur(product));

  const sources: MarginColumnSource[] = [];
  for (const planogram of planograms) {
    const furniture = planogram.furnitureId ? furnitureById.get(planogram.furnitureId) : undefined;
    if (!furniture) continue;
    // Cell spans may differ per row (per-row column counts and width
    // overrides): a column band covers the union of its cells' spans.
    const columns = new Map<number, { margin: number; t0: number; t1: number }>();
    for (const cell of planogram.cells) {
      const margin = marginByEan.get(cell.ean) ?? 0;
      const [t0, t1] = cellSpan(planogram, cell.row, cell.col);
      const current = columns.get(cell.col);
      if (current) {
        current.margin += margin;
        current.t0 = Math.min(current.t0, t0);
        current.t1 = Math.max(current.t1, t1);
      } else {
        columns.set(cell.col, { margin, t0, t1 });
      }
    }
    for (const [col, column] of columns) {
      sources.push({
        furnitureId: furniture.id,
        planogramId: planogram.id,
        col,
        marginEur: column.margin,
        ...columnRect(planogram, furniture, column.t0, column.t1),
      });
    }
  }
  return sources;
}

/**
 * Build a floor grid whose intensity is the margin (€) exposed around each
 * cell, column by column, so the heatmap highlights where the value of the
 * assortment sits along each shelf.
 *
 * Returns `null` when no column carries any margin, so callers can skip the
 * overlay instead of drawing an empty one.
 */
export function buildMarginHeatmap(
  scene: Scene,
  planograms: Iterable<Planogram>,
  products: CADProduct[],
  cellSizeCm: number = MARGIN_HEATMAP_CELL_CM,
): SimulationHeatmap | null {
  const furnitureById = new Map(scene.furniture.map((furniture) => [furniture.id, furniture]));
  const sources = marginColumnSources(planograms, products, furnitureById);
  if (sources.length === 0) return null;

  const originXCm = scene.store.position?.[0] ?? 0;
  const originZCm = scene.store.position?.[2] ?? 0;
  const widthCm = Math.max(1, scene.store.dimensions.width);
  const depthCm = Math.max(1, scene.store.dimensions.depth);
  const cell = Math.max(1, cellSizeCm, widthCm / MAX_CELLS_PER_AXIS, depthCm / MAX_CELLS_PER_AXIS);
  const cols = Math.max(1, Math.floor(widthCm / cell) + 1);
  const rows = Math.max(1, Math.floor(depthCm / cell) + 1);

  const counts = new Array<number>(cols * rows).fill(0);
  let maxCount = 0;

  for (const source of sources) {
    const furniture = furnitureById.get(source.furnitureId);
    if (!furniture) continue;
    const centerX = furniture.position[0] + furniture.dimensions.width / 2;
    const centerZ = furniture.position[2] + furniture.dimensions.depth / 2;
    const theta = ((furniture.rotation[1] ?? 0) * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    // World bounding box of the column band, widened by the influence radius,
    // so only the relevant grid cells are visited.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [localX, localZ] of [
      [source.x0, source.z0],
      [source.x0, source.z1],
      [source.x1, source.z0],
      [source.x1, source.z1],
    ]) {
      const worldX = centerX + localX * cos + localZ * sin;
      const worldZ = centerZ - localX * sin + localZ * cos;
      minX = Math.min(minX, worldX);
      maxX = Math.max(maxX, worldX);
      minZ = Math.min(minZ, worldZ);
      maxZ = Math.max(maxZ, worldZ);
    }
    const colStart = Math.max(0, Math.floor((minX - MARGIN_INFLUENCE_CM - originXCm) / cell));
    const colEnd = Math.min(cols - 1, Math.ceil((maxX + MARGIN_INFLUENCE_CM - originXCm) / cell));
    const rowStart = Math.max(0, Math.floor((minZ - MARGIN_INFLUENCE_CM - originZCm) / cell));
    const rowEnd = Math.min(rows - 1, Math.ceil((maxZ + MARGIN_INFLUENCE_CM - originZCm) / cell));

    for (let row = rowStart; row <= rowEnd; row++) {
      const zCm = originZCm + (row + 0.5) * cell;
      for (let col = colStart; col <= colEnd; col++) {
        const xCm = originXCm + (col + 0.5) * cell;
        const dx = xCm - centerX;
        const dz = zCm - centerZ;
        // Inverse rotation brings the floor point into the furniture local frame.
        const localX = dx * cos - dz * sin;
        const localZ = dx * sin + dz * cos;
        const overflowX = Math.max(source.x0 - localX, localX - source.x1, 0);
        const overflowZ = Math.max(source.z0 - localZ, localZ - source.z1, 0);
        const distance = Math.hypot(overflowX, overflowZ);
        if (distance > MARGIN_INFLUENCE_CM) continue;
        // Full weight on the column band, linear falloff across the aisle.
        const weight = 1 - distance / MARGIN_INFLUENCE_CM;
        const index = row * cols + col;
        const value = counts[index] + source.marginEur * weight;
        counts[index] = value;
        if (value > maxCount) maxCount = value;
      }
    }
  }

  if (maxCount <= 0) return null;
  return { cellSizeCm: cell, originXCm, originZCm, cols, rows, maxCount, counts };
}

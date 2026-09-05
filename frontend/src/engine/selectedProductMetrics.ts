import type { CADProduct, Planogram, Scene, SimulationHeatmap } from '../types/cad';
import { isPointInMarginSource, marginColumnSources, productMarginEur } from './marginHeatmap';
import type { MarginColumnSource } from './marginHeatmap';

/** Metrics of one selected facing (planogram cell) among the Shift+click selected cells. */
export interface SelectedProductMetric {
  /** Unique row key: one line per selected facing, never merged per EAN. */
  key: string;
  ean: string;
  name: string;
  /** Exposed margin (€) of this facing. */
  marginEur: number;
  /** Client flow (pers/s) measured in front of the product's columns. */
  passagesPerSecond: number;
  /** passages/s × exposed margin (€) → € of exposed margin per second. */
  eurPerSecond: number;
}

/** Aggregated metrics of the whole Shift+click selection. */
export interface SelectedProductsMetrics {
  products: SelectedProductMetric[];
  /** Total number of selected facings. */
  count: number;
  /** Total exposed margin (€): plain sum of the rows. */
  marginEur: number;
  /** Total client flow (pers/s): plain sum of the rows. */
  passagesPerSecond: number;
  /** Total €/s: plain sum of the per-row €/s. */
  eurPerSecond: number;
}

/**
 * Flow (pers/s) measured on the visit grid over the given margin sources.
 * Each visit cell is counted once even when several sources overlap it, so
 * cumulating products (Shift+click) never double-counts a passage.
 */
function passagesPerSecondOver(
  sources: MarginColumnSource[],
  furniture: Scene['furniture'][number],
  visits: SimulationHeatmap | null | undefined,
  timeSeconds: number,
): number {
  if (!visits || sources.length === 0) return 0;
  let passages = 0;
  for (let row = 0; row < visits.rows; row++) {
    for (let col = 0; col < visits.cols; col++) {
      const xCm = visits.originXCm + (col + 0.5) * visits.cellSizeCm;
      const zCm = visits.originZCm + (row + 0.5) * visits.cellSizeCm;
      if (sources.some((source) => isPointInMarginSource(source, furniture, xCm, zCm))) {
        passages += visits.counts[row * visits.cols + col] ?? 0;
      }
    }
  }
  return passages / Math.max(timeSeconds, 1);
}

/**
 * Metrics of the products selected with Shift+click in one planogram: one line
 * per selected facing (cells of the same EAN are never merged). Totals are
 * always plain sums of the rows (margin, flow and €/s).
 *
 * Returns `null` when the selection is empty or the planogram has no furniture.
 */
export function computeSelectedProductMetrics(
  scene: Scene,
  planogram: Planogram,
  cellIds: string[],
  catalogProducts: CADProduct[],
  visits: SimulationHeatmap | null | undefined,
  timeSeconds: number,
): SelectedProductsMetrics | null {
  const selectedIds = new Set(cellIds);
  const selectedCells = planogram.cells.filter((cell) => selectedIds.has(cell.id));
  if (selectedCells.length === 0) return null;

  const furnitureById = new Map(scene.furniture.map((furniture) => [furniture.id, furniture]));
  const furniture = furnitureById.get(planogram.furnitureId);
  if (!furniture) return null;

  const productsByEan = new Map(catalogProducts.map((product) => [product.ean, product]));
  const allSources = marginColumnSources([planogram], catalogProducts, furnitureById, true);

  // One line per selected facing: never merge cells of the same product (EAN).
  const products: SelectedProductMetric[] = [];
  for (const cell of selectedCells) {
    const product = productsByEan.get(cell.ean);
    const marginEur = product ? productMarginEur(product) : 0;
    const sources = allSources.filter((source) => source.col === cell.col);
    const passagesPerSecond = passagesPerSecondOver(sources, furniture, visits, timeSeconds);
    products.push({
      key: `${planogram.id}:${cell.id}`,
      ean: cell.ean,
      name: product?.name ?? cell.ean,
      marginEur,
      passagesPerSecond,
      eurPerSecond: passagesPerSecond * marginEur,
    });
  }
  products.sort((a, b) => b.eurPerSecond - a.eurPerSecond || b.marginEur - a.marginEur);

  // Totals are always plain sums of the rows.
  return {
    products,
    count: selectedCells.length,
    marginEur: products.reduce((total, product) => total + product.marginEur, 0),
    passagesPerSecond: products.reduce((total, product) => total + product.passagesPerSecond, 0),
    eurPerSecond: products.reduce((total, product) => total + product.eurPerSecond, 0),
  };
}

/**
 * Metrics of a Shift+click selection spanning several planograms: per-planogram
 * metrics are computed independently then concatenated (one line per selected
 * facing, never merged per EAN); totals are plain sums of the rows.
 *
 * Returns `null` when no planogram yields metrics.
 */
export function computeMultiSelectedProductMetrics(
  scene: Scene,
  selections: Array<{ planogram: Planogram; cellIds: string[] }>,
  catalogProducts: CADProduct[],
  visits: SimulationHeatmap | null | undefined,
  timeSeconds: number,
): SelectedProductsMetrics | null {
  const partials = selections
    .map(({ planogram, cellIds }) =>
      computeSelectedProductMetrics(scene, planogram, cellIds, catalogProducts, visits, timeSeconds))
    .filter((metrics): metrics is SelectedProductsMetrics => metrics !== null);
  if (partials.length === 0) return null;
  if (partials.length === 1) return partials[0];

  const products: SelectedProductMetric[] = [];
  let count = 0;
  let marginEur = 0;
  let passagesPerSecond = 0;
  let eurPerSecond = 0;
  for (const partial of partials) {
    count += partial.count;
    marginEur += partial.marginEur;
    passagesPerSecond += partial.passagesPerSecond;
    eurPerSecond += partial.eurPerSecond;
    products.push(...partial.products);
  }
  products.sort((a, b) => b.eurPerSecond - a.eurPerSecond || b.marginEur - a.marginEur);

  return {
    products,
    count,
    marginEur,
    passagesPerSecond,
    eurPerSecond,
  };
}

import type { CADProduct, Planogram, Scene, SimulationHeatmap } from '../types/cad';
import { isPointInMarginSource, marginColumnSources, productMarginEur } from './marginHeatmap';
import type { MarginColumnSource } from './marginHeatmap';

/** Metrics of one product (EAN) among the Shift+click selected cells. */
export interface SelectedProductMetric {
  ean: string;
  name: string;
  /** Number of selected facings of this product. */
  facings: number;
  /** Exposed margin (€) summed over the selected facings. */
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
  /** Total exposed margin (€) of the selection. */
  marginEur: number;
  /** Client flow (pers/s) measured on the union of the selected columns. */
  passagesPerSecond: number;
  /** Total passages/s × total exposed margin (€), in €/s. */
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
 * Metrics of the products selected with Shift+click in one planogram: per
 * product (EAN) and in total, the exposed margin (€), the client flow measured
 * in front of the selected columns (pers/s) and their product (€/s).
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

  // Group the selected facings per product (EAN).
  const byEan = new Map<string, { facings: number; marginEur: number; columns: Set<number> }>();
  for (const cell of selectedCells) {
    const product = productsByEan.get(cell.ean);
    const marginEur = product ? productMarginEur(product) : 0;
    const entry = byEan.get(cell.ean);
    if (entry) {
      entry.facings += 1;
      entry.marginEur += marginEur;
      entry.columns.add(cell.col);
    } else {
      byEan.set(cell.ean, { facings: 1, marginEur, columns: new Set([cell.col]) });
    }
  }

  const products: SelectedProductMetric[] = [];
  for (const [ean, entry] of byEan) {
    const sources = allSources.filter((source) => entry.columns.has(source.col));
    const passagesPerSecond = passagesPerSecondOver(sources, furniture, visits, timeSeconds);
    products.push({
      ean,
      name: productsByEan.get(ean)?.name ?? ean,
      facings: entry.facings,
      marginEur: entry.marginEur,
      passagesPerSecond,
      eurPerSecond: passagesPerSecond * entry.marginEur,
    });
  }
  products.sort((a, b) => b.eurPerSecond - a.eurPerSecond || b.marginEur - a.marginEur);

  const selectedColumns = new Set(selectedCells.map((cell) => cell.col));
  const totalSources = allSources.filter((source) => selectedColumns.has(source.col));
  const totalPassagesPerSecond = passagesPerSecondOver(totalSources, furniture, visits, timeSeconds);
  const totalMarginEur = products.reduce((total, product) => total + product.marginEur, 0);

  return {
    products,
    count: selectedCells.length,
    marginEur: totalMarginEur,
    passagesPerSecond: totalPassagesPerSecond,
    eurPerSecond: totalPassagesPerSecond * totalMarginEur,
  };
}

/**
 * Metrics of a Shift+click selection spanning several planograms: per-planogram
 * metrics are computed independently then merged (facings, margins and flows
 * are summed per product; €/s totals use the summed flow × summed margin).
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

  const byEan = new Map<string, SelectedProductMetric>();
  let count = 0;
  let marginEur = 0;
  let passagesPerSecond = 0;
  for (const partial of partials) {
    count += partial.count;
    marginEur += partial.marginEur;
    passagesPerSecond += partial.passagesPerSecond;
    for (const product of partial.products) {
      const entry = byEan.get(product.ean);
      if (entry) {
        entry.facings += product.facings;
        entry.marginEur += product.marginEur;
        entry.passagesPerSecond += product.passagesPerSecond;
        entry.eurPerSecond = entry.passagesPerSecond * entry.marginEur;
      } else {
        byEan.set(product.ean, { ...product });
      }
    }
  }
  const products = [...byEan.values()]
    .sort((a, b) => b.eurPerSecond - a.eurPerSecond || b.marginEur - a.marginEur);

  return {
    products,
    count,
    marginEur,
    passagesPerSecond,
    eurPerSecond: passagesPerSecond * marginEur,
  };
}

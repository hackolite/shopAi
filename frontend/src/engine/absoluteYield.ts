import type { SimulationHeatmap } from '../types/cad';
import { sampleHeatmapAt } from './yieldHeatmap';

/**
 * Absolute exposed-margin yield: for every floor cell crossed by shoppers, the
 * margin (€) exposed there multiplied by the client flow measured there
 * (persons per second), **without any normalisation**.
 *
 * Unlike the `yield` heatmap — which divides both factors by their own maximum
 * and therefore only ranks cells *relative to each other inside the store* —
 * this metric keeps physical units (€ × persons/s = € of exposed margin per
 * second) so two layouts, or the same layout before and after a change, can be
 * compared in absolute terms.
 */
export interface AbsoluteYieldStats {
  /** Elapsed simulated time (s) the flow is averaged over. */
  elapsedSeconds: number;
  /** Σ over cells of margin(€) × flow(pers/s), in € of exposed margin per second. */
  totalEurPerSecond: number;
  /** Highest single-cell contribution (€/s). */
  maxCellEurPerSecond: number;
  /** Number of cells that carry margin and were visited at least once. */
  productiveCells: number;
  /** Total client flow (pers/s) measured on cells exposed to margin. */
  exposedFlowPerSecond: number;
  /** Total margin (€) exposed on those productive cells. */
  exposedMarginEur: number;
}

/**
 * Combine the (non-normalised) margin grid in € with the visit grid returned by
 * the backend analytics.
 *
 * The sum is computed on the *visit* grid so every recorded agent entry is
 * counted exactly once, whatever the resolution of the margin grid; the margin
 * is sampled by world position, as both grids cover the same store footprint.
 *
 * Returns `null` when the metric cannot be computed (missing grid, no elapsed
 * time yet), so callers can skip the chart instead of plotting zeros.
 */
export function computeAbsoluteYield(
  marginHeatmap: SimulationHeatmap | null,
  visitHeatmap: SimulationHeatmap | null | undefined,
  elapsedSeconds: number,
): AbsoluteYieldStats | null {
  if (!marginHeatmap || !visitHeatmap) return null;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return null;

  const { cols, rows, cellSizeCm, originXCm, originZCm } = visitHeatmap;
  let totalEurPerSecond = 0;
  let maxCellEurPerSecond = 0;
  let productiveCells = 0;
  let exposedFlowPerSecond = 0;
  let exposedMarginEur = 0;

  for (let row = 0; row < rows; row++) {
    const zCm = originZCm + (row + 0.5) * cellSizeCm;
    for (let col = 0; col < cols; col++) {
      const visits = visitHeatmap.counts[row * cols + col] ?? 0;
      if (visits <= 0) continue;
      const xCm = originXCm + (col + 0.5) * cellSizeCm;
      const marginEur = sampleHeatmapAt(marginHeatmap, xCm, zCm);
      if (marginEur <= 0) continue;
      const flowPerSecond = visits / elapsedSeconds;
      const value = marginEur * flowPerSecond;
      totalEurPerSecond += value;
      exposedFlowPerSecond += flowPerSecond;
      exposedMarginEur += marginEur;
      productiveCells += 1;
      if (value > maxCellEurPerSecond) maxCellEurPerSecond = value;
    }
  }

  return {
    elapsedSeconds,
    totalEurPerSecond,
    maxCellEurPerSecond,
    productiveCells,
    exposedFlowPerSecond,
    exposedMarginEur,
  };
}

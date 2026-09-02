import type { SimulationHeatmap } from '../types/cad';

/**
 * Sample a heatmap at a world position (cm), returning the raw cell value.
 * Positions outside the grid return 0.
 */
function sampleAt(heatmap: SimulationHeatmap, xCm: number, zCm: number): number {
  const col = Math.floor((xCm - heatmap.originXCm) / heatmap.cellSizeCm);
  const row = Math.floor((zCm - heatmap.originZCm) / heatmap.cellSizeCm);
  if (col < 0 || row < 0 || col >= heatmap.cols || row >= heatmap.rows) return 0;
  return heatmap.counts[row * heatmap.cols + col] ?? 0;
}

/**
 * Combine the margin grid with the traffic grid into a "yield per m²" grid:
 * each cell holds the product of the normalised margin exposed there and the
 * normalised client density measured there.
 *
 * The result is expressed on the margin grid (both grids are derived from the
 * same store footprint, but the traffic grid is sampled by world position so
 * differing cell sizes still line up).  Returns `null` when the product is zero
 * everywhere — nothing worth drawing.
 */
export function buildYieldHeatmap(
  marginHeatmap: SimulationHeatmap | null,
  trafficHeatmap: SimulationHeatmap | null,
): SimulationHeatmap | null {
  if (!marginHeatmap || !trafficHeatmap) return null;
  const marginMax = marginHeatmap.maxCount;
  const trafficMax = trafficHeatmap.maxCount;
  if (marginMax <= 0 || trafficMax <= 0) return null;

  const { cols, rows, cellSizeCm, originXCm, originZCm } = marginHeatmap;
  const counts = new Array<number>(cols * rows).fill(0);
  let maxCount = 0;
  for (let row = 0; row < rows; row++) {
    const zCm = originZCm + (row + 0.5) * cellSizeCm;
    for (let col = 0; col < cols; col++) {
      const margin = marginHeatmap.counts[row * cols + col] ?? 0;
      if (margin <= 0) continue;
      const xCm = originXCm + (col + 0.5) * cellSizeCm;
      const traffic = sampleAt(trafficHeatmap, xCm, zCm);
      if (traffic <= 0) continue;
      const value = (margin / marginMax) * (traffic / trafficMax);
      counts[row * cols + col] = value;
      if (value > maxCount) maxCount = value;
    }
  }
  if (maxCount <= 0) return null;
  return { cellSizeCm, originXCm, originZCm, cols, rows, maxCount, counts };
}

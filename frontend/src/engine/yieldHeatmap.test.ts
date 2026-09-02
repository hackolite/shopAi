import { describe, expect, it } from 'vitest';
import { buildYieldHeatmap } from './yieldHeatmap';
import type { SimulationHeatmap } from '../types/cad';

function grid(counts: number[], patch: Partial<SimulationHeatmap> = {}): SimulationHeatmap {
  return {
    cellSizeCm: 50,
    originXCm: 0,
    originZCm: 0,
    cols: 2,
    rows: 2,
    maxCount: Math.max(...counts),
    counts,
    ...patch,
  };
}

describe('buildYieldHeatmap', () => {
  it('multiplies the normalised margin by the normalised traffic', () => {
    const margin = grid([10, 5, 0, 0]);
    const traffic = grid([2, 8, 4, 0]);
    const result = buildYieldHeatmap(margin, traffic);
    expect(result).not.toBeNull();
    expect(result!.counts[0]).toBeCloseTo(1 * 0.25);
    expect(result!.counts[1]).toBeCloseTo(0.5 * 1);
    expect(result!.counts[2]).toBe(0);
    expect(result!.maxCount).toBeCloseTo(0.5);
  });

  it('keeps the margin grid geometry and samples traffic by world position', () => {
    const margin = grid([1, 1, 1, 1], { cellSizeCm: 50, cols: 2, rows: 2 });
    const traffic = grid([4], { cellSizeCm: 100, cols: 1, rows: 1, maxCount: 4 });
    const result = buildYieldHeatmap(margin, traffic);
    expect(result).not.toBeNull();
    expect(result!.cols).toBe(2);
    expect(result!.rows).toBe(2);
    expect(result!.cellSizeCm).toBe(50);
    expect(result!.counts).toEqual([1, 1, 1, 1]);
  });

  it('returns null when a grid is missing or empty', () => {
    expect(buildYieldHeatmap(null, grid([1, 0, 0, 0]))).toBeNull();
    expect(buildYieldHeatmap(grid([1, 0, 0, 0]), null)).toBeNull();
    expect(buildYieldHeatmap(grid([0, 0, 0, 0], { maxCount: 0 }), grid([1, 0, 0, 0]))).toBeNull();
  });

  it('returns null when margin and traffic never overlap', () => {
    const margin = grid([1, 0, 0, 0]);
    const traffic = grid([0, 0, 0, 3], { maxCount: 3 });
    expect(buildYieldHeatmap(margin, traffic)).toBeNull();
  });
});

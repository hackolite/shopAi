import { describe, expect, it } from 'vitest';
import { computeAbsoluteYield } from './absoluteYield';
import type { SimulationHeatmap } from '../types/cad';

function grid(counts: number[], patch: Partial<SimulationHeatmap> = {}): SimulationHeatmap {
  return {
    cellSizeCm: 50,
    originXCm: 0,
    originZCm: 0,
    cols: 2,
    rows: 2,
    maxCount: Math.max(...counts, 0),
    counts,
    ...patch,
  };
}

describe('computeAbsoluteYield', () => {
  it('multiplies the raw margin (€) by the raw flow (pers/s) without normalising', () => {
    const margin = grid([10, 4, 0, 0]);
    const visits = grid([20, 5, 7, 0]);
    const stats = computeAbsoluteYield(margin, visits, 10);
    expect(stats).not.toBeNull();
    // 10 € × 2 pers/s + 4 € × 0.5 pers/s ; the visited cell without margin is ignored.
    expect(stats!.totalEurPerSecond).toBeCloseTo(22);
    expect(stats!.maxCellEurPerSecond).toBeCloseTo(20);
    expect(stats!.productiveCells).toBe(2);
    expect(stats!.exposedFlowPerSecond).toBeCloseTo(2.5);
    expect(stats!.exposedMarginEur).toBeCloseTo(14);
  });

  it('scales with the margin only, so a richer assortment raises the absolute value', () => {
    const visits = grid([20, 0, 0, 0]);
    const poor = computeAbsoluteYield(grid([10, 0, 0, 0]), visits, 10)!;
    const rich = computeAbsoluteYield(grid([30, 0, 0, 0]), visits, 10)!;
    expect(rich.totalEurPerSecond).toBeCloseTo(3 * poor.totalEurPerSecond);
  });

  it('samples the margin by world position when grids have different cell sizes', () => {
    const margin = grid([2, 2, 2, 2], { cellSizeCm: 50, cols: 2, rows: 2 });
    const visits = grid([8], { cellSizeCm: 100, cols: 1, rows: 1, maxCount: 8 });
    const stats = computeAbsoluteYield(margin, visits, 4);
    // A single visit cell: counted once (8/4 = 2 pers/s) against a 2 € margin.
    expect(stats!.totalEurPerSecond).toBeCloseTo(4);
    expect(stats!.productiveCells).toBe(1);
  });

  it('returns null without a grid or before any elapsed time', () => {
    const margin = grid([1, 0, 0, 0]);
    const visits = grid([1, 0, 0, 0]);
    expect(computeAbsoluteYield(null, visits, 10)).toBeNull();
    expect(computeAbsoluteYield(margin, null, 10)).toBeNull();
    expect(computeAbsoluteYield(margin, undefined, 10)).toBeNull();
    expect(computeAbsoluteYield(margin, visits, 0)).toBeNull();
  });

  it('reports zero when no visited cell carries margin', () => {
    const stats = computeAbsoluteYield(grid([0, 0, 0, 0]), grid([5, 5, 5, 5]), 5);
    expect(stats!.totalEurPerSecond).toBe(0);
    expect(stats!.productiveCells).toBe(0);
  });
});

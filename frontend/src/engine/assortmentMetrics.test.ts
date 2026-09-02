import { describe, expect, it } from 'vitest';
import {
  catalogCoveragePct,
  computeFurnitureMetrics,
  computeImplantationMetrics,
} from './assortmentMetrics';
import type { Planogram } from '../types/cad';

function planogram(id: string, furnitureId: string, eans: string[]): Planogram {
  return {
    id,
    name: id,
    furnitureId,
    face: 'front',
    rows: 1,
    cols: eans.length,
    widthCm: 120,
    heightCm: 200,
    cells: eans.map((ean, index) => ({
      id: `${id}-${index}`,
      ean,
      row: 0,
      col: index,
      rotation: 0 as const,
    })),
  };
}

describe('computeImplantationMetrics', () => {
  it('counts distinct products and facings separately', () => {
    const metrics = computeImplantationMetrics([
      planogram('p1', 'f1', ['A', 'A', 'B']),
      planogram('p2', 'f2', ['B', 'C']),
    ]);
    expect(metrics.distinctProducts).toBe(3);
    expect(metrics.facings).toBe(5);
    expect(metrics.filledPlanograms).toBe(2);
    expect(metrics.planograms).toBe(2);
    expect(metrics.averageFacingsPerProduct).toBeCloseTo(5 / 3);
  });

  it('reports zeros for an empty implantation', () => {
    const metrics = computeImplantationMetrics([planogram('p1', 'f1', [])]);
    expect(metrics).toEqual({
      distinctProducts: 0,
      facings: 0,
      filledPlanograms: 0,
      planograms: 1,
      averageFacingsPerProduct: 0,
    });
  });
});

describe('computeFurnitureMetrics', () => {
  it('only keeps the planograms of the requested furniture', () => {
    const metrics = computeFurnitureMetrics(
      [planogram('p1', 'f1', ['A', 'B']), planogram('p2', 'f2', ['C'])],
      'f1',
    );
    expect(metrics.distinctProducts).toBe(2);
    expect(metrics.planograms).toBe(1);
  });
});

describe('catalogCoveragePct', () => {
  it('returns the implanted share of the catalog', () => {
    expect(catalogCoveragePct(250, 1000)).toBe(25);
  });

  it('never divides by an empty catalog', () => {
    expect(catalogCoveragePct(10, 0)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { fitPlanogramToFace, isPlanogramOversized } from './planogramFit';
import type { Planogram } from '../types/cad';

function makePlanogram(overrides: Partial<Planogram> = {}): Planogram {
  const rows = overrides.rows ?? 2;
  const cols = overrides.cols ?? 6;
  const cells = Array.from({ length: rows * cols }, (_, index) => ({
    id: `c${index}`,
    ean: `ean-${index}`,
    row: Math.floor(index / cols),
    col: index % cols,
    rotation: 0 as const,
  }));
  return {
    id: 'p1',
    name: 'Palette – gauche',
    furnitureId: 'f1',
    face: 'left',
    rows,
    cols,
    widthCm: 120,
    heightCm: 200,
    cells,
    ...overrides,
  };
}

describe('isPlanogramOversized', () => {
  it('detects a planogram larger than its face', () => {
    expect(isPlanogramOversized(makePlanogram(), 80, 200)).toBe(true);
    expect(isPlanogramOversized(makePlanogram(), 120, 200)).toBe(false);
  });
});

describe('fitPlanogramToFace', () => {
  it('leaves a fitting planogram untouched', () => {
    const planogram = makePlanogram();
    expect(fitPlanogramToFace(planogram, 120, 200)).toBe(planogram);
  });

  it('drops the facings that no longer fit instead of squashing them', () => {
    // 6 columns of 20 cm on a 120 cm face, narrowed to an 80 cm face → 4 columns.
    const fitted = fitPlanogramToFace(makePlanogram(), 80, 200);
    expect(fitted.widthCm).toBe(80);
    expect(fitted.cols).toBe(4);
    expect(fitted.colWidthsCm).toEqual([20, 20, 20, 20]);
    expect(fitted.cells).toHaveLength(8);
    expect(fitted.cells.every((cell) => cell.col < 4)).toBe(true);
  });

  it('honours per-row column counts and per-cell widths', () => {
    const planogram = makePlanogram({
      rows: 1,
      cols: 3,
      rowColCounts: [3],
      cellWidthOverrides: { '0-0': 50, '0-1': 50, '0-2': 20 },
      cells: [
        { id: 'a', ean: 'A', row: 0, col: 0, rotation: 0 },
        { id: 'b', ean: 'B', row: 0, col: 1, rotation: 0 },
        { id: 'c', ean: 'C', row: 0, col: 2, rotation: 0 },
      ],
    });
    const fitted = fitPlanogramToFace(planogram, 80, 200);
    expect(fitted.cols).toBe(1);
    expect(fitted.cells.map((cell) => cell.ean)).toEqual(['A']);
    expect(fitted.cellWidthOverrides).toEqual({ '0-0': 50 });
  });

  it('scales down a lone facing wider than the whole face', () => {
    const planogram = makePlanogram({
      rows: 1,
      cols: 1,
      cells: [{ id: 'a', ean: 'A', row: 0, col: 0, rotation: 0 }],
    });
    const fitted = fitPlanogramToFace(planogram, 60, 200);
    expect(fitted.cols).toBe(1);
    expect(fitted.cellWidthOverrides).toEqual({ '0-0': 60 });
    expect(fitted.cells).toHaveLength(1);
  });

  it('drops the bottom shelves when the face gets shorter', () => {
    const planogram = makePlanogram({ rows: 4, cols: 2, heightCm: 200 });
    const fitted = fitPlanogramToFace(planogram, 120, 100);
    expect(fitted.rows).toBe(2);
    expect(fitted.heightCm).toBe(100);
    expect(fitted.rowHeightsCm).toEqual([50, 50]);
    expect(fitted.cells.every((cell) => cell.row < 2)).toBe(true);
  });

  it('always keeps at least one row and one column', () => {
    const planogram = makePlanogram({ rows: 3, cols: 3 });
    const fitted = fitPlanogramToFace(planogram, 5, 5);
    expect(fitted.rows).toBe(1);
    expect(fitted.cols).toBe(1);
    expect(fitted.cells).toHaveLength(1);
  });
});

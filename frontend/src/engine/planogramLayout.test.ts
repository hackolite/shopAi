import { describe, expect, it } from 'vitest';
import { cellRectCm, columnAtRatio, rowCellWidthsCm } from './planogramLayout';
import type { Planogram } from '../types/cad';

function makePlanogram(overrides: Partial<Planogram> = {}): Planogram {
  return {
    id: 'p1',
    name: 'P1',
    furnitureId: 'f1',
    face: 'front',
    rows: 1,
    cols: 4,
    widthCm: 120,
    heightCm: 180,
    cells: [],
    ...overrides,
  } as Planogram;
}

describe('planogramLayout', () => {
  it('splits the width evenly when no override is recorded', () => {
    expect(rowCellWidthsCm(makePlanogram(), 0)).toEqual([30, 30, 30, 30]);
  });

  it('stretches the last cell so a fused row still covers the whole face', () => {
    // Cells 0..2 were fused into narrower boxes: their widths only add up to
    // 90 cm out of 120 cm, which used to leave an empty band on the right.
    const planogram = makePlanogram({
      cellWidthOverrides: { '0-0': 30, '0-1': 30, '0-2': 15, '0-3': 15 },
    });
    const widths = rowCellWidthsCm(planogram, 0);
    expect(widths).toEqual([30, 30, 15, 45]);
    expect(widths.reduce((sum, w) => sum + w, 0)).toBe(planogram.widthCm);
    expect(cellRectCm(planogram, 0, 3)).toEqual({ xCm: 75, widthCm: 45 });
  });

  it('clamps rows whose recorded widths overflow the face', () => {
    const planogram = makePlanogram({
      cols: 3,
      cellWidthOverrides: { '0-0': 100, '0-1': 100, '0-2': 100 },
    });
    expect(rowCellWidthsCm(planogram, 0)).toEqual([100, 20, 0]);
  });

  it('honours per-row column counts', () => {
    const planogram = makePlanogram({
      rows: 2,
      rowColCounts: [2, 4],
      cellWidthOverrides: { '0-0': 40, '0-1': 40 },
    });
    expect(rowCellWidthsCm(planogram, 0)).toEqual([40, 80]);
    expect(rowCellWidthsCm(planogram, 1)).toEqual([30, 30, 30, 30]);
  });

  it('maps a horizontal ratio onto the stretched columns', () => {
    const planogram = makePlanogram({
      cellWidthOverrides: { '0-0': 30, '0-1': 30, '0-2': 15, '0-3': 15 },
    });
    expect(columnAtRatio(planogram, 0, 0)).toBe(0);
    expect(columnAtRatio(planogram, 0, 0.5)).toBe(1);
    expect(columnAtRatio(planogram, 0, 0.6)).toBe(2);
    // Beyond the recorded widths: the stretched last cell now catches the click.
    expect(columnAtRatio(planogram, 0, 0.9)).toBe(3);
    expect(columnAtRatio(planogram, 0, 1)).toBe(3);
  });
});

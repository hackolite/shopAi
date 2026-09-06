import { describe, expect, it } from 'vitest';
import type { Planogram, PlanogramCell } from '../types/cad';
import { directionFromKey, navigatePlanogramCell } from './planogramCellNavigation';

function cell(row: number, col: number): PlanogramCell {
  return { id: `c-${row}-${col}`, ean: `ean-${row}-${col}`, row, col, rotation: 0 };
}

function makePlanogram(overrides: Partial<Planogram> = {}): Planogram {
  return {
    id: 'plano-1',
    name: 'Test',
    furnitureId: 'furn-1',
    face: 'front',
    rows: 3,
    cols: 3,
    widthCm: 120,
    heightCm: 180,
    cells: [
      cell(0, 0), cell(0, 1), cell(0, 2),
      cell(1, 0), cell(1, 1), cell(1, 2),
      cell(2, 0), cell(2, 1), cell(2, 2),
    ],
    ...overrides,
  };
}

describe('directionFromKey', () => {
  it('maps arrow keys and rejects other keys', () => {
    expect(directionFromKey('ArrowUp')).toBe('up');
    expect(directionFromKey('ArrowDown')).toBe('down');
    expect(directionFromKey('ArrowLeft')).toBe('left');
    expect(directionFromKey('ArrowRight')).toBe('right');
    expect(directionFromKey('Enter')).toBeNull();
    expect(directionFromKey('a')).toBeNull();
  });
});

describe('navigatePlanogramCell', () => {
  it('moves horizontally within the same row', () => {
    const plano = makePlanogram();
    expect(navigatePlanogramCell(plano, 'c-1-1', 'left')?.id).toBe('c-1-0');
    expect(navigatePlanogramCell(plano, 'c-1-1', 'right')?.id).toBe('c-1-2');
  });

  it('moves vertically to the adjacent row (row 0 = top)', () => {
    const plano = makePlanogram();
    expect(navigatePlanogramCell(plano, 'c-1-1', 'up')?.id).toBe('c-0-1');
    expect(navigatePlanogramCell(plano, 'c-1-1', 'down')?.id).toBe('c-2-1');
  });

  it('returns null at the planogram edges', () => {
    const plano = makePlanogram();
    expect(navigatePlanogramCell(plano, 'c-0-0', 'up')).toBeNull();
    expect(navigatePlanogramCell(plano, 'c-0-0', 'left')).toBeNull();
    expect(navigatePlanogramCell(plano, 'c-2-2', 'down')).toBeNull();
    expect(navigatePlanogramCell(plano, 'c-2-2', 'right')).toBeNull();
  });

  it('skips empty slots when moving horizontally', () => {
    const plano = makePlanogram({
      cells: [cell(0, 0), cell(0, 2), cell(1, 0)],
    });
    expect(navigatePlanogramCell(plano, 'c-0-0', 'right')?.id).toBe('c-0-2');
    expect(navigatePlanogramCell(plano, 'c-0-2', 'left')?.id).toBe('c-0-0');
  });

  it('skips empty rows when moving vertically', () => {
    const plano = makePlanogram({
      cells: [cell(0, 1), cell(2, 1)],
    });
    expect(navigatePlanogramCell(plano, 'c-0-1', 'down')?.id).toBe('c-2-1');
    expect(navigatePlanogramCell(plano, 'c-2-1', 'up')?.id).toBe('c-0-1');
  });

  it('uses physical widths to pick the column on rows with different layouts', () => {
    // Row 0 has 2 wide columns (60 cm each), row 1 has 4 narrow ones (30 cm each).
    const plano = makePlanogram({
      rows: 2,
      cols: 4,
      rowColCounts: [2, 4],
      cellWidthOverrides: { '0-0': 60, '0-1': 60 },
      cells: [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1), cell(1, 2), cell(1, 3)],
    });
    // Centre of row-0 col 1 is at 90 cm → row-1 col 3 (75–105 cm... actually 90 cm ∈ [60,90] boundary → col 2).
    expect(navigatePlanogramCell(plano, 'c-0-1', 'down')?.id).toBe('c-1-2');
    // Centre of row-1 col 0 is at 15 cm → row-0 col 0.
    expect(navigatePlanogramCell(plano, 'c-1-0', 'up')?.id).toBe('c-0-0');
    // Centre of row-1 col 3 is at 105 cm → row-0 col 1.
    expect(navigatePlanogramCell(plano, 'c-1-3', 'up')?.id).toBe('c-0-1');
  });

  it('falls back to the nearest occupied cell of the target row', () => {
    const plano = makePlanogram({
      cells: [cell(0, 0), cell(1, 2)],
    });
    expect(navigatePlanogramCell(plano, 'c-0-0', 'down')?.id).toBe('c-1-2');
    expect(navigatePlanogramCell(plano, 'c-1-2', 'up')?.id).toBe('c-0-0');
  });

  it('returns null for an unknown cell id', () => {
    expect(navigatePlanogramCell(makePlanogram(), 'missing', 'up')).toBeNull();
  });
});

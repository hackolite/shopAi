import { describe, expect, it } from 'vitest';
import { buildMarginHeatmap, marginColumnSources, productMarginEur } from './marginHeatmap';
import type { CADProduct, FaceId, FurnitureInstance, Planogram, Scene } from '../types/cad';

function product(ean: string, patch: Partial<CADProduct> = {}): CADProduct {
  return {
    ean,
    name: `Produit ${ean}`,
    brand: 'Marque',
    category: 'Épicerie',
    widthCm: 10,
    depthCm: 10,
    heightCm: 20,
    weightG: 100,
    imageUrl: null,
    ...patch,
  };
}

function furniture(id: string, patch: Partial<FurnitureInstance> = {}): FurnitureInstance {
  return {
    id,
    name: id,
    type: 'gondola',
    libraryId: 'gondola',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    dimensions: { width: 200, depth: 50, height: 180 },
    materialId: 'm',
    visible: true,
    locked: false,
    mounted: true,
    parentId: null,
    childIds: [],
    faces: {},
    ...patch,
  };
}

/** Single-row planogram whose columns hold the given EANs. */
function planogram(id: string, furnitureId: string, eans: string[], face: FaceId = 'front'): Planogram {
  return {
    id,
    name: id,
    furnitureId,
    face,
    rows: 1,
    cols: eans.length,
    widthCm: 200,
    heightCm: 180,
    cells: eans.map((ean, col) => ({ id: `${id}-${col}`, ean, row: 0, col, rotation: 0 })),
  };
}

function scene(furnitureList: FurnitureInstance[]): Scene {
  return {
    store: {
      id: 'store',
      name: 'Store',
      position: [0, 0, 0],
      dimensions: { width: 400, depth: 400, height: 300 },
      floorColor: '#fff',
      wallColor: '#fff',
    },
    furniture: furnitureList,
  };
}

const products = [
  product('rich', { priceBuyEur: 1, priceSellEur: 5 }),
  product('poor', { priceBuyEur: 1, priceSellEur: 1.2 }),
];

describe('productMarginEur', () => {
  it('uses the price difference when both prices are known', () => {
    expect(productMarginEur(product('1', { priceBuyEur: 1, priceSellEur: 1.6 }))).toBeCloseTo(0.6);
  });

  it('falls back on the margin rate when the buy price is missing', () => {
    expect(productMarginEur(product('1', { priceSellEur: 2, marginPct: 25 }))).toBeCloseTo(0.5);
  });

  it('returns zero when no price is known and never goes negative', () => {
    expect(productMarginEur(product('1'))).toBe(0);
    expect(productMarginEur(product('1', { priceBuyEur: 3, priceSellEur: 2 }))).toBe(0);
  });
});

describe('marginColumnSources', () => {
  const furnitureById = new Map([['f1', furniture('f1')]]);

  it('emits one source per column, each on its own slice of the footprint', () => {
    const sources = marginColumnSources([planogram('p1', 'f1', ['rich', 'poor'])], products, furnitureById)
      .sort((a, b) => a.col - b.col);
    expect(sources).toHaveLength(2);
    expect(sources[0].marginEur).toBeCloseTo(4);
    expect(sources[1].marginEur).toBeCloseTo(0.2);
    // 200 cm wide furniture, 2 columns: local X spans [-100, 0] then [0, 100].
    expect([sources[0].x0, sources[0].x1]).toEqual([-100, 0]);
    expect([sources[1].x0, sources[1].x1]).toEqual([0, 100]);
    // A front planogram radiates on the +Z half of the footprint.
    expect([sources[0].z0, sources[0].z1]).toEqual([0, 25]);
  });

  it('sums the facings of every row of a column', () => {
    const stacked = planogram('p1', 'f1', ['rich', 'poor']);
    stacked.rows = 2;
    stacked.cells.push({ id: 'p1-extra', ean: 'rich', row: 1, col: 0, rotation: 0 });
    const sources = marginColumnSources([stacked], products, furnitureById);
    expect(sources.find((source) => source.col === 0)?.marginEur).toBeCloseTo(8);
  });

  it('honours per-column widths', () => {
    const uneven = planogram('p1', 'f1', ['rich', 'rich']);
    uneven.colWidthsCm = [150, 50];
    const sources = marginColumnSources([uneven], products, furnitureById).sort((a, b) => a.col - b.col);
    expect([sources[0].x0, sources[0].x1]).toEqual([-100, 50]);
    expect([sources[1].x0, sources[1].x1]).toEqual([50, 100]);
  });

  it('mirrors columns on the back face and radiates on the other aisle', () => {
    const sources = marginColumnSources(
      [planogram('p1', 'f1', ['rich', 'poor'], 'back')],
      products,
      furnitureById,
    );
    const first = sources.find((source) => source.col === 0)!;
    expect([first.x0, first.x1]).toEqual([0, 100]);
    expect([first.z0, first.z1]).toEqual([-25, 0]);
  });

  it('ignores unknown EANs, margin-free columns and unplaced planograms', () => {
    expect(marginColumnSources([planogram('p1', 'f1', ['ghost'])], products, furnitureById)).toHaveLength(0);
    expect(marginColumnSources([planogram('p1', 'nope', ['rich'])], products, furnitureById)).toHaveLength(0);
  });
});

describe('buildMarginHeatmap', () => {
  const cellAt = (grid: NonNullable<ReturnType<typeof buildMarginHeatmap>>, xCm: number, zCm: number) =>
    grid.counts[Math.floor(zCm / grid.cellSizeCm) * grid.cols + Math.floor(xCm / grid.cellSizeCm)];

  it('returns null when no column exposes margin', () => {
    expect(buildMarginHeatmap(scene([furniture('f1')]), [], products)).toBeNull();
  });

  it('is hotter in front of the high-margin column than the low-margin one', () => {
    const grid = buildMarginHeatmap(
      scene([furniture('f1')]),
      [planogram('p1', 'f1', ['rich', 'poor'])],
      products,
    )!;
    // Left half of the shelf holds the rich column, right half the poor one.
    expect(cellAt(grid, 50, 25)).toBeGreaterThan(cellAt(grid, 150, 25));
  });

  it('fades in front of the column and stays inside the influence band', () => {
    const grid = buildMarginHeatmap(
      scene([furniture('f1')]),
      [planogram('p1', 'f1', ['rich', 'rich'])],
      products,
    )!;
    expect(cellAt(grid, 50, 25)).toBeCloseTo(grid.maxCount);
    expect(cellAt(grid, 50, 75)).toBeGreaterThan(0);
    expect(cellAt(grid, 50, 75)).toBeLessThan(cellAt(grid, 50, 25));
    expect(cellAt(grid, 50, 375)).toBe(0);
  });

  it('radiates on the front aisle only for a front planogram', () => {
    const grid = buildMarginHeatmap(
      scene([furniture('f1', { position: [0, 0, 150] })]),
      [planogram('p1', 'f1', ['rich', 'rich'])],
      products,
    )!;
    // The furniture spans Z 150..200 and its front face is the +Z side.
    expect(cellAt(grid, 50, 225)).toBeGreaterThan(cellAt(grid, 50, 125));
  });

  it('follows the furniture rotation around its centre', () => {
    const grid = buildMarginHeatmap(
      scene([furniture('f1', { position: [100, 0, 100], rotation: [0, 90, 0] })]),
      [planogram('p1', 'f1', ['rich', 'rich'])],
      products,
    )!;
    // A 200×50 shelf rotated 90° around (200, 125) spans 50 cm in X, 200 cm in Z.
    expect(cellAt(grid, 175, 175)).toBeGreaterThan(0);
    expect(cellAt(grid, 375, 375)).toBe(0);
  });

  it('accumulates the margin of the two faces of a gondola', () => {
    const single = buildMarginHeatmap(
      scene([furniture('f1')]),
      [planogram('p1', 'f1', ['rich', 'rich'])],
      products,
    )!;
    const doubled = buildMarginHeatmap(
      scene([furniture('f1')]),
      [planogram('p1', 'f1', ['rich', 'rich']), planogram('p2', 'f1', ['rich', 'rich'])],
      products,
    )!;
    expect(doubled.maxCount).toBeGreaterThan(single.maxCount);
  });
});

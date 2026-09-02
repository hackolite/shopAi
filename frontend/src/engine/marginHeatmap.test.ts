import { describe, expect, it } from 'vitest';
import { buildMarginHeatmap, marginByFurniture, productMarginEur } from './marginHeatmap';
import type { CADProduct, FurnitureInstance, Planogram, Scene } from '../types/cad';

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
    dimensions: { width: 100, depth: 50, height: 180 },
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

function planogram(id: string, furnitureId: string, eans: string[]): Planogram {
  return {
    id,
    name: id,
    furnitureId,
    face: 'front',
    rows: 1,
    cols: eans.length,
    widthCm: 100,
    heightCm: 180,
    cells: eans.map((ean, index) => ({ id: `${id}-${index}`, ean, row: 0, col: index, rotation: 0 })),
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

describe('marginByFurniture', () => {
  it('sums facings across every planogram of a furniture', () => {
    const products = [
      product('a', { priceBuyEur: 1, priceSellEur: 2 }),
      product('b', { priceBuyEur: 1, priceSellEur: 1.5 }),
    ];
    const totals = marginByFurniture(
      [planogram('p1', 'f1', ['a', 'a']), planogram('p2', 'f1', ['b'])],
      products,
    );
    expect(totals.get('f1')).toBeCloseTo(2.5);
  });

  it('ignores unknown EANs and margin-free furniture', () => {
    const totals = marginByFurniture([planogram('p1', 'f1', ['ghost'])], [product('a')]);
    expect(totals.size).toBe(0);
  });
});

describe('buildMarginHeatmap', () => {
  const products = [product('a', { priceBuyEur: 1, priceSellEur: 3 })];

  it('returns null when no furniture exposes margin', () => {
    expect(buildMarginHeatmap(scene([furniture('f1')]), [], products)).toBeNull();
  });

  it('peaks on the furniture footprint and fades with distance', () => {
    const grid = buildMarginHeatmap(
      scene([furniture('f1', { position: [0, 0, 0] })]),
      [planogram('p1', 'f1', ['a'])],
      products,
    );
    expect(grid).not.toBeNull();
    const cellAt = (xCm: number, zCm: number) => {
      const col = Math.floor(xCm / grid!.cellSizeCm);
      const row = Math.floor(zCm / grid!.cellSizeCm);
      return grid!.counts[row * grid!.cols + col];
    };
    expect(cellAt(50, 25)).toBeCloseTo(grid!.maxCount);
    expect(cellAt(50, 75)).toBeGreaterThan(0);
    expect(cellAt(50, 75)).toBeLessThan(cellAt(50, 25));
    expect(cellAt(50, 375)).toBe(0);
  });

  it('accumulates the margin of neighbouring furniture', () => {
    const single = buildMarginHeatmap(
      scene([furniture('f1')]),
      [planogram('p1', 'f1', ['a'])],
      products,
    );
    const pair = buildMarginHeatmap(
      scene([furniture('f1'), furniture('f2', { position: [0, 0, 100] })]),
      [planogram('p1', 'f1', ['a']), planogram('p2', 'f2', ['a'])],
      products,
    );
    expect(pair!.maxCount).toBeGreaterThan(single!.maxCount);
  });

  it('follows the furniture rotation around its centre', () => {
    const grid = buildMarginHeatmap(
      scene([furniture('f1', { position: [100, 0, 100], rotation: [0, 90, 0] })]),
      [planogram('p1', 'f1', ['a'])],
      products,
    );
    const cellAt = (xCm: number, zCm: number) => {
      const col = Math.floor(xCm / grid!.cellSizeCm);
      const row = Math.floor(zCm / grid!.cellSizeCm);
      return grid!.counts[row * grid!.cols + col];
    };
    // A 100×50 shelf rotated 90° spans 50 cm in X and 100 cm in Z around (150, 125).
    expect(cellAt(150, 175)).toBeCloseTo(grid!.maxCount);
    expect(cellAt(250, 125)).toBeLessThan(cellAt(150, 175));
  });
});

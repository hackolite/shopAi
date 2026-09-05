import { describe, expect, it } from 'vitest';
import { computeMultiSelectedProductMetrics, computeSelectedProductMetrics } from './selectedProductMetrics';
import type { CADProduct, FurnitureInstance, Planogram, Scene, SimulationHeatmap } from '../types/cad';

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

/** Single-row front planogram whose columns hold the given EANs. */
function planogram(id: string, furnitureId: string, eans: string[]): Planogram {
  return {
    id,
    name: id,
    furnitureId,
    face: 'front',
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

/**
 * 4×4 visit grid of 100 cm cells over the 400×400 store: 10 visits recorded in
 * front of the left column (col 0) of the shelf, 2 in front of the right one,
 * over 10 s of simulation.
 */
function visits(): SimulationHeatmap {
  const counts = new Array<number>(16).fill(0);
  counts[0] = 10; // cell centred at (50, 50) — front aisle of the left column
  counts[1] = 2; //  cell centred at (150, 50) — front aisle of the right column
  return { cellSizeCm: 100, originXCm: 0, originZCm: 0, cols: 4, rows: 4, maxCount: 10, counts };
}

describe('computeSelectedProductMetrics', () => {
  const testScene = scene([furniture('f1')]);
  const plano = planogram('p1', 'f1', ['rich', 'poor']);

  it('returns null when nothing is selected or the furniture is missing', () => {
    expect(computeSelectedProductMetrics(testScene, plano, [], products, visits(), 10)).toBeNull();
    expect(
      computeSelectedProductMetrics(scene([]), plano, ['p1-0'], products, visits(), 10),
    ).toBeNull();
  });

  it('reports margin, flow and €/s for a single selected product', () => {
    const metrics = computeSelectedProductMetrics(testScene, plano, ['p1-0'], products, visits(), 10)!;
    expect(metrics.count).toBe(1);
    expect(metrics.products).toHaveLength(1);
    expect(metrics.products[0].name).toBe('Produit rich');
    expect(metrics.marginEur).toBeCloseTo(4);
    // Both visit cells sit within the 100 cm influence band of the left column,
    // but only the (50, 50) and (150, 50) cells carry visits: 12 visits / 10 s.
    expect(metrics.passagesPerSecond).toBeGreaterThan(0);
    expect(metrics.eurPerSecond).toBeCloseTo(metrics.passagesPerSecond * metrics.marginEur);
  });

  it('cumulates products added with Shift+click and totals their metrics', () => {
    const one = computeSelectedProductMetrics(testScene, plano, ['p1-0'], products, visits(), 10)!;
    const both = computeSelectedProductMetrics(
      testScene,
      plano,
      ['p1-0', 'p1-1'],
      products,
      visits(),
      10,
    )!;
    expect(both.count).toBe(2);
    expect(both.products).toHaveLength(2);
    expect(both.marginEur).toBeCloseTo(4.2);
    expect(both.marginEur).toBeGreaterThan(one.marginEur);
    // Total flow never double-counts a visit cell shared by two columns.
    expect(both.passagesPerSecond).toBeCloseTo(12 / 10);
    expect(both.eurPerSecond).toBeCloseTo(both.passagesPerSecond * both.marginEur);
    // Per-product €/s = its own flow × its own margin.
    for (const item of both.products) {
      expect(item.eurPerSecond).toBeCloseTo(item.passagesPerSecond * item.marginEur);
    }
  });

  it('groups several facings of the same product on one line', () => {
    const stacked = planogram('p1', 'f1', ['rich', 'rich']);
    const metrics = computeSelectedProductMetrics(
      testScene,
      stacked,
      ['p1-0', 'p1-1'],
      products,
      visits(),
      10,
    )!;
    expect(metrics.products).toHaveLength(1);
    expect(metrics.products[0].facings).toBe(2);
    expect(metrics.products[0].marginEur).toBeCloseTo(8);
  });

  it('reports zero flow without analytics but still exposes the margin', () => {
    const metrics = computeSelectedProductMetrics(testScene, plano, ['p1-0'], products, null, 0)!;
    expect(metrics.marginEur).toBeCloseTo(4);
    expect(metrics.passagesPerSecond).toBe(0);
    expect(metrics.eurPerSecond).toBe(0);
  });
});

describe('computeMultiSelectedProductMetrics', () => {
  const f1 = furniture('f1');
  const f2 = furniture('f2', { position: [0, 0, 200] });
  const testScene = scene([f1, f2]);
  const plano1 = planogram('p1', 'f1', ['rich', 'poor']);
  const plano2 = planogram('p2', 'f2', ['rich']);

  it('returns null when no planogram yields metrics', () => {
    expect(computeMultiSelectedProductMetrics(testScene, [], products, visits(), 10)).toBeNull();
    expect(
      computeMultiSelectedProductMetrics(
        testScene,
        [{ planogram: plano1, cellIds: [] }],
        products,
        visits(),
        10,
      ),
    ).toBeNull();
  });

  it('matches the single-planogram metrics when only one planogram is selected', () => {
    const single = computeSelectedProductMetrics(testScene, plano1, ['p1-0'], products, visits(), 10);
    const multi = computeMultiSelectedProductMetrics(
      testScene,
      [{ planogram: plano1, cellIds: ['p1-0'] }],
      products,
      visits(),
      10,
    );
    expect(multi).toEqual(single);
  });

  it('cumulates cells selected across several planograms', () => {
    const metrics = computeMultiSelectedProductMetrics(
      testScene,
      [
        { planogram: plano1, cellIds: ['p1-0', 'p1-1'] },
        { planogram: plano2, cellIds: ['p2-0'] },
      ],
      products,
      visits(),
      10,
    )!;
    expect(metrics.count).toBe(3);
    // 'rich' facings from both planograms are merged on one line.
    expect(metrics.products).toHaveLength(2);
    const rich = metrics.products.find((item) => item.ean === 'rich')!;
    expect(rich.facings).toBe(2);
    expect(rich.marginEur).toBeCloseTo(8);
    // Totals sum across planograms: 4 + 0.2 + 4 € of exposed margin.
    expect(metrics.marginEur).toBeCloseTo(8.2);
    expect(metrics.eurPerSecond).toBeCloseTo(metrics.passagesPerSecond * metrics.marginEur);
  });
});

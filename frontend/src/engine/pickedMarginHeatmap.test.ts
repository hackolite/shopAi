import { describe, expect, it } from 'vitest';
import { buildPickedMarginHeatmap } from './pickedMarginHeatmap';
import type { CADProduct, Scene } from '../types/cad';
import type { PickedProductSample } from '../store/simulationStore';

function scene(): Scene {
  return {
    store: {
      id: 'store',
      name: 'Store',
      position: [0, 0, 0],
      dimensions: { width: 1000, depth: 1000, height: 300 },
      floorColor: '#fff',
      wallColor: '#fff',
    },
    furniture: [],
  };
}

function product(patch: Partial<CADProduct> & { ean: string }): CADProduct {
  return {
    name: 'Produit',
    brand: 'Marque',
    category: 'Cat',
    widthCm: 10,
    depthCm: 10,
    heightCm: 10,
    weightG: 100,
    imageUrl: null,
    ...patch,
  };
}

const products: CADProduct[] = [
  product({ ean: 'A', priceSellEur: 5, priceBuyEur: 3 }), // marge = 2
  product({ ean: 'zero-margin', priceSellEur: 5, priceBuyEur: 5 }),
];

describe('buildPickedMarginHeatmap', () => {
  it('returns null when there is no pickup yet', () => {
    expect(buildPickedMarginHeatmap(scene(), [], products)).toBeNull();
  });

  it('returns null when every picked product carries no margin', () => {
    const log: PickedProductSample[] = [{ ean: 'zero-margin', xCm: 100, zCm: 100 }];
    expect(buildPickedMarginHeatmap(scene(), log, products)).toBeNull();
  });

  it('ignores pickups of unknown products', () => {
    const log: PickedProductSample[] = [{ ean: 'unknown', xCm: 100, zCm: 100 }];
    expect(buildPickedMarginHeatmap(scene(), log, products)).toBeNull();
  });

  it('accumulates margin at the pickup spot, at full weight on the exact cell', () => {
    const log: PickedProductSample[] = [
      { ean: 'A', xCm: 25, zCm: 25 },
      { ean: 'A', xCm: 25, zCm: 25 },
    ];
    const heatmap = buildPickedMarginHeatmap(scene(), log, products, 50);
    expect(heatmap).not.toBeNull();
    // Two pickups of the same product on the same cell: margin doubles.
    expect(heatmap!.maxCount).toBeCloseTo(4);
  });
});

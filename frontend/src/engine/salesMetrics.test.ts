import { describe, expect, it } from 'vitest';
import { computeSalesStats, salesMetricDisplay } from './salesMetrics';
import type { CADProduct } from '../types/cad';
import type { PickedProductSample } from '../store/simulationStore';

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
  product({ ean: 'B', priceSellEur: 10, marginPct: 20 }), // marge = 2
];

function pick(ean: string): PickedProductSample {
  return { ean, xCm: 0, zCm: 0 };
}

describe('computeSalesStats', () => {
  it('returns null when there is no elapsed time yet', () => {
    expect(computeSalesStats([pick('A')], products, 0)).toBeNull();
  });

  it('sums CA and margin of every recorded pickup, ignoring unknown products', () => {
    const stats = computeSalesStats([pick('A'), pick('B'), pick('unknown')], products, 10);
    expect(stats).not.toBeNull();
    expect(stats!.totalCaEur).toBeCloseTo(15);
    expect(stats!.totalMarginEur).toBeCloseTo(4);
    expect(stats!.caPerSecond).toBeCloseTo(1.5);
    expect(stats!.marginPerSecond).toBeCloseTo(0.4);
  });

  it('treats a missing/empty log as zero sales', () => {
    const stats = computeSalesStats([], products, 10);
    expect(stats).toEqual({
      elapsedSeconds: 10,
      totalCaEur: 0,
      totalMarginEur: 0,
      caPerSecond: 0,
      marginPerSecond: 0,
    });
  });
});

describe('salesMetricDisplay', () => {
  const stats = computeSalesStats([pick('A'), pick('B')], products, 10)!;

  it('formats the CA total', () => {
    expect(salesMetricDisplay('ca-total', stats)).toEqual({ label: 'CA total', value: '15 €' });
  });

  it('formats the margin total', () => {
    expect(salesMetricDisplay('margin-total', stats)).toEqual({ label: 'Marge total', value: '4 €' });
  });

  it('formats the margin per second', () => {
    expect(salesMetricDisplay('margin-per-second', stats)).toEqual({ label: 'Marge/s', value: '0,4 €/s' });
  });

  it('formats the CA per second', () => {
    expect(salesMetricDisplay('ca-per-second', stats)).toEqual({ label: 'CA/s', value: '1,5 €/s' });
  });

  it('shows a dash for every metric when there is no data', () => {
    for (const id of ['ca-total', 'margin-total', 'margin-per-second', 'ca-per-second'] as const) {
      expect(salesMetricDisplay(id, null).value).toBe('—');
    }
  });
});

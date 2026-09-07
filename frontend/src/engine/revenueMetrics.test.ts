/**
 * Unit tests for the aggregated CA (revenue) / margin metrics.
 */
import { describe, expect, it } from 'vitest';
import { computeRevenueSummary, revenueMetricDisplay } from './revenueMetrics';
import type { AgentBasket, CADProduct } from '../types/cad';

function product(partial: Partial<CADProduct> & { ean: string }): CADProduct {
  return {
    name: partial.ean,
    brand: '',
    category: '',
    widthCm: 10,
    depthCm: 10,
    heightCm: 10,
    weightG: 100,
    imageUrl: null,
    ...partial,
  };
}

function basket(partial: Partial<AgentBasket>): AgentBasket {
  return {
    pedestrianId: 1,
    agentId: 1,
    profile: {},
    items: [],
    active: true,
    ...partial,
  };
}

describe('computeRevenueSummary', () => {
  it('returns zeros (never NaN) when there is no basket', () => {
    for (const input of [null, undefined, []]) {
      const summary = computeRevenueSummary(input, [], 100);
      expect(summary.customerCount).toBe(0);
      expect(summary.totalRevenueEur).toBe(0);
      expect(summary.totalMarginEur).toBe(0);
      expect(summary.revenuePerSecond).toBe(0);
      expect(summary.marginPerSecond).toBe(0);
      expect(summary.averageRevenueEur).toBe(0);
      expect(summary.averageMarginEur).toBe(0);
    }
  });

  it('sums only picked items using the sell price and exposed margin', () => {
    const products = [
      product({ ean: 'A', priceSellEur: 10, priceBuyEur: 6 }),
      product({ ean: 'B', priceSellEur: 20, marginPct: 25 }),
    ];
    const baskets = [
      basket({
        pedestrianId: 1,
        items: [
          { ean: 'A', name: 'A', found: true, reasonNotFound: null, picked: true, pickedAtSeconds: 1 },
          { ean: 'B', name: 'B', found: true, reasonNotFound: null, picked: false, pickedAtSeconds: null },
        ],
      }),
      basket({
        pedestrianId: 2,
        items: [
          { ean: 'B', name: 'B', found: true, reasonNotFound: null, picked: true, pickedAtSeconds: 2 },
        ],
      }),
    ];
    const summary = computeRevenueSummary(baskets, products, 10);
    expect(summary.customerCount).toBe(2);
    // A: 10€ sell / 4€ margin. B (picked in basket 2): 20€ sell / 5€ margin.
    expect(summary.totalRevenueEur).toBeCloseTo(30);
    expect(summary.totalMarginEur).toBeCloseTo(9);
    expect(summary.revenuePerSecond).toBeCloseTo(3);
    expect(summary.marginPerSecond).toBeCloseTo(0.9);
    expect(summary.averageRevenueEur).toBeCloseTo(15);
    expect(summary.averageMarginEur).toBeCloseTo(4.5);
  });

  it('exposes a label and value for every metric id', () => {
    const products = [product({ ean: 'A', priceSellEur: 10, priceBuyEur: 6 })];
    const baskets = [
      basket({
        pedestrianId: 1,
        items: [{ ean: 'A', name: 'A', found: true, reasonNotFound: null, picked: true, pickedAtSeconds: 1 }],
      }),
    ];
    const summary = computeRevenueSummary(baskets, products, 5);
    expect(revenueMetricDisplay('total-revenue', summary)).toEqual({ label: 'CA total', value: '10 €' });
    expect(revenueMetricDisplay('total-margin', summary)).toEqual({ label: 'Marge totale', value: '4 €' });
    expect(revenueMetricDisplay('margin-per-second', summary).value).toBe('0,8 €/s');
    expect(revenueMetricDisplay('revenue-per-second', summary).value).toBe('2 €/s');
    expect(revenueMetricDisplay('average-margin', summary).value).toBe('4 €');
    expect(revenueMetricDisplay('average-revenue', summary).value).toBe('10 €');
  });
});

import { describe, expect, it } from 'vitest';
import type { AbsoluteYieldStats } from './absoluteYield';
import { YIELD_METRIC_IDS, yieldMetricDisplay } from './yieldMetrics';

const stats: AbsoluteYieldStats = {
  elapsedSeconds: 10,
  totalEurPerSecond: 22.345,
  maxCellEurPerSecond: 20,
  productiveCells: 2,
  exposedFlowPerSecond: 2.5,
  exposedPassages: 25,
  exposedMarginEur: 1450.4,
};

describe('yieldMetricDisplay', () => {
  it('formats the exposed margin in euros', () => {
    expect(yieldMetricDisplay('exposed-margin', stats)).toEqual({
      label: 'Marge exposée',
      value: '1\u202f450 €',
    });
  });

  it('formats the exposed flow as the raw number of clients counted', () => {
    expect(yieldMetricDisplay('exposed-flow', stats)).toEqual({
      label: 'Flux exposé',
      value: '25 clients',
    });
  });

  it('formats the exposed flow per second', () => {
    expect(yieldMetricDisplay('exposed-flow-per-second', stats)).toEqual({
      label: 'Flux exposé / s',
      value: '2,5 pers/s',
    });
  });

  it('formats the yield in euros of exposed margin per second', () => {
    expect(yieldMetricDisplay('yield-eur-per-second', stats)).toEqual({
      label: 'Rendement',
      value: '22,35 €/s',
    });
  });

  it('shows a placeholder for every metric when stats are unavailable', () => {
    for (const id of YIELD_METRIC_IDS) {
      expect(yieldMetricDisplay(id, null).value).toBe('—');
    }
  });
});

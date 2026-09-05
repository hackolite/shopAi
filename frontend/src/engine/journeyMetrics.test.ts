/**
 * Unit tests for the aggregated customer-journey metrics.
 */
import { describe, expect, it } from 'vitest';
import {
  computeJourneySummary,
  formatDistanceM,
  formatDurationSeconds,
  journeyMetricDisplay,
} from './journeyMetrics';
import type { CustomerJourney } from '../types/cad';

function customer(partial: Partial<CustomerJourney>): CustomerJourney {
  return {
    customerId: 1,
    entryTimeSeconds: 0,
    exitTimeSeconds: null,
    totalTimeSeconds: 0,
    distanceCm: 0,
    active: true,
    ...partial,
  };
}

describe('computeJourneySummary', () => {
  it('returns zeros (never NaN) when there is no customer', () => {
    for (const input of [null, undefined, []]) {
      const summary = computeJourneySummary(input);
      expect(summary.customerCount).toBe(0);
      expect(summary.totalDistanceM).toBe(0);
      expect(summary.totalTimeSeconds).toBe(0);
      expect(summary.averageDistanceM).toBe(0);
      expect(summary.averageTimeSeconds).toBe(0);
    }
  });

  it('totals are plain sums of the rows and averages divide by the count', () => {
    const summary = computeJourneySummary([
      customer({ customerId: 1, distanceCm: 12_000, totalTimeSeconds: 60 }),
      customer({ customerId: 2, distanceCm: 8_000, totalTimeSeconds: 30, exitTimeSeconds: 30, active: false }),
      customer({ customerId: 3, distanceCm: 4_000, totalTimeSeconds: 90 }),
    ]);
    expect(summary.customerCount).toBe(3);
    expect(summary.totalDistanceM).toBeCloseTo(240);
    expect(summary.totalTimeSeconds).toBeCloseTo(180);
    expect(summary.averageDistanceM).toBeCloseTo(80);
    expect(summary.averageTimeSeconds).toBeCloseTo(60);
  });

  it('ignores non-finite values without breaking the totals', () => {
    const summary = computeJourneySummary([
      customer({ customerId: 1, distanceCm: Number.NaN, totalTimeSeconds: 10 }),
      customer({ customerId: 2, distanceCm: 5_000, totalTimeSeconds: Number.POSITIVE_INFINITY }),
    ]);
    expect(summary.totalDistanceM).toBeCloseTo(50);
    expect(summary.totalTimeSeconds).toBeCloseTo(10);
  });
});

describe('formatting helpers', () => {
  it('formats durations under and over a minute', () => {
    expect(formatDurationSeconds(45.24)).toBe('45,2 s');
    expect(formatDurationSeconds(125)).toBe('2 min 05 s');
  });

  it('formats distances in metres and kilometres', () => {
    expect(formatDistanceM(4.26)).toBe('4,3 m');
    expect(formatDistanceM(824)).toBe('824 m');
    expect(formatDistanceM(1250)).toBe('1,3 km');
  });

  it('exposes a label and value for every metric id', () => {
    const summary = computeJourneySummary([
      customer({ customerId: 1, distanceCm: 10_000, totalTimeSeconds: 120 }),
    ]);
    expect(journeyMetricDisplay('total-distance', summary)).toEqual({
      label: 'Distance totale',
      value: '100 m',
    });
    expect(journeyMetricDisplay('total-time', summary)).toEqual({
      label: 'Temps total en magasin',
      value: '2 min 00 s',
    });
    expect(journeyMetricDisplay('average-distance', summary).value).toBe('100 m');
    expect(journeyMetricDisplay('average-time', summary).value).toBe('2 min 00 s');
  });
});

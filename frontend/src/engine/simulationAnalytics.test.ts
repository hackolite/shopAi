import { describe, expect, it } from 'vitest';
import type { SimulationAnalytics, SimulationAnalyticsDelta } from '../types/cad';
import { applyAnalyticsDelta } from './simulationAnalytics';

const base: SimulationAnalytics = {
  timeSeconds: 1,
  heatmap: { cellSizeCm: 50, originXCm: 0, originZCm: 0, cols: 2, rows: 1, counts: [2, 1], maxCount: 2 },
  visitHeatmap: { cellSizeCm: 50, originXCm: 0, originZCm: 0, cols: 2, rows: 1, counts: [1, 1], maxCount: 1 },
  trajectories: [
    { agentId: 1, active: true, pointsCm: [0, 0, 20, 0, 40, 0] },
    { agentId: 2, active: false, pointsCm: [50, 0, 70, 0] },
  ],
  customers: [
    { customerId: 1, active: true, entryTimeSeconds: 0, exitTimeSeconds: null, totalTimeSeconds: 1, distanceCm: 40 },
    { customerId: 2, active: false, entryTimeSeconds: 0, exitTimeSeconds: 1, totalTimeSeconds: 1, distanceCm: 20 },
  ],
};

function delta(overrides: Partial<SimulationAnalyticsDelta> = {}): SimulationAnalyticsDelta {
  return {
    timeSeconds: 2, occupancyIncrements: [], visitIncrements: [], trajectoryAppends: [],
    deactivatedTrajectoryAgentIds: [], customerUpdates: [], ...overrides,
  };
}

describe('applyAnalyticsDelta', () => {
  it('replaces decimated paths, removes evicted entries, and preserves the previous snapshot', () => {
    const previous = structuredClone(base);
    const result = applyAnalyticsDelta(base, delta({
      occupancyIncrements: [{ index: 1, delta: 4 }],
      visitIncrements: [{ index: 1, delta: 2 }],
      trajectoryReplacements: [{ agentId: 1, active: true, pointsCm: [0, 0, 40, 0, 60, 0] }],
      removedTrajectoryAgentIds: [2],
      removedCustomerIds: [2],
      deactivatedTrajectoryAgentIds: [1],
    }));
    expect(base).toEqual(previous);
    expect(result.trajectories).toEqual([{ agentId: 1, active: false, pointsCm: [0, 0, 40, 0, 60, 0] }]);
    expect(result.customers?.map((customer) => customer.customerId)).toEqual([1]);
    expect(result.heatmap?.counts).toEqual([2, 5]);
    expect(result.heatmap?.maxCount).toBe(5);
    expect(result.visitHeatmap?.counts).toEqual([1, 3]);
  });

  it('supports an entry removed and readmitted during the same polling interval', () => {
    const replacement = { agentId: 2, active: true, pointsCm: [100, 0, 120, 0] };
    const result = applyAnalyticsDelta(base, delta({
      removedTrajectoryAgentIds: [2],
      trajectoryReplacements: [replacement],
      removedCustomerIds: [2],
      customerUpdates: [{ ...base.customers![1], active: true, exitTimeSeconds: null }],
    }));
    expect(result.trajectories[1]).toEqual(replacement);
    expect(result.customers?.[1].active).toBe(true);
  });

  it('applies legacy append-only deltas without requiring the new fields', () => {
    const result = applyAnalyticsDelta(base, delta({
      trajectoryAppends: [{ agentId: 1, appendPointsCm: [60, 0] }],
    }));
    expect(result.trajectories[0].pointsCm).toEqual([0, 0, 20, 0, 40, 0, 60, 0]);
    expect(base.trajectories[0].pointsCm).toHaveLength(6);
  });

  it('keeps forty trajectories bounded through repeated server decimation', () => {
    let result: SimulationAnalytics = { timeSeconds: 0, trajectories: [], customers: [], heatmap: null };
    for (let poll = 0; poll < 100; poll += 1) {
      result = applyAnalyticsDelta(result, delta({
        trajectoryReplacements: Array.from({ length: 40 }, (_, agentId) => ({
          agentId, active: true, pointsCm: Array.from({ length: 160 }, (_, i) => i + poll),
        })),
      }));
      expect(result.trajectories).toHaveLength(40);
      expect(result.trajectories.every((path) => path.pointsCm.length === 160)).toBe(true);
    }
  });
});

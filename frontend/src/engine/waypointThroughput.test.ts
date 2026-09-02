import { describe, expect, it } from 'vitest';
import { waypointThroughput } from './waypointThroughput';
import type { WaypointSample } from '../types/cad';

function sample(timeSeconds: number, releasedAgents: number, activeAgents = 0): WaypointSample {
  return { timeSeconds, releasedAgents, activeAgents };
}

describe('waypointThroughput', () => {
  it('derives agents per second from the cumulative released counter', () => {
    const series = waypointThroughput([
      sample(0, 0),
      sample(2, 4),
      sample(4, 6),
    ]);
    expect(series.points.map((point) => point.agentsPerSecond)).toEqual([2, 1]);
    expect(series.currentAgentsPerSecond).toBe(1);
    expect(series.maxAgentsPerSecond).toBe(2);
  });

  it('skips intervals without elapsed time', () => {
    const series = waypointThroughput([sample(1, 0), sample(1, 3), sample(2, 5)]);
    expect(series.points).toHaveLength(1);
    expect(series.currentAgentsPerSecond).toBe(2);
  });

  it('skips a decreasing counter instead of reporting a negative rate', () => {
    const series = waypointThroughput([sample(0, 10), sample(1, 2), sample(2, 5)]);
    expect(series.points.map((point) => point.agentsPerSecond)).toEqual([3]);
  });

  it('returns an empty series for less than two samples', () => {
    expect(waypointThroughput([]).points).toEqual([]);
    expect(waypointThroughput([sample(0, 1)]).currentAgentsPerSecond).toBe(0);
    expect(waypointThroughput([]).maxAgentsPerSecond).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  averageZoneOccupancyMetrics,
  computeZoneOccupancyMetrics,
  pointInPolygonCm,
  zoneAreaM2,
  zoneMetricDisplay,
} from './zoneMetrics';
import type { FloorZone, SimulationAgentFrame } from '../types/cad';

function zone(partial: Partial<FloorZone>): FloorZone {
  return {
    id: 'zone-1',
    type: 'forbidden',
    label: 'Zone',
    x: 0,
    z: 0,
    width: 200,
    depth: 200,
    ...partial,
  };
}

function agent(id: number, xCm: number, zCm: number): SimulationAgentFrame {
  return {
    id,
    xCm,
    zCm,
    headingX: 1,
    headingZ: 0,
    visionAngleDeg: 90,
    visionRangeCm: 200,
  };
}

describe('pointInPolygonCm', () => {
  it('detects points inside and outside a square outline', () => {
    const outline = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
      { x: 100, z: 100 },
      { x: 0, z: 100 },
    ];
    expect(pointInPolygonCm(50, 50, outline)).toBe(true);
    expect(pointInPolygonCm(150, 50, outline)).toBe(false);
  });
});

describe('zoneAreaM2', () => {
  it('computes the area of a rectangular zone in square metres', () => {
    // 200cm x 200cm = 2m x 2m = 4 m²
    expect(zoneAreaM2(zone({}))).toBeCloseTo(4, 5);
  });
});

describe('computeZoneOccupancyMetrics', () => {
  it('counts occupants and derives density from the zone area', () => {
    const zones = [zone({ id: 'z1' })];
    const agents = [agent(1, 50, 50), agent(2, 150, 150), agent(3, 500, 500)];
    const { metrics, occupants } = computeZoneOccupancyMetrics(zones, agents, new Map(), 1);
    const m = metrics.get('z1')!;
    expect(m.occupantCount).toBe(2);
    expect(m.areaM2).toBeCloseTo(4, 5);
    expect(m.densityPerM2).toBeCloseTo(0.5, 5);
    expect(occupants.get('z1')?.has(3)).toBe(false);
  });

  it('computes flow as new entrants per second since the previous sample', () => {
    const zones = [zone({ id: 'z1' })];
    const firstAgents = [agent(1, 50, 50)];
    const first = computeZoneOccupancyMetrics(zones, firstAgents, new Map(), 1);
    expect(first.metrics.get('z1')!.flowPerSecond).toBe(1);

    const secondAgents = [agent(1, 50, 50), agent(2, 60, 60)];
    const second = computeZoneOccupancyMetrics(zones, secondAgents, first.occupants, 0.5);
    // Only agent 2 is new; agent 1 was already inside.
    expect(second.metrics.get('z1')!.flowPerSecond).toBeCloseTo(2, 5);
    expect(second.metrics.get('z1')!.occupantCount).toBe(2);
  });

  it('reuses the previous metric object when a zone did not change', () => {
    const zones = [zone({ id: 'z1' }), zone({ id: 'z2', x: 1000 })];
    const first = computeZoneOccupancyMetrics(zones, [agent(1, 50, 50)], new Map(), 0.5);
    const second = computeZoneOccupancyMetrics(zones, [agent(1, 50, 50)], first.occupants, 0.5, first.metrics);
    // z1: occupant unchanged but flow dropped to 0 -> new object; z2 still empty -> same object.
    expect(second.metrics.get('z1')).not.toBe(first.metrics.get('z1'));
    expect(second.metrics.get('z2')).toBe(first.metrics.get('z2'));
    const third = computeZoneOccupancyMetrics(zones, [agent(1, 50, 50)], second.occupants, 0.7, second.metrics);
    expect(third.metrics.get('z1')).toBe(second.metrics.get('z1'));
  });

  it('returns zero density for degenerate (zero-area) zones', () => {
    const zones = [zone({ id: 'z1', width: 0, depth: 0 })];
    const { metrics } = computeZoneOccupancyMetrics(zones, [agent(1, 0, 0)], new Map(), 1);
    expect(metrics.get('z1')!.areaM2).toBe(0);
    expect(metrics.get('z1')!.densityPerM2).toBe(0);
  });
});

describe('averageZoneOccupancyMetrics', () => {
  it('calculates time-weighted density and flow averages', () => {
    const first = computeZoneOccupancyMetrics(
      [zone({ id: 'z1' })],
      [agent(1, 50, 50), agent(2, 60, 60)],
      new Map(),
      1,
    );
    const firstAverage = averageZoneOccupancyMetrics(first.metrics, new Map(), 1);
    const second = computeZoneOccupancyMetrics(
      [zone({ id: 'z1' })],
      [agent(1, 50, 50)],
      first.occupants,
      1,
    );
    const secondAverage = averageZoneOccupancyMetrics(
      second.metrics,
      firstAverage.accumulators,
      1,
    );

    expect(secondAverage.metrics.get('z1')?.averageDensityPerM2).toBeCloseTo(0.375, 5);
    expect(secondAverage.metrics.get('z1')?.averageFlowPerSecond).toBeCloseTo(1, 5);
  });
});

describe('zoneMetricDisplay', () => {
  it('formats density and flow tiles with French labels and units', () => {
    const metrics = computeZoneOccupancyMetrics([zone({ id: 'z1' })], [agent(1, 50, 50)], new Map(), 0.5).metrics.get('z1');
    expect(zoneMetricDisplay('density', 'Zone 1', metrics)).toEqual({
      label: 'Zone 1 · Densité moyenne',
      value: '0,25 pers/m²',
    });
    expect(zoneMetricDisplay('flow', 'Zone 1', metrics)).toEqual({
      label: 'Zone 1 · Flux moyen',
      value: '2 pers/s',
    });
  });
});

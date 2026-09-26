import { describe, expect, it } from 'vitest';
import {
  aggregateSensorCells,
  filterSensorSamples,
  normalizeMetricValue,
  projectSensorSample,
} from './liveSensors';
import type { SensorSnapshot, StoreConfig } from '../types/cad';

const store: StoreConfig = {
  id: 'store',
  name: 'Store',
  dimensions: { width: 1000, depth: 800, height: 300 },
  floorColor: '#111111',
  wallColor: '#222222',
};

const snapshot: SensorSnapshot = {
  retentionSeconds: 300,
  sampleCount: 2,
  samples: [
    {
      id: 'a',
      sourceId: 's1',
      coordinate: { kind: 'normalized', x: 25, y: 50 },
      data: [{ name: 'temperature', value: 10 }],
    },
    {
      id: 'b',
      sourceId: 's2',
      coordinate: { kind: 'gps', lat: 48.9, lon: 2.3 },
      data: [{ name: 'temperature', value: 30 }],
    },
  ],
  metrics: [{ name: 'temperature', min: 10, max: 30, count: 2 }],
  sources: ['s1', 's2'],
  sourceLabels: {},
  coordinateKinds: ['gps', 'normalized'],
  gpsBounds: { minLat: 48.8, maxLat: 49.0, minLon: 2.2, maxLon: 2.4 },
};

describe('live sensor helpers', () => {
  it('projects normalized coordinates from top-left origin into store cm', () => {
    expect(projectSensorSample(snapshot.samples[0], store, snapshot)).toEqual({
      xCm: 250,
      zCm: 400,
    });
  });

  it('projects gps coordinates using snapshot bounds', () => {
    const projected = projectSensorSample(snapshot.samples[1], store, snapshot);
    expect(projected.xCm).toBeCloseTo(500);
    expect(projected.zCm).toBeCloseTo(400);
  });

  it('normalizes metric values within min/max bounds', () => {
    expect(normalizeMetricValue(20, snapshot.metrics[0])).toBeCloseTo(0.5);
  });

  it('filters samples by selected sources and metric range', () => {
    const filtered = filterSensorSamples(snapshot, ['s2'], {
      metricName: 'temperature',
      minNormalized: 0.75,
      maxNormalized: 1,
    });
    expect(filtered.map((sample) => sample.id)).toEqual(['b']);
  });

  it('aggregates samples into grid cells', () => {
    const cells = aggregateSensorCells(snapshot.samples, store, snapshot, 20, 'temperature', 'temperature', 'temperature');
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0].count).toBeGreaterThan(0);
  });
});

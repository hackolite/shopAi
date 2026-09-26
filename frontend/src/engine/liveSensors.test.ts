import { describe, expect, it } from 'vitest';
import {
  aggregateSensorCells,
  buildMetricStats,
  filterSensorSamples,
  getSensorCellSizeCm,
  normalizeMetricValue,
  projectSensorSample,
  reconcileProgressiveSensorReveal,
  sensorRevealBatchSize,
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

  it('builds metric stats from the currently visible sample set', () => {
    expect(buildMetricStats([snapshot.samples[0]])).toEqual([
      { name: 'temperature', min: 10, max: 10, unit: null, count: 1 },
    ]);
  });

  it('filters samples by selected sources and metric range', () => {
    const filtered = filterSensorSamples(snapshot, ['s2'], {
      metricName: 'temperature',
      minNormalized: 0.75,
      maxNormalized: 1,
    });
    expect(filtered.map((sample) => sample.id)).toEqual(['b']);
  });

  it('returns no samples when no source is selected', () => {
    const filtered = filterSensorSamples(snapshot, [], {
      metricName: 'temperature',
      minNormalized: 0,
      maxNormalized: 1,
    });
    expect(filtered).toEqual([]);
  });

  it('aggregates samples into grid cells', () => {
    const cells = aggregateSensorCells(snapshot.samples, store, snapshot, 20, 'temperature', 'temperature');
    expect(cells).toEqual([
      {
        key: '1:2',
        xCm: 240,
        zCm: 400,
        count: 1,
        colorValue: 10,
        heightValue: 10,
      },
      {
        key: '3:2',
        xCm: 560,
        zCm: 400,
        count: 1,
        colorValue: 30,
        heightValue: 30,
      },
    ]);
  });

  it('averages buffered sensor values inside the same bar cell', () => {
    const cells = aggregateSensorCells([
      {
        id: 'a',
        sourceId: 's1',
        coordinate: { kind: 'normalized', x: 24, y: 48 },
        data: [{ name: 'temperature', value: 10 }],
      },
      {
        id: 'b',
        sourceId: 's2',
        coordinate: { kind: 'normalized', x: 26, y: 52 },
        data: [{ name: 'temperature', value: 30 }],
      },
    ], store, snapshot, 20, 'temperature', 'temperature');

    expect(cells).toEqual([
      {
        key: '1:2',
        xCm: 240,
        zCm: 400,
        count: 2,
        colorValue: 20,
        heightValue: 20,
      },
    ]);
  });

  it('computes a live bar width from the current cell percentage', () => {
    expect(getSensorCellSizeCm(store, 20)).toBe(160);
  });

  it('keeps visible samples and queues only unseen ones for progressive live reveal', () => {
    const next = reconcileProgressiveSensorReveal(['a'], [], snapshot.samples);
    expect(next).toEqual({
      visibleIds: ['a'],
      pendingIds: ['b'],
    });
  });

  it('drops missing ids from the progressive live reveal state', () => {
    const next = reconcileProgressiveSensorReveal(['missing', 'a'], ['b', 'ghost'], [snapshot.samples[0]]);
    expect(next).toEqual({
      visibleIds: ['a'],
      pendingIds: [],
    });
  });

  it('scales live reveal batch sizes with larger pending queues', () => {
    expect(sensorRevealBatchSize(1)).toBe(1);
    expect(sensorRevealBatchSize(30)).toBe(2);
    expect(sensorRevealBatchSize(70)).toBe(4);
    expect(sensorRevealBatchSize(150)).toBe(6);
  });
});

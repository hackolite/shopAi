import { describe, expect, it } from 'vitest';
import {
  aggregateSensorSectors,
  aggregateSensorCells,
  buildMetricStats,
  filterSensorSamples,
  getSensorCellSizeCm,
  isSensorSampleRecent,
  normalizeMetricValue,
  projectSensorSample,
  projectSensorSampleToGridPercent,
  reconcileProgressiveSensorReveal,
  sensorColor,
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

  it('normalizes against explicit override bounds instead of stats when provided (manual color bounding)', () => {
    // Value 20 sits at 50% of the live 10..30 range, but only at 25% of a manual
    // 0..80 range — the override must take priority over `stats` when present.
    expect(normalizeMetricValue(20, snapshot.metrics[0], { bounds: { min: 0, max: 80 } })).toBeCloseTo(0.25);
  });

  it('clamps the normalized ratio to [0, 1] by default, even past the live max', () => {
    // Height/color both clamp upper by default unless `clampUpper: false` is set.
    expect(normalizeMetricValue(50, snapshot.metrics[0])).toBeCloseTo(1);
  });

  it('lets the normalized ratio exceed 1 above the range when clampUpper is false (bar height overflow)', () => {
    // A value beyond the metric's max must still be able to size a bar past its
    // configured max height, instead of being visually capped at 1.
    expect(normalizeMetricValue(50, snapshot.metrics[0], { clampUpper: false })).toBeCloseTo(2);
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

  it('normalizes the metric filter range against a separate stats snapshot covering the whole map', () => {
    // `restrictedSnapshot` mimics a progressive-reveal subset whose local min/max
    // (10..10) would wrongly normalize every value to 1 if used for the filter
    // range. Passing the full `snapshot` (10..30) as the stats source must keep
    // normalization anchored to the true, map-wide min/max instead.
    const restrictedSnapshot: SensorSnapshot = {
      ...snapshot,
      samples: [snapshot.samples[0]],
      metrics: [{ name: 'temperature', min: 10, max: 10, count: 1 }],
    };
    const filtered = filterSensorSamples(restrictedSnapshot, ['s1'], {
      metricName: 'temperature',
      minNormalized: 0,
      maxNormalized: 0.1,
    }, snapshot);
    expect(filtered.map((sample) => sample.id)).toEqual(['a']);
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

  it('aggregates samples into 2D sectors with averaged metrics', () => {
    const sectors = aggregateSensorSectors([
      {
        id: 'a',
        sourceId: 's1',
        timestampMs: 1_000,
        coordinate: { kind: 'normalized', x: 24, y: 48 },
        data: [{ name: 'temperature', value: 10 }],
      },
      {
        id: 'b',
        sourceId: 's2',
        timestampMs: 1_025,
        coordinate: { kind: 'normalized', x: 26, y: 52 },
        data: [{ name: 'temperature', value: 30 }],
      },
    ], snapshot, 10, 'temperature', 'temperature');

    expect(sectors).toEqual([
      {
        key: '2:4',
        col: 2,
        row: 4,
        centerX: 25,
        centerY: 45,
        count: 1,
        colorValue: 10,
        heightValue: 10,
      },
      {
        key: '2:5',
        col: 2,
        row: 5,
        centerX: 25,
        centerY: 55,
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

  it('projects gps coordinates into a normalized 2D grid', () => {
    const projected = projectSensorSampleToGridPercent(snapshot.samples[1], snapshot);
    expect(projected.x).toBeCloseTo(50);
    expect(projected.y).toBeCloseTo(50);
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

  it('uses yellow to red as the default heat ramp family', () => {
    expect(sensorColor(0, 'yellow-red')).toBe('rgb(250, 204, 21)');
    expect(sensorColor(1, 'yellow-red')).toBe('rgb(220, 38, 38)');
  });

  it('flags only fresh samples as recent arrivals', () => {
    expect(isSensorSampleRecent({ ...snapshot.samples[0], timestampMs: 2_000 }, 3_000, 1_500)).toBe(true);
    expect(isSensorSampleRecent({ ...snapshot.samples[0], timestampMs: 1_000 }, 3_000, 1_500)).toBe(false);
  });
});

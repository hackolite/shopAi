import { describe, expect, it } from 'vitest';
import {
  buildDemoSamples,
  createDemoSensorDefinitions,
  DEFAULT_DEMO_SENSOR_COUNT,
} from './liveSensorDemo';

function alternatingRandom() {
  let value = 0;
  return () => {
    value = (value + 0.37) % 1;
    return value;
  };
}

describe('live sensor demo helpers', () => {
  it('creates a dense default grid of sensors with several types distributed in the zone', () => {
    const definitions = createDemoSensorDefinitions(alternatingRandom());
    expect(definitions).toHaveLength(DEFAULT_DEMO_SENSOR_COUNT);
    expect(new Set(definitions.map((definition) => `${definition.coordinate.x}:${definition.coordinate.y}`)).size)
      .toBe(DEFAULT_DEMO_SENSOR_COUNT);
    expect(new Set(definitions.map((definition) => definition.typeKey)).size).toBeGreaterThanOrEqual(4);
  });

  it('honors an explicit sensor count, e.g. for a small demo grid', () => {
    const definitions = createDemoSensorDefinitions(alternatingRandom(), 12);
    expect(definitions).toHaveLength(12);
    expect(new Set(definitions.map((definition) => `${definition.coordinate.x}:${definition.coordinate.y}`)).size).toBe(12);
  });

  it('grows the sensor grid past the hand-placed anchors when a larger count is requested', () => {
    const definitions = createDemoSensorDefinitions(alternatingRandom(), 150);
    expect(definitions).toHaveLength(150);
    expect(new Set(definitions.map((definition) => `${definition.coordinate.x}:${definition.coordinate.y}`)).size).toBe(150);
  });

  it('keeps coordinates fixed while emitting live samples progressively', () => {
    const definitions = createDemoSensorDefinitions(alternatingRandom(), 12);
    const first = buildDemoSamples(1, definitions, { random: alternatingRandom(), nowMs: 1_000 });
    const second = buildDemoSamples(2, definitions, { random: alternatingRandom(), nowMs: 2_000 });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const allowedMetricNames = new Set(['temperature', 'decibel', 'affluence', 'humidity']);
    for (const sample of [...first, ...second]) {
      const definition = definitions.find((item) => item.sourceId === sample.sourceId);
      expect(definition).toBeTruthy();
      expect(sample.coordinate).toEqual(definition?.coordinate);
      expect(sample.data.length).toBeGreaterThan(0);
      expect(sample.data.length).toBeLessThanOrEqual(4);
      for (const metric of sample.data) {
        expect(allowedMetricNames.has(metric.name)).toBe(true);
      }
    }
    expect(first.map((sample) => sample.timestampMs)).toEqual(first.map((_, index) => 1_000 + index * 25));
    expect(second.map((sample) => sample.timestampMs)).toEqual(second.map((_, index) => 2_000 + index * 25));
  });
});

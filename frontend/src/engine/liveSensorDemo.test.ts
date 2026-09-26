import { describe, expect, it } from 'vitest';
import { buildDemoSamples, createDemoSensorDefinitions } from './liveSensorDemo';

function alternatingRandom() {
  let value = 0;
  return () => {
    value = (value + 0.37) % 1;
    return value;
  };
}

describe('live sensor demo helpers', () => {
  it('creates fixed coordinates with several sensor types distributed in the zone', () => {
    const definitions = createDemoSensorDefinitions(alternatingRandom());
    expect(definitions).toHaveLength(12);
    expect(new Set(definitions.map((definition) => `${definition.coordinate.x}:${definition.coordinate.y}`)).size).toBe(12);
    expect(new Set(definitions.map((definition) => definition.typeKey)).size).toBeGreaterThanOrEqual(4);
  });

  it('keeps coordinates fixed while emitting live samples progressively', () => {
    const definitions = createDemoSensorDefinitions(alternatingRandom());
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

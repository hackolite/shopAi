import { afterEach, describe, expect, it } from 'vitest';
import { useSensorStore } from './sensorStore';
import type { SensorSnapshot } from '../types/cad';

function buildSnapshot(sources: string[]): SensorSnapshot {
  return {
    retentionSeconds: 300,
    sampleCount: sources.length,
    samples: sources.map((sourceId, index) => ({
      id: sourceId,
      sourceId,
      sourceLabel: `Sensor ${index + 1}`,
      coordinate: { kind: 'normalized', x: 10 + index * 5, y: 15 + index * 5 },
      data: [{ name: 'affluence', value: index + 1 }],
    })),
    metrics: [{ name: 'affluence', min: 1, max: Math.max(1, sources.length), count: sources.length }],
    sources,
    sourceLabels: Object.fromEntries(sources.map((sourceId, index) => [sourceId, `Sensor ${index + 1}`])),
    coordinateKinds: ['normalized'],
  };
}

describe('sensorStore live source selection', () => {
  afterEach(() => {
    useSensorStore.getState().reset();
  });

  it('auto-selects newly discovered sources until the user edits the selection', () => {
    const store = useSensorStore.getState();
    store.setSnapshot(buildSnapshot(['sensor-a']));
    expect(useSensorStore.getState().selectedSourceIds).toEqual(['sensor-a']);

    useSensorStore.getState().setSnapshot(buildSnapshot(['sensor-a', 'sensor-b']));
    expect(useSensorStore.getState().selectedSourceIds).toEqual(['sensor-a', 'sensor-b']);
  });

  it('preserves manual source filtering when new live sources arrive', () => {
    const store = useSensorStore.getState();
    store.setSnapshot(buildSnapshot(['sensor-a', 'sensor-b']));
    useSensorStore.getState().toggleSource('sensor-b');

    useSensorStore.getState().setSnapshot(buildSnapshot(['sensor-a', 'sensor-b', 'sensor-c']));
    expect(useSensorStore.getState().selectedSourceIds).toEqual(['sensor-a']);
  });
});

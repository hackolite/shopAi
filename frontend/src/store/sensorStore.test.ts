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

  it('keeps newly discovered sources visible even after a manual deselection', () => {
    const store = useSensorStore.getState();
    store.setSnapshot(buildSnapshot(['sensor-a', 'sensor-b']));
    useSensorStore.getState().toggleSource('sensor-b');

    useSensorStore.getState().setSnapshot(buildSnapshot(['sensor-a', 'sensor-b', 'sensor-c']));
    expect(useSensorStore.getState().selectedSourceIds).toEqual(['sensor-a', 'sensor-c']);
  });

  it('forgets a manual exclusion once the source disappears and reappears later', () => {
    const store = useSensorStore.getState();
    store.setSnapshot(buildSnapshot(['sensor-a', 'sensor-b']));
    useSensorStore.getState().toggleSource('sensor-b');
    expect(useSensorStore.getState().selectedSourceIds).toEqual(['sensor-a']);

    useSensorStore.getState().setSnapshot(buildSnapshot(['sensor-a']));
    expect(useSensorStore.getState().excludedSourceIds).toEqual([]);

    useSensorStore.getState().setSnapshot(buildSnapshot(['sensor-a', 'sensor-b']));
    expect(useSensorStore.getState().selectedSourceIds).toEqual(['sensor-a', 'sensor-b']);
  });
});

describe('sensorStore color metric bounds', () => {
  afterEach(() => {
    useSensorStore.getState().reset();
  });

  it('sets and clears manual color bounds per metric without touching other metrics', () => {
    const store = useSensorStore.getState();
    store.setColorMetricBounds('affluence', { min: 0, max: 50 });
    store.setColorMetricBounds('temperature', { min: 10, max: 30 });
    expect(useSensorStore.getState().colorMetricBounds).toEqual({
      affluence: { min: 0, max: 50 },
      temperature: { min: 10, max: 30 },
    });

    useSensorStore.getState().setColorMetricBounds('affluence', null);
    expect(useSensorStore.getState().colorMetricBounds).toEqual({
      temperature: { min: 10, max: 30 },
    });
  });
});

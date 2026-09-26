import { describe, expect, it } from 'vitest';
import {
  buildSensorHudLines,
  sensorSnapshotPollIntervalMs,
  sensorSocketConnectTimeoutMs,
  sensorSocketReconnectDelayMs,
} from './liveSensorHud';

describe('buildSensorHudLines', () => {
  it('shows only the selected building name when a building is selected', () => {
    expect(buildSensorHudLines({
      selectedBuildingName: 'Bâtiment A',
      showLayer: true,
      selectedSourceLabels: ['Entrée', 'Sortie'],
      colorMetric: 'flux',
      heightMetric: 'densité',
    })).toEqual(['Bâtiment A']);
  });

  it('returns the live sensor summary without listing sensor names when no building is selected', () => {
    expect(buildSensorHudLines({
      selectedBuildingName: null,
      showLayer: true,
      selectedSourceLabels: ['Entrée', 'Sortie', 'Caisse 1', 'Caisse 2', 'Caisse 3'],
      colorMetric: 'flux',
      heightMetric: 'densité',
    })).toEqual([
      'Live BAR',
      'Couleur: flux',
      'Hauteur: densité',
    ]);
  });

  it('hides the HUD when the sensor layer is not available', () => {
    expect(buildSensorHudLines({
      selectedBuildingName: null,
      showLayer: false,
      selectedSourceLabels: ['Entrée'],
      colorMetric: 'flux',
      heightMetric: 'densité',
    })).toEqual([]);
  });
});

describe('live sensor socket timings', () => {
  it('uses bounded reconnect backoff', () => {
    expect(sensorSocketReconnectDelayMs(0)).toBe(1200);
    expect(sensorSocketReconnectDelayMs(2)).toBe(3600);
    expect(sensorSocketReconnectDelayMs(99)).toBe(5000);
  });

  it('keeps connection timeout above the live cadence', () => {
    expect(sensorSocketConnectTimeoutMs(2)).toBe(6000);
    expect(sensorSocketConnectTimeoutMs(0.5)).toBe(4000);
  });

  it('polls snapshots at a safe fallback cadence', () => {
    expect(sensorSnapshotPollIntervalMs(2)).toBe(2000);
    expect(sensorSnapshotPollIntervalMs(0.25)).toBe(1500);
  });
});

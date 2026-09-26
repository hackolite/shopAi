import { create } from 'zustand';
import { mergeResidualSensorSectors, type AggregatedSensorSector } from '../engine/liveSensors';
import type { SensorLiveSettings, SensorSnapshot } from '../types/cad';
export type SensorSocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type SensorColorRampName = 'yellow-red' | 'blue-red' | 'green-red' | 'cyan-blue';

export const DEFAULT_DEMO_SENSOR_COUNT = 100;
export const MIN_DEMO_SENSOR_COUNT = 4;
export const MAX_DEMO_SENSOR_COUNT = 300;

export const defaultSensorLiveSettings = (): SensorLiveSettings => ({
  bufferSeconds: 300,
  updateIntervalSeconds: 2,
});

interface SensorState {
  settings: SensorLiveSettings;
  snapshot: SensorSnapshot | null;
  socketStatus: SensorSocketStatus;
  colorMetric: string | null;
  heightMetric: string | null;
  selectedSourceIds: string[];
  sourceSelectionTouched: boolean;
  filterMetric: string | null;
  filterMinNormalized: number;
  filterMaxNormalized: number;
  opacity: number;
  barMaxHeightCm: number;
  cellSizePercent: number;
  mapGridResolution: number;
  colorRamp: SensorColorRampName;
  demoRunning: boolean;
  demoSensorCount: number;
  showLayer: boolean;
  /** Persisted per-zone averages: a zone that received data keeps showing its last
   * known average instead of disappearing when the live buffer momentarily empties. */
  residualSectors: AggregatedSensorSector[];
  residualSignature: string;
  setSettings: (settings: SensorLiveSettings) => void;
  setSnapshot: (snapshot: SensorSnapshot | null) => void;
  setSocketStatus: (status: SensorSocketStatus) => void;
  setColorMetric: (metric: string | null) => void;
  setHeightMetric: (metric: string | null) => void;
  toggleSource: (sourceId: string) => void;
  setAllSources: (selected: boolean) => void;
  setFilterMetric: (metric: string | null) => void;
  setFilterRange: (min: number, max: number) => void;
  setOpacity: (opacity: number) => void;
  setBarMaxHeightCm: (height: number) => void;
  setCellSizePercent: (percent: number) => void;
  setMapGridResolution: (resolution: number) => void;
  setColorRamp: (ramp: SensorColorRampName) => void;
  setDemoRunning: (running: boolean) => void;
  setDemoSensorCount: (count: number) => void;
  setShowLayer: (show: boolean) => void;
  mergeResidualSectors: (freshSectors: AggregatedSensorSector[], signature: string) => void;
  clearResidualSectors: () => void;
  reset: () => void;
}

const baseState = {
  settings: defaultSensorLiveSettings(),
  snapshot: null,
  socketStatus: 'disconnected' as SensorSocketStatus,
  colorMetric: null,
  heightMetric: null,
  selectedSourceIds: [] as string[],
  sourceSelectionTouched: false,
  filterMetric: null,
  filterMinNormalized: 0,
  filterMaxNormalized: 1,
  opacity: 0.85,
  barMaxHeightCm: 600,
  cellSizePercent: 20,
  mapGridResolution: 100,
  colorRamp: 'yellow-red' as SensorColorRampName,
  demoRunning: false,
  demoSensorCount: DEFAULT_DEMO_SENSOR_COUNT,
  showLayer: true,
  residualSectors: [] as AggregatedSensorSector[],
  residualSignature: '',
};

export const useSensorStore = create<SensorState>((set, get) => ({
  ...baseState,
  setSettings: (settings) => set({ settings: { ...defaultSensorLiveSettings(), ...settings } }),
  setSnapshot: (snapshot) => {
    const current = get();
    const metricNames = snapshot?.metrics.map((metric) => metric.name) ?? [];
    const sourceIds = snapshot?.sources ?? [];
    const sourceSelectionTouched = sourceIds.length > 0 ? current.sourceSelectionTouched : false;
    const selectedSourceIds = sourceSelectionTouched
      ? current.selectedSourceIds.filter((sourceId) => sourceIds.includes(sourceId))
      : sourceIds;
    set({
      snapshot,
      colorMetric: metricNames.includes(current.colorMetric ?? '') ? current.colorMetric : (metricNames[0] ?? null),
      heightMetric: metricNames.includes(current.heightMetric ?? '') ? current.heightMetric : (metricNames[1] ?? metricNames[0] ?? null),
      filterMetric: metricNames.includes(current.filterMetric ?? '') ? current.filterMetric : (metricNames[0] ?? null),
      selectedSourceIds,
      sourceSelectionTouched,
    });
  },
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  setColorMetric: (colorMetric) => set({ colorMetric }),
  setHeightMetric: (heightMetric) => set({ heightMetric }),
  toggleSource: (sourceId) => set((state) => ({
    selectedSourceIds: state.selectedSourceIds.includes(sourceId)
      ? state.selectedSourceIds.filter((item) => item !== sourceId)
      : [...state.selectedSourceIds, sourceId],
    sourceSelectionTouched: true,
  })),
  setAllSources: (selected) => set((state) => ({
    selectedSourceIds: selected ? (state.snapshot?.sources ?? []) : [],
    sourceSelectionTouched: true,
  })),
  setFilterMetric: (filterMetric) => set({ filterMetric }),
  setFilterRange: (filterMinNormalized, filterMaxNormalized) => set({
    filterMinNormalized,
    filterMaxNormalized,
  }),
  setOpacity: (opacity) => set({ opacity }),
  setBarMaxHeightCm: (barMaxHeightCm) => set({ barMaxHeightCm }),
  setCellSizePercent: (cellSizePercent) => set({ cellSizePercent: Math.max(2, Math.min(50, Math.round(cellSizePercent))) }),
  setMapGridResolution: (mapGridResolution) => set({ mapGridResolution: Math.max(5, Math.min(100, Math.round(mapGridResolution))) }),
  setColorRamp: (colorRamp) => set({ colorRamp }),
  setDemoRunning: (demoRunning) => set({ demoRunning }),
  setDemoSensorCount: (demoSensorCount) => set({
    demoSensorCount: Math.max(MIN_DEMO_SENSOR_COUNT, Math.min(MAX_DEMO_SENSOR_COUNT, Math.round(demoSensorCount))),
  }),
  setShowLayer: (showLayer) => set({ showLayer }),
  mergeResidualSectors: (freshSectors, signature) => set((state) => {
    const baseline = state.residualSignature === signature ? state.residualSectors : [];
    return {
      residualSectors: mergeResidualSensorSectors(baseline, freshSectors),
      residualSignature: signature,
    };
  }),
  clearResidualSectors: () => set({ residualSectors: [], residualSignature: '' }),
  reset: () => set({ ...baseState }),
}));

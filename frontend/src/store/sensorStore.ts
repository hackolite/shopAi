import { create } from 'zustand';
import type { SensorLiveSettings, SensorSnapshot } from '../types/cad';
export type SensorSocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export const defaultSensorLiveSettings = (): SensorLiveSettings => ({
  bufferSeconds: 300,
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
  cellSizePercent: number;
  barMaxHeightCm: number;
  demoRunning: boolean;
  showLayer: boolean;
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
  setCellSizePercent: (size: number) => void;
  setBarMaxHeightCm: (height: number) => void;
  setDemoRunning: (running: boolean) => void;
  setShowLayer: (show: boolean) => void;
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
  cellSizePercent: 8,
  barMaxHeightCm: 600,
  demoRunning: false,
  showLayer: true,
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
  setCellSizePercent: (cellSizePercent) => set({ cellSizePercent }),
  setBarMaxHeightCm: (barMaxHeightCm) => set({ barMaxHeightCm }),
  setDemoRunning: (demoRunning) => set({ demoRunning }),
  setShowLayer: (showLayer) => set({ showLayer }),
  reset: () => set({ ...baseState }),
}));

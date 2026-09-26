import { create } from 'zustand';
import type { SensorLiveSettings, SensorSnapshot } from '../types/cad';

export type SensorRenderMode = 'point' | 'heatmap' | 'grid' | 'bar';
export type SensorSocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export const defaultSensorLiveSettings = (): SensorLiveSettings => ({
  bufferSeconds: 300,
});

interface SensorState {
  settings: SensorLiveSettings;
  snapshot: SensorSnapshot | null;
  socketStatus: SensorSocketStatus;
  renderMode: SensorRenderMode;
  colorMetric: string | null;
  heightMetric: string | null;
  sizeMetric: string | null;
  selectedSourceIds: string[];
  sourceSelectionInitialized: boolean;
  filterMetric: string | null;
  filterMinNormalized: number;
  filterMaxNormalized: number;
  opacity: number;
  pointScale: number;
  cellSizePercent: number;
  barMaxHeightCm: number;
  demoRunning: boolean;
  showLayer: boolean;
  setSettings: (settings: SensorLiveSettings) => void;
  setSnapshot: (snapshot: SensorSnapshot | null) => void;
  setSocketStatus: (status: SensorSocketStatus) => void;
  setRenderMode: (mode: SensorRenderMode) => void;
  setColorMetric: (metric: string | null) => void;
  setHeightMetric: (metric: string | null) => void;
  setSizeMetric: (metric: string | null) => void;
  toggleSource: (sourceId: string) => void;
  setAllSources: (selected: boolean) => void;
  setFilterMetric: (metric: string | null) => void;
  setFilterRange: (min: number, max: number) => void;
  setOpacity: (opacity: number) => void;
  setPointScale: (scale: number) => void;
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
  renderMode: 'point' as SensorRenderMode,
  colorMetric: null,
  heightMetric: null,
  sizeMetric: null,
  selectedSourceIds: [] as string[],
  sourceSelectionInitialized: false,
  filterMetric: null,
  filterMinNormalized: 0,
  filterMaxNormalized: 1,
  opacity: 0.85,
  pointScale: 1,
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
    const selectedSourceIds = current.sourceSelectionInitialized
      ? current.selectedSourceIds.filter((sourceId) => sourceIds.includes(sourceId))
      : sourceIds;
    set({
      snapshot,
      colorMetric: metricNames.includes(current.colorMetric ?? '') ? current.colorMetric : (metricNames[0] ?? null),
      heightMetric: metricNames.includes(current.heightMetric ?? '') ? current.heightMetric : (metricNames[1] ?? metricNames[0] ?? null),
      sizeMetric: metricNames.includes(current.sizeMetric ?? '') ? current.sizeMetric : (metricNames[2] ?? metricNames[0] ?? null),
      filterMetric: metricNames.includes(current.filterMetric ?? '') ? current.filterMetric : (metricNames[0] ?? null),
      selectedSourceIds,
      sourceSelectionInitialized: true,
    });
  },
  setSocketStatus: (socketStatus) => set({ socketStatus }),
  setRenderMode: (renderMode) => set({ renderMode }),
  setColorMetric: (colorMetric) => set({ colorMetric }),
  setHeightMetric: (heightMetric) => set({ heightMetric }),
  setSizeMetric: (sizeMetric) => set({ sizeMetric }),
  toggleSource: (sourceId) => set((state) => ({
    selectedSourceIds: state.selectedSourceIds.includes(sourceId)
      ? state.selectedSourceIds.filter((item) => item !== sourceId)
      : [...state.selectedSourceIds, sourceId],
    sourceSelectionInitialized: true,
  })),
  setAllSources: (selected) => set((state) => ({
    selectedSourceIds: selected ? (state.snapshot?.sources ?? []) : [],
    sourceSelectionInitialized: true,
  })),
  setFilterMetric: (filterMetric) => set({ filterMetric }),
  setFilterRange: (filterMinNormalized, filterMaxNormalized) => set({
    filterMinNormalized,
    filterMaxNormalized,
  }),
  setOpacity: (opacity) => set({ opacity }),
  setPointScale: (pointScale) => set({ pointScale }),
  setCellSizePercent: (cellSizePercent) => set({ cellSizePercent }),
  setBarMaxHeightCm: (barMaxHeightCm) => set({ barMaxHeightCm }),
  setDemoRunning: (demoRunning) => set({ demoRunning }),
  setShowLayer: (showLayer) => set({ showLayer }),
  reset: () => set({ ...baseState }),
}));

import { create } from 'zustand';
import type {
  SimulationAnalytics,
  SimulationConfig,
  SimulationResult,
  SimulationWaypoint,
} from '../types/cad';

const MAX_HISTORY = 50;

/** Radius (cm) given to every newly created waypoint. */
export const DEFAULT_WAYPOINT_RADIUS_CM = 120;

/** Fallback position (cm) used when the store geometry is unknown. */
const DEFAULT_WAYPOINT_X_CM = 200;
const DEFAULT_WAYPOINT_Z_CM = 200;

function normalizeWaypoint(waypoint: SimulationWaypoint): SimulationWaypoint {
  return {
    ...waypoint,
    type: waypoint.type ?? 'transit',
    retentionSeconds: Number.isFinite(waypoint.retentionSeconds) ? waypoint.retentionSeconds : 0,
  };
}

function normalizeConfig(config: SimulationConfig): SimulationConfig {
  return {
    ...config,
    waypoints: (config.waypoints ?? []).map(normalizeWaypoint),
  };
}

export const defaultSimulationConfig = (): SimulationConfig => ({
  enabled: true,
  arrivalRatePerSecond: 0.25,
  durationSeconds: 120,
  maxCustomers: 80,
  randomSeed: 42,
  desiredSpeedMps: 1.25,
  speedVariation: 0.2,
  waypoints: [],
});

/** Floor heatmap intensity source. */
export type HeatmapMode = 'traffic' | 'margin';

interface SimulationState {
  config: SimulationConfig;
  result: SimulationResult | null;
  analytics: SimulationAnalytics | null;
  showHeatmap: boolean;
  /** What drives the floor heatmap intensity: agent traffic or exposed margin. */
  heatmapMode: HeatmapMode;
  showTrajectories: boolean;
  running: boolean;
  playing: boolean;
  paused: boolean;
  liveSessionId: string | null;
  selectedWaypointId: string | null;
  invalidWaypointIds: string[];
  invalidWaypointSuggestion: { waypointId: string; xCm: number; zCm: number } | null;
  history: SimulationConfig[];
  setConfig: (config: SimulationConfig) => void;
  patchConfig: (patch: Partial<SimulationConfig>) => void;
  addWaypoint: (type?: SimulationWaypoint['type'], position?: { x: number; z: number }) => void;
  updateWaypoint: (id: string, patch: Partial<SimulationWaypoint>, options?: { recordHistory?: boolean }) => void;
  removeWaypoint: (id: string) => void;
  selectWaypoint: (id: string | null) => void;
  undo: () => void;
  setResult: (result: SimulationResult | null) => void;
  setAnalytics: (analytics: SimulationAnalytics | null) => void;
  setShowHeatmap: (showHeatmap: boolean) => void;
  setHeatmapMode: (heatmapMode: HeatmapMode) => void;
  setShowTrajectories: (showTrajectories: boolean) => void;
  setRunning: (running: boolean) => void;
  setPlaying: (playing: boolean) => void;
  setPaused: (paused: boolean) => void;
  setLiveSessionId: (liveSessionId: string | null) => void;
  setInvalidWaypointIds: (ids: string[]) => void;
  setInvalidWaypointSuggestion: (suggestion: { waypointId: string; xCm: number; zCm: number } | null) => void;
  /** Clears every simulation state. Called when switching project. */
  reset: () => void;
}

export const useSimulationStore = create<SimulationState>((set) => ({
  config: defaultSimulationConfig(),
  result: null,
  analytics: null,
  showHeatmap: false,
  heatmapMode: 'traffic',
  showTrajectories: false,
  running: false,
  playing: false,
  paused: false,
  liveSessionId: null,
  selectedWaypointId: null,
  invalidWaypointIds: [],
  invalidWaypointSuggestion: null,
  history: [],
  setConfig: (config) =>
    set({
      config: normalizeConfig(config),
      result: null,
      analytics: null,
      playing: false,
      paused: false,
      liveSessionId: null,
      selectedWaypointId: null,
      invalidWaypointIds: [],
      invalidWaypointSuggestion: null,
      history: [],
    }),
  patchConfig: (patch) =>
    set((state) => ({
      history: [...state.history.slice(-MAX_HISTORY + 1), state.config],
      config: { ...state.config, ...patch },
      invalidWaypointIds: [],
      invalidWaypointSuggestion: null,
    })),
  addWaypoint: (type = 'transit', position) =>
    set((state) => {
      const indexForType = state.config.waypoints.filter((waypoint) => waypoint.type === type).length + 1;
      const waypoint: SimulationWaypoint = {
        id: crypto.randomUUID(),
        label:
          type === 'entry'
            ? `Entrée ${indexForType}`
            : type === 'exit'
              ? `Sortie ${indexForType}`
              : `Point ${indexForType}`,
        type,
        // New waypoints always appear at the bottom-left corner of the grid so
        // they are immediately visible next to the store origin.
        x: position?.x ?? DEFAULT_WAYPOINT_X_CM,
        z: position?.z ?? DEFAULT_WAYPOINT_Z_CM,
        radiusCm: DEFAULT_WAYPOINT_RADIUS_CM,
        optional: false,
        visitProbability: 0.65,
        retentionSeconds: 0,
        visionAngleDeg: 70,
        visionRangeCm: 220,
      };
      return {
        history: [...state.history.slice(-MAX_HISTORY + 1), state.config],
        config: { ...state.config, waypoints: [...state.config.waypoints, waypoint] },
        selectedWaypointId: waypoint.id,
        invalidWaypointIds: [],
        invalidWaypointSuggestion: null,
      };
    }),
  updateWaypoint: (id, patch, options) =>
    set((state) => ({
      history: options?.recordHistory === false
        ? state.history
        : [...state.history.slice(-MAX_HISTORY + 1), state.config],
      config: {
        ...state.config,
        waypoints: state.config.waypoints.map((waypoint) =>
          waypoint.id === id ? { ...waypoint, ...patch } : waypoint,
        ),
      },
      invalidWaypointIds: state.invalidWaypointIds.filter((waypointId) => waypointId !== id),
      invalidWaypointSuggestion: state.invalidWaypointSuggestion?.waypointId === id ? null : state.invalidWaypointSuggestion,
    })),
  removeWaypoint: (id) =>
    set((state) => ({
      history: [...state.history.slice(-MAX_HISTORY + 1), state.config],
      config: {
        ...state.config,
        waypoints: state.config.waypoints.filter((waypoint) => waypoint.id !== id),
      },
      selectedWaypointId: state.selectedWaypointId === id ? null : state.selectedWaypointId,
      invalidWaypointIds: state.invalidWaypointIds.filter((waypointId) => waypointId !== id),
      invalidWaypointSuggestion: state.invalidWaypointSuggestion?.waypointId === id ? null : state.invalidWaypointSuggestion,
    })),
  selectWaypoint: (id) => set({ selectedWaypointId: id }),
  undo: () =>
    set((state) => {
      if (state.history.length === 0) return {};
      const prev = state.history[state.history.length - 1];
      const selectedWaypointId =
        state.selectedWaypointId && prev.waypoints.some((waypoint) => waypoint.id === state.selectedWaypointId)
          ? state.selectedWaypointId
          : null;
      return {
        config: prev,
        history: state.history.slice(0, -1),
        selectedWaypointId,
        invalidWaypointIds: [],
        invalidWaypointSuggestion: null,
      };
    }),
  setResult: (result) => set({ result, invalidWaypointIds: [], invalidWaypointSuggestion: null }),
  setAnalytics: (analytics) => set({ analytics }),
  setShowHeatmap: (showHeatmap) => set({ showHeatmap }),
  setHeatmapMode: (heatmapMode) => set({ heatmapMode }),
  setShowTrajectories: (showTrajectories) => set({ showTrajectories }),
  setRunning: (running) => set({ running }),
  setPlaying: (playing) => set({ playing }),
  setPaused: (paused) => set({ paused }),
  setLiveSessionId: (liveSessionId) => set({ liveSessionId }),
  setInvalidWaypointIds: (ids) => set({ invalidWaypointIds: [...new Set(ids)] }),
  setInvalidWaypointSuggestion: (suggestion) => set({ invalidWaypointSuggestion: suggestion }),
  reset: () =>
    set({
      config: defaultSimulationConfig(),
      result: null,
      analytics: null,
      running: false,
      playing: false,
      paused: false,
      liveSessionId: null,
      selectedWaypointId: null,
      invalidWaypointIds: [],
      invalidWaypointSuggestion: null,
      history: [],
    }),
}));

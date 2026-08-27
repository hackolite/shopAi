import { create } from 'zustand';
import type { SimulationConfig, SimulationResult, SimulationWaypoint } from '../types/cad';

const MAX_HISTORY = 50;

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

interface SimulationState {
  config: SimulationConfig;
  result: SimulationResult | null;
  running: boolean;
  playing: boolean;
  selectedWaypointId: string | null;
  invalidWaypointIds: string[];
  invalidWaypointSuggestion: { waypointId: string; xCm: number; zCm: number } | null;
  history: SimulationConfig[];
  setConfig: (config: SimulationConfig) => void;
  patchConfig: (patch: Partial<SimulationConfig>) => void;
  addWaypoint: (type?: SimulationWaypoint['type']) => void;
  updateWaypoint: (id: string, patch: Partial<SimulationWaypoint>, options?: { recordHistory?: boolean }) => void;
  removeWaypoint: (id: string) => void;
  selectWaypoint: (id: string | null) => void;
  undo: () => void;
  setResult: (result: SimulationResult | null) => void;
  setRunning: (running: boolean) => void;
  setPlaying: (playing: boolean) => void;
  setInvalidWaypointIds: (ids: string[]) => void;
  setInvalidWaypointSuggestion: (suggestion: { waypointId: string; xCm: number; zCm: number } | null) => void;
}

export const useSimulationStore = create<SimulationState>((set) => ({
  config: defaultSimulationConfig(),
  result: null,
  running: false,
  playing: false,
  selectedWaypointId: null,
  invalidWaypointIds: [],
  invalidWaypointSuggestion: null,
  history: [],
  setConfig: (config) =>
    set({
      config: normalizeConfig(config),
      result: null,
      playing: false,
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
  addWaypoint: (type = 'transit') =>
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
        x: 2500,
        z: type === 'entry' ? 300 : type === 'exit' ? 2700 : 1500,
        radiusCm: 120,
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
  setRunning: (running) => set({ running }),
  setPlaying: (playing) => set({ playing }),
  setInvalidWaypointIds: (ids) => set({ invalidWaypointIds: [...new Set(ids)] }),
  setInvalidWaypointSuggestion: (suggestion) => set({ invalidWaypointSuggestion: suggestion }),
}));

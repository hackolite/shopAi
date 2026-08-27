import { create } from 'zustand';
import type { SimulationConfig, SimulationResult, SimulationWaypoint } from '../types/cad';

const MAX_HISTORY = 50;

export const defaultSimulationConfig = (): SimulationConfig => ({
  enabled: true,
  arrivalRatePerSecond: 0.25,
  durationSeconds: 120,
  maxCustomers: 80,
  randomSeed: 42,
  desiredSpeedMps: 1.25,
  speedVariation: 0.2,
  serviceTimeSeconds: 8,
  serviceTimeJitterSeconds: 2,
  queueSlots: 6,
  queueSpacingCm: 80,
  waypoints: [],
});

interface SimulationState {
  config: SimulationConfig;
  result: SimulationResult | null;
  running: boolean;
  selectedWaypointId: string | null;
  history: SimulationConfig[];
  setConfig: (config: SimulationConfig) => void;
  patchConfig: (patch: Partial<SimulationConfig>) => void;
  addWaypoint: () => void;
  updateWaypoint: (id: string, patch: Partial<SimulationWaypoint>, options?: { recordHistory?: boolean }) => void;
  removeWaypoint: (id: string) => void;
  selectWaypoint: (id: string | null) => void;
  undo: () => void;
  setResult: (result: SimulationResult | null) => void;
  setRunning: (running: boolean) => void;
}

export const useSimulationStore = create<SimulationState>((set) => ({
  config: defaultSimulationConfig(),
  result: null,
  running: false,
  selectedWaypointId: null,
  history: [],
  setConfig: (config) => set({ config, result: null, selectedWaypointId: null, history: [] }),
  patchConfig: (patch) =>
    set((state) => ({
      history: [...state.history.slice(-MAX_HISTORY + 1), state.config],
      config: { ...state.config, ...patch },
      result: null,
    })),
  addWaypoint: () =>
    set((state) => {
      const waypoint: SimulationWaypoint = {
        id: crypto.randomUUID(),
        label: `Point ${state.config.waypoints.length + 1}`,
        x: 2500,
        z: 1500,
        radiusCm: 120,
        optional: false,
        visitProbability: 0.65,
        visionAngleDeg: 70,
        visionRangeCm: 220,
      };
      return {
        history: [...state.history.slice(-MAX_HISTORY + 1), state.config],
        config: { ...state.config, waypoints: [...state.config.waypoints, waypoint] },
        result: null,
        selectedWaypointId: waypoint.id,
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
      result: null,
    })),
  removeWaypoint: (id) =>
    set((state) => ({
      history: [...state.history.slice(-MAX_HISTORY + 1), state.config],
      config: {
        ...state.config,
        waypoints: state.config.waypoints.filter((waypoint) => waypoint.id !== id),
      },
      result: null,
      selectedWaypointId: state.selectedWaypointId === id ? null : state.selectedWaypointId,
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
        result: null,
        selectedWaypointId,
      };
    }),
  setResult: (result) => set({ result }),
  setRunning: (running) => set({ running }),
}));

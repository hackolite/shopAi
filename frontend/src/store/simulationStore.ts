import { create } from 'zustand';
import type { SimulationConfig, SimulationResult, SimulationWaypoint } from '../types/cad';

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
  setConfig: (config: SimulationConfig) => void;
  patchConfig: (patch: Partial<SimulationConfig>) => void;
  addWaypoint: () => void;
  updateWaypoint: (id: string, patch: Partial<SimulationWaypoint>) => void;
  removeWaypoint: (id: string) => void;
  selectWaypoint: (id: string | null) => void;
  setResult: (result: SimulationResult | null) => void;
  setRunning: (running: boolean) => void;
}

export const useSimulationStore = create<SimulationState>((set) => ({
  config: defaultSimulationConfig(),
  result: null,
  running: false,
  selectedWaypointId: null,
  setConfig: (config) => set({ config, result: null, selectedWaypointId: null }),
  patchConfig: (patch) =>
    set((state) => ({ config: { ...state.config, ...patch }, result: null })),
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
        config: { ...state.config, waypoints: [...state.config.waypoints, waypoint] },
        result: null,
        selectedWaypointId: waypoint.id,
      };
    }),
  updateWaypoint: (id, patch) =>
    set((state) => ({
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
      config: {
        ...state.config,
        waypoints: state.config.waypoints.filter((waypoint) => waypoint.id !== id),
      },
      result: null,
      selectedWaypointId: state.selectedWaypointId === id ? null : state.selectedWaypointId,
    })),
  selectWaypoint: (id) => set({ selectedWaypointId: id }),
  setResult: (result) => set({ result }),
  setRunning: (running) => set({ running }),
}));

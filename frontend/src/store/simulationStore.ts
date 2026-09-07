import { create } from 'zustand';
import type {
  AgentBasket,
  PedestrianImportResult,
  PickupEvent,
  SimulationAnalytics,
  SimulationConfig,
  SimulationResult,
  SimulationWaypoint,
} from '../types/cad';
import type { JourneyMetricId } from '../engine/journeyMetrics';
import type { YieldMetricId } from '../engine/yieldMetrics';

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
export type HeatmapMode = 'traffic' | 'margin' | 'yield';

/** How long a gamified pickup pop-up stays on screen before fading out. */
export const PICKUP_POPUP_DURATION_MS = 5000;

/** A transient, world-anchored pop-up shown when an agent picks a product. */
export interface PickupPopup {
  id: string;
  agentId: number;
  pedestrianId: number;
  ean: string;
  name: string | null;
  xCm: number;
  zCm: number;
  createdAt: number;
}

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
  /**
   * Journey metric tiles selected in the « Waypoints & rendement » panel: they
   * are displayed as a large HUD at the top-right of the 3D scene (drawn inside
   * the WebGL canvas so it appears in the video recording).
   */
  pinnedJourneyMetrics: JourneyMetricId[];
  /** Same as `pinnedJourneyMetrics` for the exposed-margin (rendement) tiles. */
  pinnedYieldMetrics: YieldMetricId[];
  history: SimulationConfig[];
  /** Last pedestrian CSV imported for this project (basket import feature). */
  pedestrianImport: PedestrianImportResult | null;
  /** Stable agent id of the pedestrian clicked in the 3D scene, if any. */
  selectedAgentId: number | null;
  /** Basket detail (picked/not-picked) of the currently selected pedestrian. */
  agentBasket: AgentBasket | null;
  /** Every pedestrian basket seen so far in the running session, for the
   * « parcours client » panel. */
  journeyBaskets: AgentBasket[];
  /** Transient gamified pop-ups shown above agents that just picked a product. */
  pickupPopups: PickupPopup[];
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
  /** Toggles one journey metric tile in/out of the pinned HUD selection. */
  toggleJourneyMetric: (id: JourneyMetricId) => void;
  /** Toggles one exposed-margin metric tile in/out of the pinned HUD selection. */
  toggleYieldMetric: (id: YieldMetricId) => void;
  setPedestrianImport: (result: PedestrianImportResult | null) => void;
  selectAgent: (id: number | null) => void;
  setAgentBasket: (basket: AgentBasket | null) => void;
  setJourneyBaskets: (baskets: AgentBasket[]) => void;
  /** Turns freshly-completed pickup events into transient world-anchored pop-ups. */
  pushPickupEvents: (
    events: PickupEvent[],
    agentPositions: Map<number, { xCm: number; zCm: number }>,
  ) => void;
  removePickupPopup: (id: string) => void;
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
  pinnedJourneyMetrics: [],
  pinnedYieldMetrics: [],
  history: [],
  pedestrianImport: null,
  selectedAgentId: null,
  agentBasket: null,
  journeyBaskets: [],
  pickupPopups: [],
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
  toggleJourneyMetric: (id) =>
    set((state) => ({
      pinnedJourneyMetrics: state.pinnedJourneyMetrics.includes(id)
        ? state.pinnedJourneyMetrics.filter((metricId) => metricId !== id)
        : [...state.pinnedJourneyMetrics, id],
    })),
  toggleYieldMetric: (id) =>
    set((state) => ({
      pinnedYieldMetrics: state.pinnedYieldMetrics.includes(id)
        ? state.pinnedYieldMetrics.filter((metricId) => metricId !== id)
        : [...state.pinnedYieldMetrics, id],
    })),
  setPedestrianImport: (result) => set({ pedestrianImport: result }),
  selectAgent: (id) => set({ selectedAgentId: id, agentBasket: null }),
  setAgentBasket: (basket) => set({ agentBasket: basket }),
  setJourneyBaskets: (baskets) => set({ journeyBaskets: baskets }),
  pushPickupEvents: (events, agentPositions) =>
    set((state) => {
      if (events.length === 0) return {};
      const now = performance.now();
      const created = events.map((event) => {
        const position = agentPositions.get(event.agentId);
        return {
          id: `${event.agentId}-${event.ean}-${event.timeSeconds}-${Math.random().toString(36).slice(2, 8)}`,
          agentId: event.agentId,
          pedestrianId: event.pedestrianId,
          ean: event.ean,
          name: event.name,
          xCm: position?.xCm ?? 0,
          zCm: position?.zCm ?? 0,
          createdAt: now,
        };
      });
      created.forEach((popup) => {
        window.setTimeout(() => {
          useSimulationStore.getState().removePickupPopup(popup.id);
        }, PICKUP_POPUP_DURATION_MS);
      });
      return { pickupPopups: [...state.pickupPopups, ...created] };
    }),
  removePickupPopup: (id) =>
    set((state) => ({ pickupPopups: state.pickupPopups.filter((popup) => popup.id !== id) })),
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
      pinnedJourneyMetrics: [],
      pinnedYieldMetrics: [],
      history: [],
      pedestrianImport: null,
      selectedAgentId: null,
      agentBasket: null,
      journeyBaskets: [],
      pickupPopups: [],
    }),
}));

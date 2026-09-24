import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { cadApi } from '../../api/cad';
import { platformApi, type PlatformPedestrianDataset } from '../../api/platform';
import { isSessionNotFoundError } from '../../engine/liveSession';
import { applyAnalyticsDelta } from '../../engine/simulationAnalytics';
import { LIVE_FRAME_WINDOW, LIVE_TICK_INTERVAL_MS } from '../../engine/simulationPlayback';
import {
  extractBlockingElementHighlight,
  extractConstraintCorrection,
  extractConstraintPoint,
  formatConstraintCorrection,
  hasDistinctConstraintSuggestion,
  pickClosestWaypointId,
} from '../../engine/simulationConstraint';
import { useSceneStore } from '../../store/sceneStore';
import { useZoneStore } from '../../store/zoneStore';
import {
  buildRuntimeSimulationConfig,
  useSimulationStore,
  type HeatmapMode,
} from '../../store/simulationStore';
import { useProjectStore } from '../../store/projectStore';
import { useAssetStore } from '../../store/assetStore';
import { useUIStore } from '../../store/uiStore';
import type {
  AgentBasket,
  SimulationConfig,
  SimulationWaypoint,
  WaypointMetrics,
} from '../../types/cad';

interface SimulationPanelProps {
  projectId: string | null;
}

/** Heatmap and trajectories change slowly: refresh them far less often than agents. */
const ANALYTICS_INTERVAL_MS = 1000;
/**
 * Upper bound on the number of backend steps requested by a single tick, so a
 * tab that was hidden/throttled for a long time catches up progressively
 * (a few ticks in a row) instead of one huge, slow request. At 100ms/step
 * this is 5 simulated seconds per call.
 */
const MAX_CATCH_UP_STEPS = 50;

function formatSeconds(value: number): string {
  return `${value.toFixed(1)} s`;
}

function mergeBasketDelta(current: AgentBasket[], changed: AgentBasket[]): AgentBasket[] {
  if (changed.length === 0) return current;
  const byAgent = new Map(current.map((item) => [item.agentId, item]));
  for (const basket of changed) byAgent.set(basket.agentId, basket);
  return Array.from(byAgent.values()).sort((a, b) => (a.agentId ?? -1) - (b.agentId ?? -1));
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  title,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label
      className={[
        'flex items-center gap-2 text-xs text-gray-300',
        disabled ? 'opacity-40' : '',
      ].join(' ')}
      title={title}
    >
      <span className="w-28 shrink-0 text-gray-500">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="flex-1 min-w-0 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  );
}

type SimulationSectionId = 'config' | 'dataset' | 'waypoints' | 'analysis' | 'queues' | 'summary';

function CollapsibleSection({
  sectionId,
  title,
  collapsedSections,
  setCollapsedSections,
  children,
  defaultOpen = true,
  className = 'space-y-2 rounded border border-gray-800 bg-gray-950/70 p-3',
}: {
  sectionId: SimulationSectionId;
  title: string;
  collapsedSections: Record<SimulationSectionId, boolean>;
  setCollapsedSections: Dispatch<SetStateAction<Record<SimulationSectionId, boolean>>>;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const collapsed = collapsedSections[sectionId] ?? !defaultOpen;
  return (
    <section className={className}>
      <button
        type="button"
        onClick={() => setCollapsedSections((current) => ({ ...current, [sectionId]: !collapsed }))}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={!collapsed}
      >
        <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h4>
        <span className="text-sm text-gray-500">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && children}
    </section>
  );
}

function persistSettings(projectId: string | null, config: SimulationConfig) {
  if (!projectId) return;
  cadApi.updateSettings(projectId, { simulation: config }).catch(console.error);
}

function snapshotSimulationInput(scene: object, config: SimulationConfig): string {
  return JSON.stringify({ scene, config });
}

function WaypointEditor({
  waypoint,
  invalid,
  accentColor,
}: {
  waypoint: SimulationWaypoint;
  invalid: boolean;
  accentColor: string;
}) {
  const { updateWaypoint, removeWaypoint, selectWaypoint, selectedWaypointId } = useSimulationStore();
  const selected = selectedWaypointId === waypoint.id;
  const waypointType = waypoint.type ?? 'transit';
  const isTransit = waypointType === 'transit';
  const typeLabel = waypointType === 'entry' ? 'Entrée' : waypointType === 'exit' ? 'Sortie' : 'Point';

  return (
    <div
      className={[
        'rounded border p-2 space-y-2 transition-colors',
        invalid
          ? 'border-red-500 bg-red-950/20'
          : selected
            ? 'bg-blue-950/20'
            : 'border-gray-800 bg-gray-900/60',
      ].join(' ')}
      style={selected && !invalid ? { borderColor: accentColor } : undefined}
      onClick={() => selectWaypoint(waypoint.id)}
    >
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={waypoint.label}
          onChange={(event) => updateWaypoint(waypoint.id, { label: event.target.value })}
          className="flex-1 min-w-0 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={(event) => {
            event.stopPropagation();
            removeWaypoint(waypoint.id);
          }}
          className="rounded px-2 py-1 text-xs text-red-300 hover:bg-red-950/40"
        >
          Suppr.
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <span className="w-28 shrink-0 text-gray-500">Type</span>
        <select
          value={waypointType}
          onChange={(event) => {
            const nextType = event.target.value as SimulationWaypoint['type'];
            updateWaypoint(waypoint.id, {
              type: nextType,
              optional: nextType === 'transit' ? waypoint.optional : false,
              visitProbability: nextType === 'transit' ? waypoint.visitProbability : 1,
              retentionSeconds: nextType === 'transit' ? waypoint.retentionSeconds : 0,
            });
          }}
          className="flex-1 min-w-0 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
        >
          <option value="entry">Entrée (apparition)</option>
          <option value="transit">Transit</option>
          <option value="exit">Sortie (disparition)</option>
        </select>
      </label>
      <NumberField label="X (cm)" value={waypoint.x} onChange={(value) => updateWaypoint(waypoint.id, { x: value })} />
      <NumberField label="Z (cm)" value={waypoint.z} onChange={(value) => updateWaypoint(waypoint.id, { z: value })} />
      <NumberField
        label="Rayon"
        value={waypoint.radiusCm}
        min={40}
        step={10}
        onChange={(value) => updateWaypoint(waypoint.id, { radiusCm: value })}
      />
      {isTransit && (
        <NumberField
          label="Rétention (s)"
          value={waypoint.retentionSeconds}
          min={0}
          step={0.5}
          onChange={(value) => updateWaypoint(waypoint.id, { retentionSeconds: Math.max(0, value) })}
        />
      )}
      <label className="flex items-center justify-between text-xs text-gray-300">
        <span className="text-gray-500">{isTransit ? 'Optionnel' : `${typeLabel} obligatoire`}</span>
        <input
          type="checkbox"
          checked={isTransit ? waypoint.optional : false}
          onChange={(event) => updateWaypoint(waypoint.id, { optional: event.target.checked })}
          disabled={!isTransit}
          className="accent-blue-500"
        />
      </label>
      {isTransit && waypoint.optional && (
        <NumberField
          label="Probabilité"
          value={waypoint.visitProbability}
          min={0}
          max={1}
          step={0.05}
          onChange={(value) => updateWaypoint(waypoint.id, { visitProbability: Math.max(0, Math.min(1, value)) })}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Vision °"
          value={waypoint.visionAngleDeg}
          min={20}
          max={180}
          step={5}
          onChange={(value) => updateWaypoint(waypoint.id, { visionAngleDeg: value })}
        />
        <NumberField
          label="Portée cm"
          value={waypoint.visionRangeCm}
          min={50}
          step={10}
          onChange={(value) => updateWaypoint(waypoint.id, { visionRangeCm: value })}
        />
      </div>
    </div>
  );
}

export default function SimulationPanel({ projectId }: SimulationPanelProps) {
  const { scene } = useSceneStore();
  const zones = useZoneStore((state) => state.zones);
  const zonesLoaded = useZoneStore((state) => state.zonesLoaded);
  const {
    config,
    patchConfig,
    addWaypointSystem,
    removeWaypointSystem,
    selectWaypointSystem,
    updateWaypointSystem,
    result,
    setResult,
    setResultWaypoints,
    running,
    setRunning,
    playing,
    setPlaying,
    paused,
    setPaused,
    liveSessionId,
    setLiveSessionId,
    setInvalidWaypointIds,
    setInvalidWaypointSuggestion,
    setInvalidObstacleHighlights,
    selectWaypoint,
    invalidWaypointIds,
    setAnalytics,
    showHeatmap,
    setShowHeatmap,
    heatmapMode,
    setHeatmapMode,
    showTrajectories,
    setShowTrajectories,
    showNavigationOverlay,
    setShowNavigationOverlay,
    setWalkablePreview,
    pedestrianImport,
    setPedestrianImport,
    selectedAgentId,
    setAgentBasket,
    setJourneyBaskets,
    pushPickupEvents,
    waypointPlacementType,
    setWaypointPlacementType,
  } = useSimulationStore();
  const loadedProjectId = useProjectStore((state) => state.loadedProjectId);
  const { showGrid, setShowGrid } = useUIStore();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingTick = useRef(false);
  /**
   * Wall-clock timestamp (ms) the simulation clock was last advanced up to.
   * Background/inactive browser tabs throttle `setInterval` (down to ~1
   * call/s, sometimes less), so a fixed "1 step per tick" would make the
   * pedestrian CSV dequeue (driven by `time_seconds`, see
   * `live_simulation.py::_spawn_pedestrians_if_due`) fall behind real time
   * whenever the user navigates away from the tab. Tracking elapsed
   * real time here lets every tick request the exact number of backend
   * steps needed to catch the simulation clock back up to now, so it keeps
   * running on schedule even while hidden.
   */
  const lastTickAt = useRef<number | null>(null);
  const updateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyticsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingAnalytics = useRef(false);
  const journeyBasketsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingJourneyBaskets = useRef(false);
  const pendingAgentBasket = useRef(false);
  const [pedestrianDatasetError, setPedestrianDatasetError] = useState<string | null>(null);
  const [isLoadingPedestrians, setIsLoadingPedestrians] = useState(false);
  const [availablePedestrianDatasets, setAvailablePedestrianDatasets] = useState<PlatformPedestrianDataset[]>([]);
  const [selectedPedestrianDatasetId, setSelectedPedestrianDatasetId] = useState('');
  const [appliedPedestrianDataset, setAppliedPedestrianDataset] = useState<PlatformPedestrianDataset | null>(null);
  const appliedPedestrianDatasetRef = useRef<PlatformPedestrianDataset | null>(null);
  const [isApplyingPedestrianDataset, setIsApplyingPedestrianDataset] = useState(false);
  /**
   * The live session id the active dataset was successfully loaded into.
   */
  const [pedestrianLoadedSessionId, setPedestrianLoadedSessionId] = useState<string | null>(null);
  const lastSimulationSignature = useRef<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<SimulationSectionId, boolean>>({
    config: false,
    dataset: false,
    waypoints: false,
    analysis: false,
    queues: false,
    summary: false,
  });
  /**
   * The live session currently running on the backend, together with the
   * project it belongs to.  Keeping the owning project alongside the id makes
   * the cleanup below independent of the order in which the simulation store
   * is reset when switching projects: a `liveSessionId` cleared while another
   * project is selected can never erase the previous project's session.
   */
  const liveSession = useRef<{ projectId: string; sessionId: string } | null>(null);
  const waypointMetricsSessionId = useRef<string | null>(null);
  const analyticsSeqRef = useRef<number>(0);
  const basketsSeqRef = useRef<number>(0);
  const selectedBasketSeqRef = useRef<number>(0);
  const selectedBasketAgentIdRef = useRef<number | null>(null);
  /**
   * True when a live-simulation request no longer belongs to the project the
   * app currently holds in memory.  Live-simulation calls are asynchronous:
   * their response can land *after* the user switched project, and applying it
   * would push the previous project's agents, metrics and session id back into
   * the freshly reset store.
   *
   * The check reads `loadedProjectId` from the store instead of a rendered
   * value because switching project clears it synchronously, whereas React may
   * need a moment to re-render this panel (the 3D scene re-render dominates the
   * commit) — during which responses would still be applied.
   */
  const isStale = useCallback(
    (requestProjectId: string | null) => useProjectStore.getState().loadedProjectId !== requestProjectId,
    [],
  );

  useEffect(() => {
    if (liveSessionId && projectId) {
      liveSession.current = { projectId, sessionId: liveSessionId };
    } else if (!liveSessionId && liveSession.current?.projectId === projectId) {
      liveSession.current = null;
      waypointMetricsSessionId.current = null;
    }
  }, [liveSessionId, projectId]);

  // Persist the simulation config, but only once the in-memory config actually
  // belongs to the current project.  Right after a project switch the config
  // still holds the previous project's waypoints, and saving it here would
  // overwrite the newly opened project's settings.
  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persistSettings(projectId, config), 300);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [config, projectId, loadedProjectId]);

  const selectedSummary = result?.summary ?? null;
  const waypointSystems = config.waypointSystems ?? [];
  const activeWaypointSystem = waypointSystems.find((system) => system.id === config.activeWaypointSystemId) ?? null;
  const runtimeConfig = useMemo(() => buildRuntimeSimulationConfig(config), [config]);
  const allConfiguredWaypoints = runtimeConfig.waypoints;
  const sceneWithZones = useMemo(
    () => {
      if (!scene) return null;
      const effectiveZones = zonesLoaded ? zones : (scene.store?.zones ?? []);
      return { ...scene, store: { ...(scene.store ?? {}), zones: effectiveZones } };
    },
    [scene, zones, zonesLoaded],
  );
  const pedestrianLoadedIntoSession = Boolean(liveSessionId) && pedestrianLoadedSessionId === liveSessionId;
  const pedestrianCsvLoaded = pedestrianLoadedIntoSession && playing;
  const hasExplicitDatasetSelection = Boolean(selectedPedestrianDatasetId || appliedPedestrianDataset);
  const datasetModeActive = hasExplicitDatasetSelection || pedestrianLoadedIntoSession;
  const simulationModeLabel = !config.enabled
    ? 'Simulation désactivée'
    : datasetModeActive ? 'Dataset piétons & paniers' : 'JuPedSim';
  const simulationModeBadge = !config.enabled
    ? { label: 'Désactivée', className: 'bg-gray-500/15 text-gray-300' }
    : datasetModeActive
      ? { label: 'Piloté par dataset', className: 'bg-cyan-500/15 text-cyan-200' }
      : { label: 'Piloté par JuPedSim', className: 'bg-emerald-500/15 text-emerald-300' };
  const queueMetrics: WaypointMetrics[] = (result?.waypoints ?? []).filter(
    (metrics) => metrics.retentionSeconds > 0,
  );

  const loadPedestriansIntoSession = useCallback(async (sessionId: string) => {
    if (!projectId) return false;
    setIsLoadingPedestrians(true);
    setPedestrianDatasetError(null);
    try {
      const response = await cadApi.loadPedestriansIntoLiveSimulation(projectId, sessionId);
      if (isStale(projectId)) return false;
      setPedestrianLoadedSessionId(response.sessionId);
      return true;
    } catch (error) {
      if (!isStale(projectId)) {
        console.error('Failed to load pedestrians into live simulation:', error);
        setPedestrianDatasetError(error instanceof Error ? error.message : 'Erreur chargement dataset');
      }
      return false;
    } finally {
      if (!isStale(projectId)) setIsLoadingPedestrians(false);
    }
  }, [isStale, projectId]);

  // Refreshes the walkable-area preview (« chemin navigable » overlay) in the
  // background: failures must never break the simulation flow, but a 422 still
  // highlights the obstacles that now disconnect the entry from the exit.
  const refreshWalkablePreview = useCallback(() => {
    if (!projectId || !sceneWithZones) return;
    if (!useSimulationStore.getState().showNavigationOverlay) return;
    void cadApi
      .getWalkablePreview(projectId, sceneWithZones, runtimeConfig)
      .then((preview) => {
        if (isStale(projectId)) return;
        setWalkablePreview(preview);
      })
      .catch((error) => {
        if (isStale(projectId)) return;
        console.error('Failed to refresh walkable preview:', error);
        const blockingHighlights = extractBlockingElementHighlight(error);
        if (blockingHighlights.allIds.length > 0) {
          setInvalidObstacleHighlights(blockingHighlights);
        }
      });
  }, [isStale, projectId, runtimeConfig, sceneWithZones, setInvalidObstacleHighlights, setWalkablePreview]);

  const toggleNavigationOverlay = useCallback(async (enabled: boolean) => {
    setShowNavigationOverlay(enabled);
    if (!enabled || !projectId || !sceneWithZones) return;
    try {
      const preview = await cadApi.getWalkablePreview(projectId, sceneWithZones, runtimeConfig);
      if (isStale(projectId)) return;
      setWalkablePreview(preview);
    } catch (error) {
      if (isStale(projectId)) return;
      // Entry/exit truly disconnected: keep the last good preview on screen,
      // turn the responsible obstacles red and surface the same error UX as a
      // failed simulation launch.
      const blockingHighlights = extractBlockingElementHighlight(error);
      setInvalidObstacleHighlights(blockingHighlights);
      console.error('Failed to fetch walkable preview:', error);
      alert(error instanceof Error ? error.message : 'Aperçu de la zone navigable impossible');
    }
  }, [isStale, projectId, runtimeConfig, sceneWithZones, setInvalidObstacleHighlights, setShowNavigationOverlay, setWalkablePreview]);

  const runSimulation = useCallback(async () => {
    if (!projectId || !sceneWithZones) return;
    setRunning(true);
    setPedestrianDatasetError(null);
    void platformApi.appendClientLog({
      source: 'frontend',
      category: 'simulation-attempt',
      message: 'Simulation launch requested from 3D panel',
      details: {
        projectId,
        waypointCount: runtimeConfig.waypoints.length,
        furnitureCount: sceneWithZones.furniture.length,
        zoneCount: sceneWithZones.store.zones?.length ?? 0,
      },
    }).catch(() => {});
    try {
      if (liveSessionId) {
        await cadApi.stopLiveSimulation(projectId, liveSessionId).catch(console.error);
      }
      const signature = snapshotSimulationInput(sceneWithZones, runtimeConfig);
      const live = await cadApi.startLiveSimulation(projectId, sceneWithZones, runtimeConfig);
      if (isStale(projectId)) {
        // The user switched project while the session was starting: drop it
        // instead of showing another project's agents.
        await cadApi.stopLiveSimulation(projectId, live.sessionId).catch(console.error);
        return;
      }
      setLiveSessionId(live.sessionId);
      setResult(live.result);
      waypointMetricsSessionId.current = live.sessionId;
      analyticsSeqRef.current = 0;
      basketsSeqRef.current = 0;
      selectedBasketSeqRef.current = 0;
      setPaused(live.paused);
      if (hasExplicitDatasetSelection && pedestrianImport && pedestrianImport.pedestrianCount > 0) {
        await loadPedestriansIntoSession(live.sessionId);
      } else {
        setPedestrianLoadedSessionId(null);
      }
      setPlaying(true);
      lastSimulationSignature.current = signature;
      refreshWalkablePreview();
      void platformApi.appendClientLog({
        source: 'frontend',
        category: 'simulation-attempt',
        message: 'Simulation launch succeeded in 3D panel',
        details: { projectId, sessionId: live.sessionId },
      }).catch(() => {});
    } catch (error) {
      if (isStale(projectId)) {
        // Failure of a run that belongs to a project the user has left: do not
        // touch the current project's simulation state.
        console.warn('Ignoring stale simulation start failure:', error);
        return;
      }
      setPlaying(false);
      setPaused(false);
      setLiveSessionId(null);
      analyticsSeqRef.current = 0;
      basketsSeqRef.current = 0;
      selectedBasketSeqRef.current = 0;
      setResult(null);
      const correction = extractConstraintCorrection(error);
      const blockingHighlights = extractBlockingElementHighlight(error);
      const point = correction ? null : extractConstraintPoint(error);
      const invalidWaypointId = correction?.waypointId ?? (point ? pickClosestWaypointId(point, allConfiguredWaypoints) : null);
      const suggestedPosition =
        correction
        && correction.waypointId
        && hasDistinctConstraintSuggestion(correction)
          ? { waypointId: correction.waypointId, xCm: correction.suggestedXcm as number, zCm: correction.suggestedZcm as number }
          : null;
      if (invalidWaypointId) {
        setInvalidWaypointIds([invalidWaypointId]);
        setInvalidWaypointSuggestion(suggestedPosition);
        selectWaypoint(invalidWaypointId);
      } else {
        setInvalidWaypointIds([]);
        setInvalidWaypointSuggestion(null);
      }
      setInvalidObstacleHighlights(blockingHighlights);
      console.error('Failed to run simulation:', error);
      void platformApi.appendClientLog({
        source: 'frontend',
        category: 'simulation-attempt',
        message: 'Simulation launch failed in 3D panel',
        details: {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {});
      alert(correction ? formatConstraintCorrection(correction) : error instanceof Error ? error.message : 'Simulation impossible');
    } finally {
      setRunning(false);
    }
  }, [
    allConfiguredWaypoints,
    isStale,
    liveSessionId,
    loadPedestriansIntoSession,
    hasExplicitDatasetSelection,
    pedestrianImport,
    projectId,
    refreshWalkablePreview,
    runtimeConfig,
    sceneWithZones,
    selectWaypoint,
    setInvalidWaypointIds,
    setInvalidObstacleHighlights,
    setInvalidWaypointSuggestion,
    setLiveSessionId,
    setPaused,
    setPlaying,
    setResult,
    setRunning,
  ]);

  const stopSimulation = useCallback(async () => {
    if (tickTimer.current) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
    if (updateTimer.current) {
      clearTimeout(updateTimer.current);
      updateTimer.current = null;
    }
    if (analyticsTimer.current) {
      clearInterval(analyticsTimer.current);
      analyticsTimer.current = null;
    }
    pendingTick.current = false;
    pendingAnalytics.current = false;
    setAnalytics(null);
    if (projectId && liveSessionId) {
      await cadApi.stopLiveSimulation(projectId, liveSessionId).catch(console.error);
    }
    setPlaying(false);
    setPaused(false);
    setLiveSessionId(null);
    setResult(null);
    waypointMetricsSessionId.current = null;
    lastSimulationSignature.current = null;
  }, [liveSessionId, projectId, setAnalytics, setLiveSessionId, setPaused, setPlaying, setResult]);

  const pauseSimulation = useCallback(async () => {
    if (!projectId || !liveSessionId) return;
    const live = await cadApi.pauseLiveSimulation(projectId, liveSessionId);
    if (isStale(projectId)) return;
    setResult(live.result);
    waypointMetricsSessionId.current = live.sessionId;
    setPaused(true);
  }, [isStale, liveSessionId, projectId, setPaused, setResult]);

  const resumeSimulation = useCallback(async () => {
    if (!projectId || !liveSessionId) return;
    const live = await cadApi.resumeLiveSimulation(projectId, liveSessionId);
    if (isStale(projectId)) return;
    setResult(live.result);
    waypointMetricsSessionId.current = live.sessionId;
    setPaused(false);
  }, [isStale, liveSessionId, projectId, setPaused, setResult]);

  // The backend session can disappear while the client still holds its id
  // (server restart, idle reaping…). Reset the playback state so the UI shows
  // the launch button again instead of endlessly ticking a dead session.
  const handleLostSession = useCallback(() => {
    setPlaying(false);
    setPaused(false);
    setLiveSessionId(null);
    waypointMetricsSessionId.current = null;
    analyticsSeqRef.current = 0;
    basketsSeqRef.current = 0;
    selectedBasketSeqRef.current = 0;
    lastSimulationSignature.current = null;
  }, [setLiveSessionId, setPaused, setPlaying]);

  // Catalog images are the heaviest background work of the app (hundreds of
  // data-URL decodes and canvas texture rebuilds).  While agents are moving,
  // downgrade the preload to low priority instead of stopping it: it keeps
  // progressing (and the loading gauge with it) without ever competing with the
  // simulation render loop.  Full speed is restored on pause/stop.
  useEffect(() => {
    const active = Boolean(liveSessionId) && playing && !paused;
    useAssetStore.getState().setPreloadThrottled(active);
    return () => { useAssetStore.getState().setPreloadThrottled(false); };
  }, [liveSessionId, paused, playing]);

  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId) return;
    if (!liveSessionId || !playing || paused) return;
    pendingTick.current = false;
    lastTickAt.current = performance.now();
    if (tickTimer.current) clearInterval(tickTimer.current);
    tickTimer.current = setInterval(() => {
      // Stop as soon as another project is being loaded, without waiting for
      // React to re-render this panel and clean the effect up.
      if (isStale(projectId)) return;
      if (pendingTick.current) return;
      // Catch the simulation clock up to real elapsed time instead of always
      // advancing by a single step: this keeps the pedestrian CSV dequeue
      // (and every other time-driven behaviour) on schedule even when the
      // browser throttles this interval in a background/hidden tab.
      const now = performance.now();
      const previousTickAt = lastTickAt.current ?? now;
      const elapsedSteps = Math.max(1, Math.round((now - previousTickAt) / LIVE_TICK_INTERVAL_MS));
      const steps = Math.min(MAX_CATCH_UP_STEPS, elapsedSteps);
      lastTickAt.current = previousTickAt + steps * LIVE_TICK_INTERVAL_MS;
      pendingTick.current = true;
      void cadApi
        .tickLiveSimulation(projectId, liveSessionId, steps, false, LIVE_FRAME_WINDOW)
        .then((live) => {
          if (isStale(projectId)) return;
          setResult({
            ...live.result,
            waypoints: live.result.waypoints.length > 0
              ? live.result.waypoints
              : (waypointMetricsSessionId.current === live.sessionId
                ? (useSimulationStore.getState().result?.waypoints ?? [])
                : []),
          });
          if (live.result.waypoints.length > 0) {
            waypointMetricsSessionId.current = live.sessionId;
          }
          setPaused(live.paused);
          const events = live.result.pickupEvents;
          if (events && events.length > 0) {
            const lastFrame = live.result.frames[live.result.frames.length - 1];
            const positions = new Map<number, { xCm: number; zCm: number }>(
              (lastFrame?.agents ?? []).map((agent) => [agent.id, { xCm: agent.xCm, zCm: agent.zCm }]),
            );
            pushPickupEvents(events, positions);
          }
        })
        .catch((error) => {
          if (isStale(projectId)) return;
          console.error('Failed to tick live simulation:', error);
          if (isSessionNotFoundError(error)) handleLostSession();
        })
        .finally(() => {
          pendingTick.current = false;
        });
    }, LIVE_TICK_INTERVAL_MS);
    return () => {
      if (tickTimer.current) {
        clearInterval(tickTimer.current);
        tickTimer.current = null;
      }
    };
  }, [handleLostSession, isStale, liveSessionId, loadedProjectId, paused, playing, projectId, pushPickupEvents, setPaused, setResult]);

  // Heatmap and trajectories are only fetched while one of the overlays is on,
  // and at a much lower rate than the agent ticks: their payload is far bigger
  // and they evolve slowly.
  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId) return;
    if (!liveSessionId || !playing) return;
    // The analytics overlay includes client journeys and selected-product
    // traffic, so refresh it throughout every active simulation.
    const fetchAnalytics = () => {
      if (isStale(projectId) || pendingAnalytics.current) return;
      pendingAnalytics.current = true;
      void cadApi
        .getLiveSimulationAnalytics(projectId, liveSessionId, analyticsSeqRef.current || undefined)
        .then((payload) => {
          if (isStale(projectId)) return;
          if (payload.sessionId !== useSimulationStore.getState().liveSessionId) return;
          analyticsSeqRef.current = payload.seq;
          if (payload.full || !payload.analyticsDelta) {
            setAnalytics(payload.analytics ?? null);
            setResultWaypoints(payload.waypoints);
            waypointMetricsSessionId.current = payload.sessionId;
          } else {
            const currentAnalytics = useSimulationStore.getState().analytics;
            if (currentAnalytics) {
              setAnalytics(applyAnalyticsDelta(currentAnalytics, payload.analyticsDelta));
              setResultWaypoints(payload.waypoints);
              waypointMetricsSessionId.current = payload.sessionId;
            } else {
              analyticsSeqRef.current = 0;
              void cadApi
                .getLiveSimulationAnalytics(projectId, liveSessionId)
                .then((fullPayload) => {
                  if (isStale(projectId)) return;
                  if (fullPayload.sessionId !== useSimulationStore.getState().liveSessionId) return;
                  analyticsSeqRef.current = fullPayload.seq;
                  setAnalytics(fullPayload.analytics ?? null);
                  setResultWaypoints(fullPayload.waypoints);
                  waypointMetricsSessionId.current = fullPayload.sessionId;
                })
                .catch(() => undefined);
            }
          }
        })
        .catch((error) => {
          if (isStale(projectId)) return;
          console.error('Failed to fetch simulation analytics:', error);
          if (isSessionNotFoundError(error)) handleLostSession();
        })
        .finally(() => {
          pendingAnalytics.current = false;
        });
    };
    fetchAnalytics();
    if (analyticsTimer.current) clearInterval(analyticsTimer.current);
    analyticsTimer.current = setInterval(fetchAnalytics, ANALYTICS_INTERVAL_MS);
    return () => {
      if (analyticsTimer.current) {
        clearInterval(analyticsTimer.current);
        analyticsTimer.current = null;
      }
    };
  }, [
    handleLostSession,
    isStale,
    liveSessionId,
    loadedProjectId,
    playing,
    projectId,
    setAnalytics,
    setResultWaypoints,
    showHeatmap,
    heatmapMode,
    showTrajectories,
  ]);

  // « Parcours client » panel: every pedestrian basket seen so far, refreshed
  // at the same low rate as analytics (its payload grows with the CSV size).
  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId) return;
    if (!liveSessionId || !playing) return;
    const fetchJourneyBaskets = () => {
      if (isStale(projectId) || pendingJourneyBaskets.current) return;
      pendingJourneyBaskets.current = true;
      void cadApi
        .listLiveAgentBaskets(projectId, liveSessionId, basketsSeqRef.current || undefined)
        .then((payload) => {
          if (isStale(projectId)) return;
          basketsSeqRef.current = payload.seq;
          if (payload.full) {
            setJourneyBaskets(payload.baskets);
          } else {
            const current = useSimulationStore.getState().journeyBaskets;
            setJourneyBaskets(mergeBasketDelta(current, payload.baskets));
          }
        })
        .catch((error) => {
          if (isStale(projectId)) return;
          console.error('Failed to fetch pedestrian baskets:', error);
          if (isSessionNotFoundError(error)) handleLostSession();
        })
        .finally(() => {
          pendingJourneyBaskets.current = false;
        });
    };
    fetchJourneyBaskets();
    if (journeyBasketsTimer.current) clearInterval(journeyBasketsTimer.current);
    journeyBasketsTimer.current = setInterval(fetchJourneyBaskets, ANALYTICS_INTERVAL_MS);
    return () => {
      if (journeyBasketsTimer.current) {
        clearInterval(journeyBasketsTimer.current);
        journeyBasketsTimer.current = null;
      }
    };
  }, [handleLostSession, isStale, liveSessionId, loadedProjectId, playing, projectId, setJourneyBaskets]);

  // Pedestrian detail panel: refresh the selected agent's basket whenever the
  // selection changes and while the simulation keeps ticking.
  useEffect(() => {
    if (!projectId || !liveSessionId || selectedAgentId == null) {
      selectedBasketSeqRef.current = 0;
      selectedBasketAgentIdRef.current = null;
      return;
    }
    if (selectedBasketAgentIdRef.current !== selectedAgentId) {
      selectedBasketAgentIdRef.current = selectedAgentId;
      selectedBasketSeqRef.current = 0;
      setAgentBasket(null);
    }
    const fetchBasket = () => {
      if (isStale(projectId) || pendingAgentBasket.current) return;
      pendingAgentBasket.current = true;
      void cadApi
        .getLiveAgentBasket(projectId, liveSessionId, selectedAgentId, selectedBasketSeqRef.current || undefined)
        .then((payload) => {
          if (isStale(projectId)) return;
          selectedBasketSeqRef.current = payload.seq;
          if (payload.changed && payload.basket) {
            setAgentBasket(payload.basket);
          } else {
            const current = useSimulationStore.getState().agentBasket;
            if (current && current.agentId !== selectedAgentId) {
              setAgentBasket(null);
            }
          }
        })
        .catch((error) => {
          if (isStale(projectId)) return;
          console.error('Failed to fetch pedestrian basket:', error);
          if (String(error).includes('[404]')) {
            setAgentBasket(null);
          }
        })
        .finally(() => {
          pendingAgentBasket.current = false;
        });
    };
    fetchBasket();
    const timer = setInterval(fetchBasket, ANALYTICS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isStale, liveSessionId, projectId, selectedAgentId, setAgentBasket]);

  const applyPedestrianDataset = useCallback(async (datasetId: string) => {
    if (!projectId) return;
    const dataset = availablePedestrianDatasets.find((item) => item.id === datasetId) ?? null;
    const previousAppliedDataset = appliedPedestrianDatasetRef.current;
    setIsApplyingPedestrianDataset(true);
    setPedestrianDatasetError(null);
    try {
      const result = await cadApi.loadPedestrianDataset(projectId, datasetId);
      if (isStale(projectId)) return;
      setPedestrianLoadedSessionId(null);
      if (liveSessionId) {
        const loaded = await loadPedestriansIntoSession(liveSessionId);
        if (!loaded) {
          const previousDatasetId = previousAppliedDataset?.id ?? '';
          if (selectedPedestrianDatasetId !== previousDatasetId) {
            setSelectedPedestrianDatasetId(previousDatasetId);
          }
          return;
        }
      }
      setPedestrianImport(result);
      setAppliedPedestrianDataset(dataset);
    } catch (error) {
      console.error('Failed to load pedestrian dataset:', error);
      if (!isStale(projectId)) {
        setPedestrianDatasetError(error instanceof Error ? error.message : 'Erreur chargement dataset');
      }
    } finally {
      if (!isStale(projectId)) setIsApplyingPedestrianDataset(false);
    }
  }, [availablePedestrianDatasets, isStale, liveSessionId, loadPedestriansIntoSession, projectId, selectedPedestrianDatasetId, setPedestrianImport]);

  useEffect(() => {
    if (!projectId) return;
    cadApi.getPedestrians(projectId).then(setPedestrianImport).catch(() => undefined);
  }, [projectId, setPedestrianImport]);

  useEffect(() => {
    platformApi
      .listPedestrianDatasets()
      .then((response) => setAvailablePedestrianDatasets(response.pedestrianDatasets))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    appliedPedestrianDatasetRef.current = appliedPedestrianDataset;
  }, [appliedPedestrianDataset]);

  useEffect(() => {
    setSelectedPedestrianDatasetId('');
    setAppliedPedestrianDataset(null);
    setPedestrianDatasetError(null);
    setPedestrianLoadedSessionId(null);
    analyticsSeqRef.current = 0;
    basketsSeqRef.current = 0;
    selectedBasketSeqRef.current = 0;
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    if (!selectedPedestrianDatasetId) {
      if (pedestrianLoadedIntoSession && appliedPedestrianDatasetRef.current) {
        setSelectedPedestrianDatasetId(appliedPedestrianDatasetRef.current.id);
        setPedestrianDatasetError('Arrêtez la simulation en cours avant de retirer le dataset actif.');
        return;
      }
      if (appliedPedestrianDatasetRef.current) {
        setAppliedPedestrianDataset(null);
        setPedestrianImport(null);
        setPedestrianLoadedSessionId(null);
        setPedestrianDatasetError(null);
      }
      return;
    }
    void applyPedestrianDataset(selectedPedestrianDatasetId);
  }, [applyPedestrianDataset, pedestrianLoadedIntoSession, projectId, selectedPedestrianDatasetId, setPedestrianImport]);

  useEffect(() => {
    if (!projectId || !liveSessionId || !sceneWithZones || !playing) return;
    const signature = snapshotSimulationInput(sceneWithZones, runtimeConfig);
    if (lastSimulationSignature.current === null) {
      lastSimulationSignature.current = signature;
      return;
    }
    if (signature === lastSimulationSignature.current) return;
    if (updateTimer.current) clearTimeout(updateTimer.current);
    updateTimer.current = setTimeout(() => {
      void cadApi
        .updateLiveSimulation(projectId, liveSessionId, sceneWithZones, runtimeConfig)
        .then((live) => {
          if (isStale(projectId)) return;
          setResult(live.result);
          waypointMetricsSessionId.current = live.sessionId;
          setPaused(live.paused);
          lastSimulationSignature.current = signature;
          refreshWalkablePreview();
        })
        .catch((error) => {
          if (isStale(projectId)) return;
          console.error('Failed to hot-update live simulation:', error);
          if (isSessionNotFoundError(error)) {
            handleLostSession();
            return;
          }
          // Constraint rejection (e.g. furniture moved too close to a
          // waypoint): the backend kept the previous layout running, so keep
          // the session alive and highlight the offending waypoint instead.
          const correction = extractConstraintCorrection(error);
          const blockingHighlights = extractBlockingElementHighlight(error);
          const point = correction ? null : extractConstraintPoint(error);
          const invalidWaypointId = correction?.waypointId ?? (point ? pickClosestWaypointId(point, allConfiguredWaypoints) : null);
          if (invalidWaypointId) {
            setInvalidWaypointIds([invalidWaypointId]);
            setInvalidWaypointSuggestion(
              correction && correction.waypointId && hasDistinctConstraintSuggestion(correction)
                ? { waypointId: correction.waypointId, xCm: correction.suggestedXcm as number, zCm: correction.suggestedZcm as number }
                : null,
            );
            selectWaypoint(invalidWaypointId);
          } else {
            setInvalidWaypointIds([]);
            setInvalidWaypointSuggestion(null);
            if (blockingHighlights.furnitureIds.length > 0 || blockingHighlights.zoneIds.length > 0) {
              setResult(null);
            }
          }
          setInvalidObstacleHighlights(blockingHighlights);
        });
    }, 200);
    return () => {
      if (updateTimer.current) clearTimeout(updateTimer.current);
    };
  }, [allConfiguredWaypoints, handleLostSession, isStale, liveSessionId, playing, projectId, refreshWalkablePreview, runtimeConfig, sceneWithZones, selectWaypoint, setInvalidObstacleHighlights, setInvalidWaypointIds, setInvalidWaypointSuggestion, setPaused, setResult]);

  // Stop the backend live session when the panel unmounts *or* when the user
  // switches project, so the previous project's session does not keep running
  // (and its agents do not bleed into the newly opened project).
  useEffect(() => () => {
    if (tickTimer.current) clearInterval(tickTimer.current);
    if (updateTimer.current) clearTimeout(updateTimer.current);
    if (analyticsTimer.current) clearInterval(analyticsTimer.current);
    const session = liveSession.current;
    if (session) {
      liveSession.current = null;
      void cadApi.stopLiveSimulation(session.projectId, session.sessionId).catch(console.error);
    }
  }, [projectId]);

  // The dataset is only actually driving the live simulation once it has been
  // loaded into the *current* session and that session is running.
  const jupedsimFieldOverriddenTitle =
    'Ce paramètre JuPedSim est ignoré : les piétons proviennent du dataset sélectionné et sont déjà pilotés par ce scénario.';

  // Countdown until the next CSV-scheduled pedestrian enters the store, shown
  // while the loaded CSV drives spawning. Pedestrians are spawned in
  // `startUnixTs` order (see `live_simulation.py::_spawn_pedestrians_if_due`),
  // offset so the earliest one arrives at simulation time 0, so the next
  // pending pedestrian is the one at index `spawnedCustomers`.
  let nextPedestrianCountdownSeconds: number | null = null;
  if (pedestrianCsvLoaded && pedestrianImport && pedestrianImport.plans.length > 0) {
    const orderedPlans = [...pedestrianImport.plans].sort((a, b) => a.startUnixTs - b.startUnixTs);
    const spawnedCount = result?.summary.spawnedCustomers ?? 0;
    const nextPlan = orderedPlans[spawnedCount];
    if (nextPlan) {
      const firstStartUnixTs = orderedPlans[0].startUnixTs;
      const scheduledAtSeconds = nextPlan.startUnixTs - firstStartUnixTs;
      const currentTimeSeconds = result?.frames.length
        ? result.frames[result.frames.length - 1].timeSeconds
        : 0;
      nextPedestrianCountdownSeconds = Math.max(0, scheduledAtSeconds - currentTimeSeconds);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-800 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Simulation flux piétons</h3>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <CollapsibleSection
          sectionId="config"
          title="Mode de simulation"
          collapsedSections={collapsedSections}
          setCollapsedSections={setCollapsedSections}
        >
          <div className="rounded-xl border border-gray-800 bg-gray-900/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500">Mode de simulation</p>
                <p className="mt-1 text-sm font-medium text-gray-100">{simulationModeLabel}</p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${simulationModeBadge.className}`}>
                {simulationModeBadge.label}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-snug text-gray-400">
              {datasetModeActive
                ? 'Le dataset sélectionné pilote automatiquement les piétons. Les réglages JuPedSim restent affichés mais sont neutralisés tant que ce scénario est actif.'
                : 'Aucun dataset sélectionné : la simulation passe automatiquement en mode JuPedSim, sans case à activer.'}
            </p>
          </div>
          <NumberField
            label="Clients / sec"
            value={config.arrivalRatePerSecond}
            min={0}
            step={0.05}
            disabled={pedestrianCsvLoaded}
            title={pedestrianCsvLoaded ? jupedsimFieldOverriddenTitle : undefined}
            onChange={(value) => patchConfig({ arrivalRatePerSecond: Math.max(0, value) })}
          />
          <NumberField
            label="Max clients"
            value={config.maxCustomers}
            min={1}
            step={1}
            onChange={(value) => patchConfig({ maxCustomers: Math.max(1, Math.round(value)) })}
          />
          <NumberField
            label="Seed random"
            value={config.randomSeed}
            step={1}
            disabled={pedestrianCsvLoaded}
            title={pedestrianCsvLoaded ? jupedsimFieldOverriddenTitle : undefined}
            onChange={(value) => patchConfig({ randomSeed: Math.round(value) })}
          />
          <NumberField
            label="Vitesse m/s"
            value={config.desiredSpeedMps}
            min={0.5}
            step={0.05}
            disabled={pedestrianCsvLoaded}
            title={pedestrianCsvLoaded ? jupedsimFieldOverriddenTitle : undefined}
            onChange={(value) => patchConfig({ desiredSpeedMps: Math.max(0.5, value) })}
          />
          <NumberField
            label="Variance vitesse"
            value={config.speedVariation}
            min={0}
            step={0.05}
            disabled={pedestrianCsvLoaded}
            title={pedestrianCsvLoaded ? jupedsimFieldOverriddenTitle : undefined}
            onChange={(value) => patchConfig({ speedVariation: Math.max(0, value) })}
          />
          <div className="border-t border-gray-800 my-2 pt-2 flex items-center justify-between text-xs text-gray-300">
            <span className="text-gray-500">Grille de sol</span>
            <button
              type="button"
              onClick={() => setShowGrid(!showGrid)}
              className={[
                'rounded px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer',
                showGrid
                  ? 'bg-red-900/60 hover:bg-red-800/60 text-red-200'
                  : 'bg-blue-600 hover:bg-blue-500 text-white',
              ].join(' ')}
            >
              {showGrid ? 'Supprimer la grille' : 'Afficher la grille'}
            </button>
          </div>
          {playing ? (
            <div className="grid grid-cols-2 gap-2">
              {paused ? (
                <button
                  onClick={() => void resumeSimulation()}
                  className="rounded bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 cursor-pointer"
                >
                  ▶ Reprendre
                </button>
              ) : (
                <button
                  onClick={() => void pauseSimulation()}
                  className="rounded bg-amber-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-amber-500 cursor-pointer"
                >
                  ⏸ Pause
                </button>
              )}
              <button
                onClick={() => void stopSimulation()}
                className="rounded bg-red-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-500 cursor-pointer"
              >
                ⏹ Arrêter
              </button>
            </div>
          ) : (
            <button
              onClick={() => void runSimulation()}
              disabled={running || !config.enabled || isApplyingPedestrianDataset}
              className={[
                'w-full rounded px-3 py-2 text-xs font-semibold text-white transition-colors',
                running || isApplyingPedestrianDataset
                  ? 'bg-amber-500 cursor-not-allowed'
                  : config.enabled
                    ? 'bg-blue-600 hover:bg-blue-500 cursor-pointer'
                    : 'bg-blue-600 opacity-50 cursor-not-allowed',
              ].join(' ')}
            >
              {running
                ? '⏳ Simulation en cours…'
                : isApplyingPedestrianDataset
                  ? '⏳ Application du dataset…'
                  : '▶ Lancer la simulation'}
            </button>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          sectionId="dataset"
          title="Dataset piétons & paniers"
          collapsedSections={collapsedSections}
          setCollapsedSections={setCollapsedSections}
        >
          <p className="text-[11px] leading-snug text-gray-500">
            Choisissez un dataset déjà importé dans le workspace : il remplace aussitôt les piétons du projet et sera joué automatiquement au lancement.
          </p>
          {availablePedestrianDatasets.length > 0 ? (
            <select
              value={selectedPedestrianDatasetId}
              onChange={(event) => setSelectedPedestrianDatasetId(event.target.value)}
              disabled={isApplyingPedestrianDataset}
              className="w-full rounded border border-gray-800 bg-gray-900 px-2 py-1.5 text-xs text-gray-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="" disabled={pedestrianLoadedIntoSession}>Choisir un dataset…</option>
              {availablePedestrianDatasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name} ({dataset.pedestrianCount} piétons)
                </option>
              ))}
            </select>
          ) : (
            <p className="text-[11px] text-gray-500">
              Aucun dataset disponible ici. Importez-en un depuis l’espace de travail &rarr; Simulations.
            </p>
          )}
          {isApplyingPedestrianDataset && (
            <p className="text-[11px] text-gray-400">Application du dataset au projet…</p>
          )}
          {hasExplicitDatasetSelection && pedestrianImport && pedestrianImport.pedestrianCount > 0 && (
            <p className="text-[11px] text-gray-500">
              {appliedPedestrianDataset
                ? `Dataset actif : ${appliedPedestrianDataset.name} · `
                : 'Dataset actif : '}
              {pedestrianImport.pedestrianCount} piéton(s), {pedestrianImport.rowCount} ligne(s)
              {pedestrianImport.anomalies.length > 0 ? `, ${pedestrianImport.anomalies.length} anomalie(s)` : ''}
            </p>
          )}
          {isLoadingPedestrians && <p className="text-[11px] text-gray-400">Synchronisation du dataset avec la simulation…</p>}
          {pedestrianDatasetError && <p className="text-[11px] text-red-300">Erreur: {pedestrianDatasetError}</p>}
          {nextPedestrianCountdownSeconds !== null && (
            <p className="text-[11px] font-medium text-emerald-400">
              Prochain piéton entrant dans {formatSeconds(nextPedestrianCountdownSeconds)}
            </p>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          sectionId="waypoints"
          title="Points de passage"
          collapsedSections={collapsedSections}
          setCollapsedSections={setCollapsedSections}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1" role="group" aria-label="Mode de placement waypoint">
              <button
                type="button"
                onClick={() => setWaypointPlacementType('entry')}
                aria-pressed={waypointPlacementType === 'entry'}
                className={[
                  'rounded px-2 py-1 text-xs transition-colors',
                  waypointPlacementType === 'entry'
                    ? 'bg-emerald-700 text-emerald-100 ring-1 ring-emerald-300/70'
                    : 'bg-gray-800 text-emerald-300 hover:bg-gray-700',
                ].join(' ')}
              >
                Entrée
              </button>
              <button
                type="button"
                onClick={() => setWaypointPlacementType('transit')}
                aria-pressed={waypointPlacementType === 'transit'}
                className={[
                  'rounded px-2 py-1 text-xs transition-colors',
                  waypointPlacementType === 'transit'
                    ? 'bg-blue-700 text-blue-100 ring-1 ring-blue-300/70'
                    : 'bg-gray-800 text-blue-300 hover:bg-gray-700',
                ].join(' ')}
              >
                Waypoint
              </button>
              <button
                type="button"
                onClick={() => setWaypointPlacementType('exit')}
                aria-pressed={waypointPlacementType === 'exit'}
                className={[
                  'rounded px-2 py-1 text-xs transition-colors',
                  waypointPlacementType === 'exit'
                    ? 'bg-orange-700 text-orange-100 ring-1 ring-orange-300/70'
                    : 'bg-gray-800 text-orange-300 hover:bg-gray-700',
                ].join(' ')}
              >
                Sortie
              </button>
              <button
                type="button"
                onClick={() => setWaypointPlacementType(null)}
                aria-pressed={waypointPlacementType === null}
                className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-gray-700"
              >
                Aucun
              </button>
            </div>
            <p className="text-[11px] text-gray-500">
              {waypointPlacementType === null
                ? 'Sélectionnez Entrée, Waypoint ou Sortie, puis cliquez sur le sol 3D.'
                : `Cliquez sur le sol 3D pour poser ${
                  waypointPlacementType === 'entry'
                    ? 'une entrée'
                    : waypointPlacementType === 'exit'
                      ? 'une sortie'
                      : 'un waypoint'
                }.`}
            </p>
          </div>
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-2 space-y-2">
            <div className="flex items-center gap-2">
              <select
                value={activeWaypointSystem?.id ?? ''}
                onChange={(event) => selectWaypointSystem(event.target.value)}
                className="flex-1 rounded border border-gray-800 bg-gray-900 px-2 py-1.5 text-xs text-gray-200"
              >
                {waypointSystems.map((system) => (
                  <option key={system.id} value={system.id}>
                    {system.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => addWaypointSystem()}
                className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-200 hover:bg-gray-700"
              >
                + JuPedSim
              </button>
              <button
                type="button"
                onClick={() => activeWaypointSystem && removeWaypointSystem(activeWaypointSystem.id)}
                disabled={!activeWaypointSystem || waypointSystems.length <= 1}
                className="rounded bg-gray-800 px-2 py-1 text-xs text-red-300 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Suppr.
              </button>
            </div>
            {activeWaypointSystem && (
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input
                  type="text"
                  value={activeWaypointSystem.label}
                  onChange={(event) => updateWaypointSystem(activeWaypointSystem.id, { label: event.target.value })}
                  className="min-w-0 rounded border border-gray-800 bg-gray-900 px-2 py-1.5 text-xs text-gray-200"
                />
                <input
                  type="color"
                  value={activeWaypointSystem.color}
                  onChange={(event) => updateWaypointSystem(activeWaypointSystem.id, { color: event.target.value })}
                  className="h-8 w-12 rounded border border-gray-700 bg-gray-900 p-1"
                />
              </div>
            )}
            <p className="text-[11px] text-gray-500">
              Chaque système JuPedSim garde ses propres waypoints et sa propre couleur active.
            </p>
          </div>
          <p className="text-xs text-gray-500">
            Entrée = apparition, Sortie = disparition, Transit = passage intermédiaire avec temps de rétention.
          </p>
          <div className="space-y-2">
            {config.waypoints.length === 0 ? (
              <div className="rounded border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-600">
                Aucun point de passage.
              </div>
            ) : (
              config.waypoints.map((waypoint) => (
                <WaypointEditor
                  key={waypoint.id}
                  waypoint={waypoint}
                  invalid={invalidWaypointIds.includes(waypoint.id)}
                  accentColor={activeWaypointSystem?.color ?? '#3b82f6'}
                />
              ))
            )}
            {config.waypoints.length > 0 && !config.waypoints.some((w) => w.type === 'exit') && (
              <div className="rounded border border-amber-600/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                ⚠ Aucun point de type « Sortie » configuré — la simulation ne peut pas démarrer. Ajoutez un point de type « Sortie (disparition) ».
              </div>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          sectionId="analysis"
          title="Analyse spatiale"
          collapsedSections={collapsedSections}
          setCollapsedSections={setCollapsedSections}
        >
          <label className="flex items-center justify-between text-xs text-gray-300">
            <span className="text-gray-500">Heatmap au sol</span>
            <input
              type="checkbox"
              checked={showHeatmap}
              onChange={(event) => setShowHeatmap(event.target.checked)}
              className="accent-blue-500"
            />
          </label>
          {showHeatmap && (
            <label className="flex items-center justify-between text-xs text-gray-300">
              <span className="text-gray-500">Intensité</span>
              <select
                value={heatmapMode}
                onChange={(event) => setHeatmapMode(event.target.value as HeatmapMode)}
                className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
              >
                <option value="traffic">Fréquentation</option>
                <option value="margin">Marge (€)</option>
                <option value="yield">Rendement au m² (marge × densité client)</option>
              </select>
            </label>
          )}
          {showHeatmap && heatmapMode === 'yield' && (
            <p className="text-xs text-gray-600">
              Produit de la marge exposée et de la densité client mesurée sur chaque cellule :
              met en évidence le rendement au m². Nécessite une simulation en cours.
            </p>
          )}
          {showHeatmap && heatmapMode === 'margin' && (
            <p className="text-xs text-gray-600">
              Marge cumulée colonne par colonne, diffusée sur l'allée devant chaque colonne de
              planogramme. Indépendante de la simulation.
            </p>
          )}
          <label className="flex items-center justify-between text-xs text-gray-300">
            <span className="text-gray-500">Trajectoires des agents</span>
            <input
              type="checkbox"
              checked={showTrajectories}
              onChange={(event) => setShowTrajectories(event.target.checked)}
              className="accent-blue-500"
            />
          </label>
          <label className="flex items-center justify-between text-xs text-gray-300">
            <span className="text-gray-500">Chemin navigable</span>
            <input
              type="checkbox"
              checked={showNavigationOverlay}
              onChange={(event) => void toggleNavigationOverlay(event.target.checked)}
              className="accent-blue-500"
            />
          </label>
          <label className="flex items-center justify-between text-xs text-gray-300">
            <span className="text-gray-500">Grille au sol</span>
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(event) => setShowGrid(event.target.checked)}
              className="accent-blue-500"
            />
          </label>
          <p className="text-xs text-gray-600">
            Les couches s'affichent dans la vue 3D pendant la simulation.
          </p>
        </CollapsibleSection>

        {queueMetrics.length > 0 && (
          <CollapsibleSection
            sectionId="queues"
            title="Temps d'attente par point"
            collapsedSections={collapsedSections}
            setCollapsedSections={setCollapsedSections}
            className="space-y-2 rounded border border-sky-800/40 bg-sky-950/20 p-3 text-xs text-sky-100"
          >
            {queueMetrics.map((metrics) => (
              <div key={metrics.waypointId} className="space-y-1 rounded border border-sky-900/60 bg-sky-950/30 p-2">
                <div className="flex items-center justify-between font-semibold">
                  <span>{metrics.waypointLabel}</span>
                  <span className="text-sky-300">rétention {formatSeconds(metrics.retentionSeconds)}</span>
                </div>
                <div className="flex justify-between"><span>Attente moyenne</span><span>{formatSeconds(metrics.averageWaitSeconds)}</span></div>
                <div className="flex justify-between"><span>Attente max</span><span>{formatSeconds(metrics.maxWaitSeconds)}</span></div>
                <div className="flex justify-between"><span>En file</span><span>{metrics.queuedAgents}</span></div>
                <div className="flex justify-between"><span>Attente en cours (max)</span><span>{formatSeconds(metrics.currentMaxWaitSeconds)}</span></div>
                <div className="flex justify-between"><span>Clients servis</span><span>{metrics.completedWaits}</span></div>
              </div>
            ))}
          </CollapsibleSection>
        )}

        {selectedSummary && (
          <CollapsibleSection
            sectionId="summary"
            title="Résumé"
            collapsedSections={collapsedSections}
            setCollapsedSections={setCollapsedSections}
            className="space-y-2 rounded border border-emerald-800/40 bg-emerald-950/20 p-3 text-xs text-emerald-100"
          >
            <div className="flex justify-between"><span>Entrés</span><span>{selectedSummary.spawnedCustomers}</span></div>
            <div className="flex justify-between"><span>Sortis</span><span>{selectedSummary.completedCustomers}</span></div>
            <div className="flex justify-between"><span>Encore actifs</span><span>{selectedSummary.activeCustomers}</span></div>
            <div className="flex justify-between"><span>Charge moyenne waypoint</span><span>{selectedSummary.averageWaypointLoad.toFixed(2)}</span></div>
            <div className="flex justify-between"><span>Pic waypoint</span><span>{selectedSummary.maxWaypointLoad}</span></div>
            <div className="flex justify-between"><span>Rétention configurée moy. (s)</span><span>{selectedSummary.averageConfiguredRetentionSeconds.toFixed(2)}</span></div>
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}

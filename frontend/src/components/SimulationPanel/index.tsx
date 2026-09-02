import { useCallback, useEffect, useRef } from 'react';
import { cadApi } from '../../api/cad';
import { isSessionNotFoundError } from '../../engine/liveSession';
import {
  extractConstraintCorrection,
  extractConstraintPoint,
  formatConstraintCorrection,
  hasDistinctConstraintSuggestion,
  pickClosestWaypointId,
} from '../../engine/simulationConstraint';
import { bottomLeftWaypointPosition } from '../../engine/placement';
import { useSceneStore } from '../../store/sceneStore';
import { DEFAULT_WAYPOINT_RADIUS_CM, useSimulationStore, type HeatmapMode } from '../../store/simulationStore';
import { useProjectStore } from '../../store/projectStore';
import { useAssetStore } from '../../store/assetStore';
import type { SimulationConfig, SimulationWaypoint, WaypointMetrics } from '../../types/cad';

interface SimulationPanelProps {
  projectId: string | null;
}

const LIVE_TICK_INTERVAL_MS = 100;
/** Heatmap and trajectories change slowly: refresh them far less often than agents. */
const ANALYTICS_INTERVAL_MS = 1000;

function formatSeconds(value: number): string {
  return `${value.toFixed(1)} s`;
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-300">
      <span className="w-28 shrink-0 text-gray-500">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="flex-1 min-w-0 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
      />
    </label>
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
}: {
  waypoint: SimulationWaypoint;
  invalid: boolean;
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
            ? 'border-blue-500 bg-blue-950/20'
            : 'border-gray-800 bg-gray-900/60',
      ].join(' ')}
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
  const {
    config,
    patchConfig,
    addWaypoint,
    result,
    setResult,
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
    selectWaypoint,
    invalidWaypointIds,
    setAnalytics,
    showHeatmap,
    setShowHeatmap,
    heatmapMode,
    setHeatmapMode,
    showTrajectories,
    setShowTrajectories,
  } = useSimulationStore();
  const loadedProjectId = useProjectStore((state) => state.loadedProjectId);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingTick = useRef(false);
  const updateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyticsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingAnalytics = useRef(false);
  const lastSimulationSignature = useRef<string | null>(null);
  /**
   * The live session currently running on the backend, together with the
   * project it belongs to.  Keeping the owning project alongside the id makes
   * the cleanup below independent of the order in which the simulation store
   * is reset when switching projects: a `liveSessionId` cleared while another
   * project is selected can never erase the previous project's session.
   */
  const liveSession = useRef<{ projectId: string; sessionId: string } | null>(null);
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
  // New waypoints are dropped at the bottom-left corner of the grid so they are
  // always visible right where the store starts.
  const newWaypointPosition = bottomLeftWaypointPosition(scene?.store, DEFAULT_WAYPOINT_RADIUS_CM);
  const queueMetrics: WaypointMetrics[] = (result?.waypoints ?? []).filter(
    (metrics) => metrics.retentionSeconds > 0,
  );

  const runSimulation = useCallback(async () => {
    if (!projectId || !scene) return;
    setRunning(true);
    try {
      if (liveSessionId) {
        await cadApi.stopLiveSimulation(projectId, liveSessionId).catch(console.error);
      }
      const signature = snapshotSimulationInput(scene, config);
      const live = await cadApi.startLiveSimulation(projectId, scene, config);
      if (isStale(projectId)) {
        // The user switched project while the session was starting: drop it
        // instead of showing another project's agents.
        await cadApi.stopLiveSimulation(projectId, live.sessionId).catch(console.error);
        return;
      }
      setLiveSessionId(live.sessionId);
      setResult(live.result);
      setPaused(live.paused);
      setPlaying(true);
      lastSimulationSignature.current = signature;
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
      setResult(null);
      const correction = extractConstraintCorrection(error);
      const point = correction ? null : extractConstraintPoint(error);
      const invalidWaypointId = correction?.waypointId ?? (point ? pickClosestWaypointId(point, config.waypoints) : null);
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
      console.error('Failed to run simulation:', error);
      alert(correction ? formatConstraintCorrection(correction) : error instanceof Error ? error.message : 'Simulation impossible');
    } finally {
      setRunning(false);
    }
  }, [
    config,
    projectId,
    scene,
    selectWaypoint,
    setInvalidWaypointIds,
    setInvalidWaypointSuggestion,
    setLiveSessionId,
    setPaused,
    setPlaying,
    setResult,
    setRunning,
    liveSessionId,
    isStale,
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
    lastSimulationSignature.current = null;
  }, [liveSessionId, projectId, setAnalytics, setLiveSessionId, setPaused, setPlaying, setResult]);

  const pauseSimulation = useCallback(async () => {
    if (!projectId || !liveSessionId) return;
    const live = await cadApi.pauseLiveSimulation(projectId, liveSessionId);
    if (isStale(projectId)) return;
    setResult(live.result);
    setPaused(true);
  }, [isStale, liveSessionId, projectId, setPaused, setResult]);

  const resumeSimulation = useCallback(async () => {
    if (!projectId || !liveSessionId) return;
    const live = await cadApi.resumeLiveSimulation(projectId, liveSessionId);
    if (isStale(projectId)) return;
    setResult(live.result);
    setPaused(false);
  }, [isStale, liveSessionId, projectId, setPaused, setResult]);

  // The backend session can disappear while the client still holds its id
  // (server restart, idle reaping…). Reset the playback state so the UI shows
  // the launch button again instead of endlessly ticking a dead session.
  const handleLostSession = useCallback(() => {
    setPlaying(false);
    setPaused(false);
    setLiveSessionId(null);
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
    if (tickTimer.current) clearInterval(tickTimer.current);
    tickTimer.current = setInterval(() => {
      // Stop as soon as another project is being loaded, without waiting for
      // React to re-render this panel and clean the effect up.
      if (isStale(projectId)) return;
      if (pendingTick.current) return;
      pendingTick.current = true;
      void cadApi
        .tickLiveSimulation(projectId, liveSessionId)
        .then((live) => {
          if (isStale(projectId)) return;
          setResult(live.result);
          setPaused(live.paused);
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
  }, [handleLostSession, isStale, liveSessionId, loadedProjectId, paused, playing, projectId, setPaused, setResult]);

  // Heatmap and trajectories are only fetched while one of the overlays is on,
  // and at a much lower rate than the agent ticks: their payload is far bigger
  // and they evolve slowly.
  useEffect(() => {
    if (!projectId || loadedProjectId !== projectId) return;
    if (!liveSessionId || !playing) return;
    // The margin heatmap is computed client-side from the assortment: it needs
    // no analytics payload.  The yield heatmap does, since it weights the margin
    // by the measured client density.
    const heatmapNeedsAnalytics = heatmapMode === 'traffic' || heatmapMode === 'yield';
    if ((!showHeatmap || !heatmapNeedsAnalytics) && !showTrajectories) {
      setAnalytics(null);
      return;
    }
    const fetchAnalytics = () => {
      if (isStale(projectId) || pendingAnalytics.current) return;
      pendingAnalytics.current = true;
      void cadApi
        .getLiveSimulationAnalytics(projectId, liveSessionId)
        .then((payload) => {
          if (isStale(projectId)) return;
          setAnalytics(payload.analytics);
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
    showHeatmap,
    heatmapMode,
    showTrajectories,
  ]);

  useEffect(() => {
    if (!projectId || !liveSessionId || !scene || !playing) return;
    const signature = snapshotSimulationInput(scene, config);
    if (lastSimulationSignature.current === null) {
      lastSimulationSignature.current = signature;
      return;
    }
    if (signature === lastSimulationSignature.current) return;
    if (updateTimer.current) clearTimeout(updateTimer.current);
    updateTimer.current = setTimeout(() => {
      void cadApi
        .updateLiveSimulation(projectId, liveSessionId, scene, config)
        .then((live) => {
          if (isStale(projectId)) return;
          setResult(live.result);
          setPaused(live.paused);
          lastSimulationSignature.current = signature;
        })
        .catch((error) => {
          if (isStale(projectId)) return;
          console.error('Failed to hot-update live simulation:', error);
          if (isSessionNotFoundError(error)) handleLostSession();
        });
    }, 200);
    return () => {
      if (updateTimer.current) clearTimeout(updateTimer.current);
    };
  }, [config, handleLostSession, isStale, liveSessionId, playing, projectId, scene, setPaused, setResult]);

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

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-800 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Simulation flux piétons</h3>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <section className="space-y-2 rounded border border-gray-800 bg-gray-950/70 p-3">
          <label className="flex items-center justify-between text-xs text-gray-300">
            <span className="text-gray-500">Activer JuPedSim</span>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => patchConfig({ enabled: event.target.checked })}
              className="accent-blue-500"
            />
          </label>
          <NumberField
            label="Clients / sec"
            value={config.arrivalRatePerSecond}
            min={0}
            step={0.05}
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
            onChange={(value) => patchConfig({ randomSeed: Math.round(value) })}
          />
          <NumberField
            label="Vitesse m/s"
            value={config.desiredSpeedMps}
            min={0.5}
            step={0.05}
            onChange={(value) => patchConfig({ desiredSpeedMps: Math.max(0.5, value) })}
          />
          <NumberField
            label="Variance vitesse"
            value={config.speedVariation}
            min={0}
            step={0.05}
            onChange={(value) => patchConfig({ speedVariation: Math.max(0, value) })}
          />
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
              disabled={running || !config.enabled}
              className={[
                'w-full rounded px-3 py-2 text-xs font-semibold text-white transition-colors',
                running
                  ? 'bg-amber-500 cursor-not-allowed'
                  : config.enabled
                    ? 'bg-blue-600 hover:bg-blue-500 cursor-pointer'
                    : 'bg-blue-600 opacity-50 cursor-not-allowed',
              ].join(' ')}
            >
              {running ? '⏳ Simulation en cours…' : '▶ Lancer la simulation'}
            </button>
          )}
        </section>

        <section className="space-y-2 rounded border border-gray-800 bg-gray-950/70 p-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Points de passage</h4>
            <div className="flex items-center gap-1">
              <button
                onClick={() => addWaypoint('entry', newWaypointPosition)}
                className="rounded bg-gray-800 px-2 py-1 text-xs text-emerald-300 hover:bg-gray-700"
              >
                + Entrée
              </button>
              <button
                onClick={() => addWaypoint('transit', newWaypointPosition)}
                className="rounded bg-gray-800 px-2 py-1 text-xs text-blue-300 hover:bg-gray-700"
              >
                + Transit
              </button>
              <button
                onClick={() => addWaypoint('exit', newWaypointPosition)}
                className="rounded bg-gray-800 px-2 py-1 text-xs text-orange-300 hover:bg-gray-700"
              >
                + Sortie
              </button>
            </div>
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
                />
              ))
            )}
            {config.waypoints.length > 0 && !config.waypoints.some((w) => w.type === 'exit') && (
              <div className="rounded border border-amber-600/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                ⚠ Aucun point de type « Sortie » configuré — la simulation ne peut pas démarrer. Ajoutez un point de type « Sortie (disparition) ».
              </div>
            )}
          </div>
        </section>

        <section className="space-y-2 rounded border border-gray-800 bg-gray-950/70 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Analyse spatiale</h4>
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
          <p className="text-xs text-gray-600">
            Les couches s'affichent dans la vue 3D pendant la simulation.
          </p>
        </section>

        {queueMetrics.length > 0 && (
          <section className="space-y-2 rounded border border-sky-800/40 bg-sky-950/20 p-3 text-xs text-sky-100">
            <h4 className="font-semibold uppercase tracking-wider text-sky-300">Temps d'attente par point</h4>
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
          </section>
        )}

        {selectedSummary && (
          <section className="space-y-2 rounded border border-emerald-800/40 bg-emerald-950/20 p-3 text-xs text-emerald-100">
            <h4 className="font-semibold uppercase tracking-wider text-emerald-300">Résumé</h4>
            <div className="flex justify-between"><span>Entrés</span><span>{selectedSummary.spawnedCustomers}</span></div>
            <div className="flex justify-between"><span>Sortis</span><span>{selectedSummary.completedCustomers}</span></div>
            <div className="flex justify-between"><span>Encore actifs</span><span>{selectedSummary.activeCustomers}</span></div>
            <div className="flex justify-between"><span>Charge moyenne waypoint</span><span>{selectedSummary.averageWaypointLoad.toFixed(2)}</span></div>
            <div className="flex justify-between"><span>Pic waypoint</span><span>{selectedSummary.maxWaypointLoad}</span></div>
            <div className="flex justify-between"><span>Rétention configurée moy. (s)</span><span>{selectedSummary.averageConfiguredRetentionSeconds.toFixed(2)}</span></div>
          </section>
        )}
      </div>
    </div>
  );
}

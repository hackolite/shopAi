import { useCallback, useEffect, useRef } from 'react';
import { cadApi } from '../../api/cad';
import {
  extractConstraintCorrection,
  extractConstraintPoint,
  formatConstraintCorrection,
  hasDistinctConstraintSuggestion,
  pickClosestWaypointId,
} from '../../engine/simulationConstraint';
import { useSceneStore } from '../../store/sceneStore';
import { useSimulationStore } from '../../store/simulationStore';
import type { SimulationConfig, SimulationWaypoint } from '../../types/cad';

interface SimulationPanelProps {
  projectId: string | null;
}

const LIVE_TICK_INTERVAL_MS = 50;

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
  } = useSimulationStore();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingTick = useRef(false);
  const updateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSimulationSignature = useRef<string | null>(null);
  const latestSessionId = useRef<string | null>(null);
  const latestProjectId = useRef<string | null>(null);

  useEffect(() => {
    latestSessionId.current = liveSessionId;
  }, [liveSessionId]);

  useEffect(() => {
    latestProjectId.current = projectId;
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persistSettings(projectId, config), 300);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [config, projectId]);

  const selectedSummary = result?.summary ?? null;

  const runSimulation = useCallback(async () => {
    if (!projectId || !scene) return;
    setRunning(true);
    try {
      if (liveSessionId) {
        await cadApi.stopLiveSimulation(projectId, liveSessionId).catch(console.error);
      }
      const signature = snapshotSimulationInput(scene, config);
      const live = await cadApi.startLiveSimulation(projectId, scene, config);
      setLiveSessionId(live.sessionId);
      setResult(live.result);
      setPaused(live.paused);
      setPlaying(true);
      lastSimulationSignature.current = signature;
    } catch (error) {
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
    pendingTick.current = false;
    if (projectId && liveSessionId) {
      await cadApi.stopLiveSimulation(projectId, liveSessionId).catch(console.error);
    }
    setPlaying(false);
    setPaused(false);
    setLiveSessionId(null);
    setResult(null);
    lastSimulationSignature.current = null;
  }, [liveSessionId, projectId, setLiveSessionId, setPaused, setPlaying, setResult]);

  const pauseSimulation = useCallback(async () => {
    if (!projectId || !liveSessionId) return;
    const live = await cadApi.pauseLiveSimulation(projectId, liveSessionId);
    setResult(live.result);
    setPaused(true);
  }, [liveSessionId, projectId, setPaused, setResult]);

  const resumeSimulation = useCallback(async () => {
    if (!projectId || !liveSessionId) return;
    const live = await cadApi.resumeLiveSimulation(projectId, liveSessionId);
    setResult(live.result);
    setPaused(false);
  }, [liveSessionId, projectId, setPaused, setResult]);

  useEffect(() => {
    if (!projectId || !liveSessionId || !playing || paused) return;
    pendingTick.current = false;
    if (tickTimer.current) clearInterval(tickTimer.current);
    tickTimer.current = setInterval(() => {
      if (pendingTick.current) return;
      pendingTick.current = true;
      void cadApi
        .tickLiveSimulation(projectId, liveSessionId)
        .then((live) => {
          setResult(live.result);
          setPaused(live.paused);
        })
        .catch((error) => {
          console.error('Failed to tick live simulation:', error);
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
  }, [liveSessionId, paused, playing, projectId, setPaused, setResult]);

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
          setResult(live.result);
          setPaused(live.paused);
          lastSimulationSignature.current = signature;
        })
        .catch((error) => {
          console.error('Failed to hot-update live simulation:', error);
        });
    }, 200);
    return () => {
      if (updateTimer.current) clearTimeout(updateTimer.current);
    };
  }, [config, liveSessionId, playing, projectId, scene, setPaused, setResult]);

  useEffect(() => () => {
    if (tickTimer.current) clearInterval(tickTimer.current);
    if (updateTimer.current) clearTimeout(updateTimer.current);
    if (latestProjectId.current && latestSessionId.current) {
      void cadApi.stopLiveSimulation(latestProjectId.current, latestSessionId.current).catch(console.error);
    }
  }, []);

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
                onClick={() => addWaypoint('entry')}
                className="rounded bg-gray-800 px-2 py-1 text-xs text-emerald-300 hover:bg-gray-700"
              >
                + Entrée
              </button>
              <button
                onClick={() => addWaypoint('transit')}
                className="rounded bg-gray-800 px-2 py-1 text-xs text-blue-300 hover:bg-gray-700"
              >
                + Transit
              </button>
              <button
                onClick={() => addWaypoint('exit')}
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

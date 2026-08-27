import { useEffect, useRef } from 'react';
import { cadApi } from '../../api/cad';
import { useSceneStore } from '../../store/sceneStore';
import { useSimulationStore } from '../../store/simulationStore';
import type { SimulationConfig, SimulationWaypoint } from '../../types/cad';

interface SimulationPanelProps {
  projectId: string | null;
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

function WaypointEditor({
  waypoint,
}: {
  waypoint: SimulationWaypoint;
}) {
  const { updateWaypoint, removeWaypoint, selectWaypoint, selectedWaypointId } = useSimulationStore();
  const selected = selectedWaypointId === waypoint.id;

  return (
    <div
      className={[
        'rounded border p-2 space-y-2 transition-colors',
        selected ? 'border-blue-500 bg-blue-950/20' : 'border-gray-800 bg-gray-900/60',
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
      <NumberField label="X (cm)" value={waypoint.x} onChange={(value) => updateWaypoint(waypoint.id, { x: value })} />
      <NumberField label="Z (cm)" value={waypoint.z} onChange={(value) => updateWaypoint(waypoint.id, { z: value })} />
      <NumberField
        label="Rayon"
        value={waypoint.radiusCm}
        min={40}
        step={10}
        onChange={(value) => updateWaypoint(waypoint.id, { radiusCm: value })}
      />
      <label className="flex items-center justify-between text-xs text-gray-300">
        <span className="text-gray-500">Optionnel</span>
        <input
          type="checkbox"
          checked={waypoint.optional}
          onChange={(event) => updateWaypoint(waypoint.id, { optional: event.target.checked })}
          className="accent-blue-500"
        />
      </label>
      {waypoint.optional && (
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
  } = useSimulationStore();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!projectId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persistSettings(projectId, config), 300);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [config, projectId]);

  const selectedSummary = result?.summary ?? null;

  const runSimulation = async () => {
    if (!projectId || !scene) return;
    setRunning(true);
    try {
      const simulation = await cadApi.runSimulation(projectId, scene, config);
      setResult(simulation);
    } catch (error) {
      console.error('Failed to run simulation:', error);
      alert(error instanceof Error ? error.message : 'Simulation impossible');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-800 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Simulation flux clients</h3>
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
            label="Durée (s)"
            value={config.durationSeconds}
            min={10}
            step={10}
            onChange={(value) => patchConfig({ durationSeconds: Math.max(10, Math.round(value)) })}
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
          <NumberField
            label="Service caisse"
            value={config.serviceTimeSeconds}
            min={1}
            step={0.5}
            onChange={(value) => patchConfig({ serviceTimeSeconds: Math.max(1, value) })}
          />
          <NumberField
            label="Jitter caisse"
            value={config.serviceTimeJitterSeconds}
            min={0}
            step={0.5}
            onChange={(value) => patchConfig({ serviceTimeJitterSeconds: Math.max(0, value) })}
          />
          <NumberField
            label="Places queue"
            value={config.queueSlots}
            min={1}
            step={1}
            onChange={(value) => patchConfig({ queueSlots: Math.max(1, Math.round(value)) })}
          />
          <NumberField
            label="Espacement cm"
            value={config.queueSpacingCm}
            min={40}
            step={10}
            onChange={(value) => patchConfig({ queueSpacingCm: Math.max(40, value) })}
          />
          <button
            onClick={() => void runSimulation()}
            disabled={running || !config.enabled}
            className="w-full rounded bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Simulation en cours…' : 'Lancer la simulation'}
          </button>
        </section>

        <section className="space-y-2 rounded border border-gray-800 bg-gray-950/70 p-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Points de passage</h4>
            <button
              onClick={() => addWaypoint()}
              className="rounded bg-gray-800 px-2 py-1 text-xs text-blue-300 hover:bg-gray-700"
            >
              + Ajouter
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Les cônes de vision suivent chaque piéton simulé vers son prochain point de passage.
          </p>
          <div className="space-y-2">
            {config.waypoints.length === 0 ? (
              <div className="rounded border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-600">
                Aucun point de passage.
              </div>
            ) : (
              config.waypoints.map((waypoint) => <WaypointEditor key={waypoint.id} waypoint={waypoint} />)
            )}
          </div>
        </section>

        {selectedSummary && (
          <section className="space-y-2 rounded border border-emerald-800/40 bg-emerald-950/20 p-3 text-xs text-emerald-100">
            <h4 className="font-semibold uppercase tracking-wider text-emerald-300">Résumé</h4>
            <div className="flex justify-between"><span>Entrés</span><span>{selectedSummary.spawnedCustomers}</span></div>
            <div className="flex justify-between"><span>Passés caisse / sortis</span><span>{selectedSummary.completedCustomers}</span></div>
            <div className="flex justify-between"><span>Encore actifs</span><span>{selectedSummary.activeCustomers}</span></div>
            <div className="flex justify-between"><span>Queue moyenne</span><span>{selectedSummary.averageQueueLength.toFixed(2)}</span></div>
            <div className="flex justify-between"><span>Pic de queue</span><span>{selectedSummary.maxQueueLength}</span></div>
          </section>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { cadApi } from '../../api/cad';
import { buildDemoSamples, createDemoSensorDefinitions } from '../../engine/liveSensorDemo';
import { useProjectStore } from '../../store/projectStore';
import { useSensorStore } from '../../store/sensorStore';
import type { SensorSampleInput, SensorSnapshot } from '../../types/cad';

interface SensorPanelProps {
  projectId: string | null;
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-300">
      <span className="w-28 shrink-0 text-gray-500">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="flex-1 min-w-0 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 focus:border-cyan-500 focus:outline-none"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: string[];
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-300">
      <span className="w-28 shrink-0 text-gray-500">{label}</span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="flex-1 min-w-0 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 focus:border-cyan-500 focus:outline-none"
      >
        <option value="">—</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export default function SensorPanel({ projectId }: SensorPanelProps) {
  const {
    settings,
    snapshot,
    socketStatus,
    colorMetric,
    heightMetric,
    sizeMetric,
    selectedSourceIds,
    filterMetric,
    filterMinNormalized,
    filterMaxNormalized,
    opacity,
    cellSizePercent,
    barMaxHeightCm,
    demoRunning,
    showLayer,
    setSettings,
    setSnapshot,
    setSocketStatus,
    setColorMetric,
    setHeightMetric,
    setSizeMetric,
    toggleSource,
    setAllSources,
    setFilterMetric,
    setFilterRange,
    setOpacity,
    setCellSizePercent,
    setBarMaxHeightCm,
    setDemoRunning,
    setShowLayer,
  } = useSensorStore();
  const loadedProjectId = useProjectStore((state) => state.loadedProjectId);
  const [error, setError] = useState<string | null>(null);
  const persistReadyRef = useRef(false);
  const demoTickRef = useRef(0);
  const demoDefinitionsRef = useRef(createDemoSensorDefinitions());

  const metricNames = useMemo(() => snapshot?.metrics.map((metric) => metric.name) ?? [], [snapshot]);

  const clearSamples = async () => {
    if (!projectId) return;
    await cadApi.clearLiveSensorSamples(projectId);
    const emptySnapshot: SensorSnapshot = {
      retentionSeconds: settings.bufferSeconds,
      sampleCount: 0,
      samples: [],
      metrics: [],
      sources: [],
      sourceLabels: {},
      coordinateKinds: [],
    };
    setSnapshot(emptySnapshot);
  };

  useEffect(() => {
    if (!projectId) return;
    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    const connect = () => {
      if (closed) return;
      setSocketStatus('connecting');
      socket = new WebSocket(cadApi.liveSensorWebSocketUrl(projectId));
      socket.onopen = () => {
        if (!closed) setSocketStatus('connected');
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; payload?: unknown };
          if (message.type === 'snapshot' && message.payload) {
            setSnapshot(message.payload as SensorSnapshot);
            setError(null);
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      };
      socket.onerror = () => {
        if (!closed) setSocketStatus('error');
      };
      socket.onclose = () => {
        if (closed) return;
        setSocketStatus('disconnected');
        reconnectTimer = window.setTimeout(connect, 1200);
      };
    };
    cadApi.getLiveSensorSnapshot(projectId)
      .then((nextSnapshot) => {
        if (!closed) {
          setSnapshot(nextSnapshot);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!closed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
      setSocketStatus('disconnected');
    };
  }, [projectId, setSnapshot, setSocketStatus]);

  useEffect(() => {
    if (!projectId) return;
    if (loadedProjectId !== projectId || !persistReadyRef.current) {
      persistReadyRef.current = true;
      return;
    }
    cadApi.updateSettings(projectId, { live: { bufferSeconds: settings.bufferSeconds } }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [loadedProjectId, projectId, settings.bufferSeconds]);

  useEffect(() => {
    if (!demoRunning || !projectId) return;
    let cancelled = false;
    let timer: number | null = null;
    const schedule = (delayMs: number, fn: () => void) => {
      timer = window.setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    };
    const sendSequentially = async (samples: SensorSampleInput[], index: number) => {
      if (cancelled) return;
      if (index >= samples.length) {
        schedule(randomInt(250, 1200), runBurst);
        return;
      }
      try {
        await cadApi.ingestLiveSensorSamples(projectId, [samples[index]]);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setDemoRunning(false);
        }
        return;
      }
      if (cancelled) return;
      schedule(randomInt(60, 220), () => {
        void sendSequentially(samples, index + 1);
      });
    };
    const runBurst = () => {
      if (cancelled) return;
      demoTickRef.current += 1;
      void sendSequentially(buildDemoSamples(demoTickRef.current, demoDefinitionsRef.current), 0);
    };
    runBurst();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [demoRunning, projectId, setDemoRunning]);

  useEffect(() => {
    persistReadyRef.current = loadedProjectId === projectId && projectId !== null;
  }, [loadedProjectId, projectId]);

  const latestTimestamp = snapshot?.latestTimestampMs
    ? new Date(snapshot.latestTimestampMs).toLocaleString('fr-FR')
    : '—';

  return (
    <section aria-label="Données live capteurs" className="flex h-full flex-col text-base">
      <div className="border-b border-gray-700 p-5">
        <h2 className="text-lg font-semibold">Live capteurs</h2>
        <p className="mt-2 text-sm text-gray-300">
         REST pour l’ingestion, WebSocket pour le push, et barres 3D calculées sur la moyenne du tampon live.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-gray-950/70 px-2.5 py-1 text-gray-300">
            Socket: {socketStatus}
          </span>
          <span className="rounded-full bg-gray-950/70 px-2.5 py-1 text-gray-300">
            Échantillons: {snapshot?.sampleCount ?? 0}
          </span>
          <span className="rounded-full bg-gray-950/70 px-2.5 py-1 text-gray-300">
            Dernier flux: {latestTimestamp}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <section className="space-y-3 rounded border border-gray-800 bg-gray-950/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Flux</h4>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const next = !demoRunning;
                  setDemoRunning(next);
                  if (next) {
                    setAllSources(true);
                    setShowLayer(true);
                  }
                }}
                className={`rounded px-2.5 py-1 text-xs font-medium ${demoRunning ? 'bg-amber-700 text-amber-100' : 'bg-cyan-700 text-cyan-100'}`}
              >
                {demoRunning ? 'Stop démo' : 'Mode démo'}
              </button>
              <button
                type="button"
                onClick={() => void clearSamples().catch((cause) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                })}
                className="rounded bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-200 hover:bg-gray-700"
              >
                Vider
              </button>
            </div>
          </div>
          <NumberField
            label="Tampon (s)"
            value={settings.bufferSeconds}
            min={10}
            max={3600}
            step={10}
            onChange={(bufferSeconds) => setSettings({ ...settings, bufferSeconds })}
          />
          <div className="rounded border border-gray-800 bg-gray-900/50 px-2 py-1 text-xs text-gray-300">
            Démo: capteurs typés à coordonnées fixes, envoyés goutte-à-goutte en JSON normalisé 100×100.
          </div>
          <label className="flex items-center justify-between text-xs text-gray-300">
            <span className="text-gray-500">Afficher la couche 3D</span>
            <input
              type="checkbox"
              checked={showLayer}
              onChange={(event) => setShowLayer(event.target.checked)}
              className="accent-cyan-500"
            />
          </label>
        </section>

        <section className="space-y-3 rounded border border-gray-800 bg-gray-950/70 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Rendu</h4>
          <div className="rounded border border-gray-800 bg-gray-900/50 px-2 py-1 text-xs text-gray-300">
            Mode fixe: barres 3D par cellule, hauteur/couleur issues des moyennes du tampon courant.
          </div>
          <SelectField label="Couleur" value={colorMetric} options={metricNames} onChange={setColorMetric} />
          <SelectField label="Hauteur" value={heightMetric} options={metricNames} onChange={setHeightMetric} />
          <SelectField label="Taille" value={sizeMetric} options={metricNames} onChange={setSizeMetric} />
          <NumberField label="Opacité" value={opacity} min={0.1} max={1} step={0.05} onChange={setOpacity} />
          <NumberField label="Largeur bar %" value={cellSizePercent} min={2} max={50} step={1} onChange={setCellSizePercent} />
          <NumberField label="Bar max cm" value={barMaxHeightCm} min={50} max={1500} step={25} onChange={setBarMaxHeightCm} />
        </section>

        <section className="space-y-3 rounded border border-gray-800 bg-gray-950/70 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Filtres</h4>
          <SelectField label="Métrique" value={filterMetric} options={metricNames} onChange={setFilterMetric} />
          <NumberField
            label="Min %"
            value={Math.round(filterMinNormalized * 100)}
            min={0}
            max={100}
            step={1}
            onChange={(value) => setFilterRange(Math.max(0, Math.min(1, value / 100)), filterMaxNormalized)}
          />
          <NumberField
            label="Max %"
            value={Math.round(filterMaxNormalized * 100)}
            min={0}
            max={100}
            step={1}
            onChange={(value) => setFilterRange(filterMinNormalized, Math.max(0, Math.min(1, value / 100)))}
          />
        </section>

        <section className="space-y-3 rounded border border-gray-800 bg-gray-950/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Capteurs</h4>
            <div className="flex gap-2">
              <button type="button" className="text-xs text-cyan-300 hover:text-cyan-200" onClick={() => setAllSources(true)}>Tous</button>
              <button type="button" className="text-xs text-gray-400 hover:text-gray-200" onClick={() => setAllSources(false)}>Aucun</button>
            </div>
          </div>
          <div className="max-h-40 space-y-2 overflow-y-auto">
            {(snapshot?.sources ?? []).map((sourceId) => (
              <label key={sourceId} className="flex items-center justify-between gap-2 rounded border border-gray-800 bg-gray-900/60 px-2 py-1 text-xs text-gray-200">
                <span className="truncate">{snapshot?.sourceLabels[sourceId] || sourceId}</span>
                <input
                  type="checkbox"
                  checked={selectedSourceIds.includes(sourceId)}
                  onChange={() => toggleSource(sourceId)}
                  className="accent-cyan-500"
                />
              </label>
            ))}
            {!(snapshot?.sources.length) && <p className="text-xs text-gray-500">Aucun capteur reçu.</p>}
          </div>
        </section>

        <section className="space-y-2 rounded border border-gray-800 bg-gray-950/70 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Métriques</h4>
          <div className="space-y-2">
            {(snapshot?.metrics ?? []).map((metric) => (
              <div key={metric.name} className="rounded border border-gray-800 bg-gray-900/60 px-2 py-1 text-xs text-gray-200">
                <div className="flex items-center justify-between gap-2">
                  <span>{metric.name}</span>
                  <span className="text-gray-500">{metric.count} pts</span>
                </div>
                <div className="mt-1 text-[11px] text-gray-400">
                  min {metric.min.toFixed(2)} · max {metric.max.toFixed(2)}{metric.unit ? ` · ${metric.unit}` : ''}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2 rounded border border-gray-800 bg-gray-950/70 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Live reçu</h4>
          <div className="max-h-44 space-y-2 overflow-y-auto">
            {(snapshot?.samples ?? [])
              .slice()
              .sort((left, right) => (right.timestampMs ?? 0) - (left.timestampMs ?? 0))
              .slice(0, 16)
              .map((sample) => (
                <div key={sample.id} className="rounded border border-gray-800 bg-gray-900/60 px-2 py-1 text-[11px] text-gray-200">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{sample.sourceLabel || sample.sourceId}</span>
                    <span className="text-gray-500">
                      {sample.timestampMs ? new Date(sample.timestampMs).toLocaleString('fr-FR') : '—'}
                    </span>
                  </div>
                  <div className="text-gray-400">
                    {sample.coordinate.kind === 'normalized'
                      ? `100×100: ${sample.coordinate.x?.toFixed(2) ?? '—'}, ${sample.coordinate.y?.toFixed(2) ?? '—'}`
                      : `GPS: ${sample.coordinate.lat?.toFixed(6) ?? '—'}, ${sample.coordinate.lon?.toFixed(6) ?? '—'}`}
                  </div>
                  <ul className="mt-1 space-y-0.5 text-gray-400">
                    {sample.data.map((metric) => (
                      <li key={`${sample.id}-${metric.name}`}>
                        {metric.name}: {metric.value.toFixed(2)}{metric.unit ? ` ${metric.unit}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            {!(snapshot?.samples.length) && <p className="text-xs text-gray-500">Aucune réception live.</p>}
          </div>
        </section>

        {error && (
          <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}
      </div>
    </section>
  );
}

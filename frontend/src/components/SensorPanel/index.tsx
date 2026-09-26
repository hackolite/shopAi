import { useEffect, useMemo, useRef, useState } from 'react';
import { cadApi } from '../../api/cad';
import { buildDemoSamples, createDemoSensorDefinitions } from '../../engine/liveSensorDemo';
import {
  aggregateSensorSectors,
  filterSensorSamples,
  isSensorSampleRecent,
  metricStatsByName,
  normalizeMetricValue,
  projectSensorSampleToGridPercent,
  sensorColor,
} from '../../engine/liveSensors';
import { useProjectStore } from '../../store/projectStore';
import { useSensorStore, type SensorColorRampName } from '../../store/sensorStore';
import type { SensorSnapshot } from '../../types/cad';

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

const COLOR_RAMP_OPTIONS = [
  { value: 'yellow-red', label: 'Jaune → rouge' },
  { value: 'blue-red', label: 'Bleu → rouge' },
  { value: 'green-red', label: 'Vert → rouge' },
  { value: 'cyan-blue', label: 'Cyan → bleu' },
] as const;

function isSensorColorRampName(value: string | null): value is SensorColorRampName {
  return COLOR_RAMP_OPTIONS.some((option) => option.value === value);
}

export default function SensorPanel({ projectId }: SensorPanelProps) {
  const {
    settings,
    snapshot,
    socketStatus,
    colorMetric,
    heightMetric,
    selectedSourceIds,
    filterMetric,
    filterMinNormalized,
    filterMaxNormalized,
    opacity,
    cellSizePercent,
    barMaxHeightCm,
    mapGridResolution,
    colorRamp,
    demoRunning,
    showLayer,
    setSettings,
    setSnapshot,
    setSocketStatus,
    setColorMetric,
    setHeightMetric,
    toggleSource,
    setAllSources,
    setFilterMetric,
    setFilterRange,
    setOpacity,
    setCellSizePercent,
    setBarMaxHeightCm,
    setMapGridResolution,
    setColorRamp,
    setDemoRunning,
    setShowLayer,
  } = useSensorStore();
  const loadedProjectId = useProjectStore((state) => state.loadedProjectId);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const persistReadyRef = useRef(false);
  const demoTickRef = useRef(0);
  const demoDefinitions = useMemo(() => createDemoSensorDefinitions(), []);

  const metricNames = useMemo(() => snapshot?.metrics.map((metric) => metric.name) ?? [], [snapshot]);
  const statsByName = useMemo(() => metricStatsByName(snapshot), [snapshot]);
  const filteredSamples = useMemo(
    () => filterSensorSamples(snapshot, selectedSourceIds, {
      metricName: filterMetric,
      minNormalized: filterMinNormalized,
      maxNormalized: filterMaxNormalized,
    }),
    [filterMaxNormalized, filterMetric, filterMinNormalized, selectedSourceIds, snapshot],
  );
  const mapSectors = useMemo(
    () => aggregateSensorSectors(filteredSamples, snapshot, mapGridResolution, colorMetric, heightMetric),
    [colorMetric, filteredSamples, heightMetric, mapGridResolution, snapshot],
  );
  const recentWindowMs = Math.max(1200, settings.updateIntervalSeconds * 1000 * 0.9);
  const mappedSamples = useMemo(
    () => filteredSamples.map((sample) => ({
      sample,
      point: projectSensorSampleToGridPercent(sample, snapshot),
      recent: isSensorSampleRecent(sample, nowMs, recentWindowMs),
    })),
    [filteredSamples, nowMs, recentWindowMs, snapshot],
  );
  const arrivalAgeMs = snapshot?.latestTimestampMs ? Math.max(0, nowMs - snapshot.latestTimestampMs) : null;
  const arrivalStatus = arrivalAgeMs == null
    ? 'idle'
    : arrivalAgeMs <= settings.updateIntervalSeconds * 1500
      ? 'ok'
      : 'late';

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
    if (!demoRunning && !(snapshot?.sampleCount ?? 0) && !snapshot?.latestTimestampMs) return undefined;
    const timer = window.setInterval(
      () => setNowMs(Date.now()),
      Math.max(250, Math.min(1000, settings.updateIntervalSeconds * 500)),
    );
    return () => window.clearInterval(timer);
  }, [demoRunning, settings.updateIntervalSeconds, snapshot?.latestTimestampMs, snapshot?.sampleCount]);

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
    cadApi.updateSettings(projectId, {
      live: {
        bufferSeconds: settings.bufferSeconds,
        updateIntervalSeconds: settings.updateIntervalSeconds,
      },
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [loadedProjectId, projectId, settings.bufferSeconds, settings.updateIntervalSeconds]);

  useEffect(() => {
    if (!demoRunning || !projectId) return;
    let cancelled = false;
    let timer: number | null = null;
    const runBurst = async () => {
      if (cancelled) return;
      demoTickRef.current += 1;
      const samples = buildDemoSamples(demoTickRef.current, demoDefinitions).map((sample, index) => ({
        ...sample,
        timestampMs: Date.now() + index * 25,
      }));
      try {
        await cadApi.ingestLiveSensorSamples(projectId, samples);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setDemoRunning(false);
        }
        return;
      }
      if (cancelled) return;
      timer = window.setTimeout(() => {
        void runBurst();
      }, Math.max(500, settings.updateIntervalSeconds * 1000));
    };
    void runBurst();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [demoDefinitions, demoRunning, projectId, setDemoRunning, settings.updateIntervalSeconds]);

  useEffect(() => {
    persistReadyRef.current = loadedProjectId === projectId && projectId !== null;
  }, [loadedProjectId, projectId]);

  const latestTimestamp = snapshot?.latestTimestampMs
    ? new Date(snapshot.latestTimestampMs).toLocaleString('fr-FR')
    : '—';
  const latestArrivalDelta = arrivalAgeMs == null ? '—' : `${(arrivalAgeMs / 1000).toFixed(1)}s`;

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
          <span className={`rounded-full px-2.5 py-1 ${arrivalStatus === 'ok' ? 'bg-emerald-950/70 text-emerald-200' : arrivalStatus === 'late' ? 'bg-amber-950/70 text-amber-200' : 'bg-gray-950/70 text-gray-300'}`}>
            Cadence: {latestArrivalDelta} / cible {settings.updateIntervalSeconds.toFixed(1)}s
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
          <NumberField
            label="Update ~ (s)"
            value={settings.updateIntervalSeconds}
            min={0.5}
            max={60}
            step={0.5}
            onChange={(updateIntervalSeconds) => setSettings({ ...settings, updateIntervalSeconds })}
          />
          <div className="rounded border border-gray-800 bg-gray-900/50 px-2 py-1 text-xs text-gray-300">
            Démo: envoi batché via REST puis push WebSocket environ toutes les {settings.updateIntervalSeconds.toFixed(1)}s.
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
          <SelectField
            label="Gamme"
            value={colorRamp}
            options={[...COLOR_RAMP_OPTIONS.map((option) => option.value)]}
            onChange={(value) => setColorRamp(isSensorColorRampName(value) ? value : 'yellow-red')}
          />
          <div className="flex items-center justify-between gap-2 rounded border border-gray-800 bg-gray-900/60 px-2 py-1 text-[11px] text-gray-300">
            <span>Palette active</span>
            <span>{COLOR_RAMP_OPTIONS.find((option) => option.value === colorRamp)?.label ?? colorRamp}</span>
          </div>
          <NumberField label="Opacité" value={opacity} min={0.1} max={1} step={0.05} onChange={setOpacity} />
          <NumberField label="Largeur bar %" value={cellSizePercent} min={2} max={50} step={1} onChange={setCellSizePercent} />
          <NumberField label="Bar max cm" value={barMaxHeightCm} min={50} max={1500} step={25} onChange={setBarMaxHeightCm} />
        </section>

        <section className="space-y-3 rounded border border-gray-800 bg-gray-950/70 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Vue 2D live</h4>
          <NumberField
            label="Grille"
            value={mapGridResolution}
            min={5}
            max={100}
            step={1}
            onChange={setMapGridResolution}
          />
          <div className="rounded border border-gray-800 bg-gray-900/50 px-2 py-1 text-xs text-gray-300">
            Secteurs {mapGridResolution} × {mapGridResolution} · moyenne par secteur · clignotement à l’arrivée des données.
          </div>
          <div className="rounded border border-gray-800 bg-gray-900/60 p-2">
            <svg viewBox="0 0 100 100" className="block aspect-square w-full overflow-hidden rounded bg-gray-950">
              <rect x="0" y="0" width="100" height="100" fill="#050816" />
              {Array.from({ length: mapGridResolution - 1 }, (_, index) => {
                const offset = ((index + 1) / mapGridResolution) * 100;
                return (
                  <g key={`grid-${offset}`}>
                    <line x1={offset} y1="0" x2={offset} y2="100" stroke="#1f2937" strokeWidth="0.18" />
                    <line x1="0" y1={offset} x2="100" y2={offset} stroke="#1f2937" strokeWidth="0.18" />
                  </g>
                );
              })}
              {mapSectors.map((sector) => {
                const sectorSize = 100 / mapGridResolution;
                const normalizedColor = normalizeMetricValue(sector.colorValue, statsByName.get(colorMetric ?? ''));
                const normalizedHeight = normalizeMetricValue(sector.heightValue, statsByName.get(heightMetric ?? ''));
                const barHeight = Math.max(0, normalizedHeight * sectorSize * 0.85);
                const sectorFill = sector.colorValue == null ? '#1f2937' : sensorColor(normalizedColor, colorRamp);
                const sectorFillOpacity = sector.colorValue == null ? 0.18 : 0.2 + normalizedColor * 0.75;
                return (
                  <g key={sector.key}>
                    <rect
                      x={sector.col * sectorSize}
                      y={sector.row * sectorSize}
                      width={sectorSize}
                      height={sectorSize}
                      fill={sectorFill}
                      fillOpacity={sectorFillOpacity}
                      stroke="#0f172a"
                      strokeWidth="0.18"
                    />
                    <rect
                      x={sector.col * sectorSize + sectorSize * 0.32}
                      y={sector.row * sectorSize + sectorSize * 0.92 - barHeight}
                      width={Math.max(0.6, sectorSize * 0.36)}
                      height={barHeight}
                      rx={0.3}
                      fill="rgba(255,255,255,0.92)"
                    />
                    {sectorSize >= 8 && (
                      <text
                        x={sector.centerX}
                        y={sector.centerY}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={Math.max(2, sectorSize * 0.22)}
                        fill="#f8fafc"
                      >
                        {sector.count}
                      </text>
                    )}
                  </g>
                );
              })}
              {mappedSamples.map(({ sample, point, recent }) => (
                <g key={`sensor-${sample.id}`}>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={0.7}
                    fill="#e2e8f0"
                    opacity={recent ? 0.98 : 0.8}
                  />
                  {recent && (
                    <>
                      <circle cx={point.x} cy={point.y} r={1.6} fill="none" stroke="#fef08a" strokeWidth="0.6" opacity={0.85}>
                        <animate attributeName="r" values="1.4;3.8;1.4" dur="0.9s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.9;0.15;0.9" dur="0.9s" repeatCount="indefinite" />
                      </circle>
                      <circle cx={point.x} cy={point.y} r={1.2} fill="#fef08a" opacity={0.95}>
                        <animate attributeName="opacity" values="0.95;0.35;0.95" dur="0.55s" repeatCount="indefinite" />
                      </circle>
                    </>
                  )}
                </g>
              ))}
            </svg>
          </div>
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
                  <div className="text-[10px] text-amber-300">
                    {sample.timestampMs && nowMs - sample.timestampMs >= 0 && nowMs - sample.timestampMs <= recentWindowMs
                      ? 'Arrivée récente'
                      : 'Tampon'}
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

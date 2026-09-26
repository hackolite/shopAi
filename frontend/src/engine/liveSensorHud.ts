interface BuildSensorHudLinesOptions {
  selectedBuildingName: string | null;
  showLayer: boolean;
  selectedSourceLabels: string[];
  colorMetric: string | null;
  heightMetric: string | null;
}

/**
 * Sensor source names are intentionally never rendered here: they add noise to the
 * top-left HUD without helping the viewer, so only the active metrics are shown.
 */
export function buildSensorHudLines({
  selectedBuildingName,
  showLayer,
  selectedSourceLabels,
  colorMetric,
  heightMetric,
}: BuildSensorHudLinesOptions): string[] {
  if (selectedBuildingName) return [selectedBuildingName];
  if (!showLayer || selectedSourceLabels.length === 0) return [];
  return [
    'Live BAR',
    `Couleur: ${colorMetric ?? '—'}`,
    `Hauteur: ${heightMetric ?? '—'}`,
  ];
}

export function sensorSocketReconnectDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, attempt);
  return Math.min(5_000, 1_200 * (safeAttempt + 1));
}

export function sensorSocketConnectTimeoutMs(updateIntervalSeconds: number): number {
  const safeInterval = Number.isFinite(updateIntervalSeconds) ? Math.max(1, updateIntervalSeconds) : 2;
  return Math.max(4_000, safeInterval * 3_000);
}

export function sensorSnapshotPollIntervalMs(updateIntervalSeconds: number): number {
  const safeInterval = Number.isFinite(updateIntervalSeconds) ? Math.max(1, updateIntervalSeconds) : 2;
  return Math.max(1_500, safeInterval * 1_000);
}

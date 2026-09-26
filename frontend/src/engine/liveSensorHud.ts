interface BuildSensorHudLinesOptions {
  selectedBuildingName: string | null;
  showLayer: boolean;
  selectedSourceLabels: string[];
  colorMetric: string | null;
  heightMetric: string | null;
}

export function buildSensorHudLines({
  selectedBuildingName,
  showLayer,
  selectedSourceLabels,
  colorMetric,
  heightMetric,
}: BuildSensorHudLinesOptions): string[] {
  if (selectedBuildingName) return [selectedBuildingName];
  if (!showLayer || selectedSourceLabels.length === 0) return [];
  const visibleLabels = selectedSourceLabels.slice(0, 4);
  const extra = selectedSourceLabels.length > 4 ? ` +${selectedSourceLabels.length - 4}` : '';
  return [
    'Live BAR',
    `Capteurs: ${visibleLabels.join(',')}${extra}`,
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

import type {
  SensorMetricStats,
  SensorSampleRecord,
  SensorSnapshot,
  StoreConfig,
} from '../types/cad';
import type { SensorColorRampName } from '../store/sensorStore';

export interface ProjectedSensorPoint {
  xCm: number;
  zCm: number;
}

export interface SensorMetricFilter {
  metricName: string | null;
  minNormalized: number;
  maxNormalized: number;
}

/** Manual min/max bounds a user can set for one metric, used only to normalize
 * the *color* of sensor bars/sectors so the color scale stays stable over time
 * instead of drifting with the live buffer's min/max. Bar/sector *height* never
 * uses these bounds: it always keeps normalizing against the live min/max. */
export interface SensorMetricBounds {
  min: number;
  max: number;
}

export interface NormalizeMetricValueOptions {
  /** Overrides `stats.min`/`stats.max` when provided (used for color bounding). */
  bounds?: SensorMetricBounds | null;
  /** When false, the normalized ratio is only clamped at 0 (no floor of the value
   * below the range) and is allowed to exceed 1 above the range, so a bar/sector
   * can grow past its configured max size instead of being capped. Defaults to
   * true (clamp to [0, 1]), which is required for color ramps. */
  clampUpper?: boolean;
}

export interface AggregatedSensorSector {
  key: string;
  col: number;
  row: number;
  centerX: number;
  centerY: number;
  count: number;
  colorValue: number | null;
  heightValue: number | null;
}

export interface AggregatedSensorCell {
  key: string;
  xCm: number;
  zCm: number;
  count: number;
  colorValue: number | null;
  heightValue: number | null;
}

export interface ProgressiveSensorRevealState {
  visibleIds: string[];
  pendingIds: string[];
}

const SENSOR_COLOR_RAMPS: Record<SensorColorRampName, Array<{ offset: number; color: [number, number, number] }>> = {
  'yellow-red': [
    { offset: 0, color: [250, 204, 21] },
    { offset: 1, color: [220, 38, 38] },
  ],
  'blue-red': [
    { offset: 0, color: [59, 130, 246] },
    { offset: 1, color: [220, 38, 38] },
  ],
  'green-red': [
    { offset: 0, color: [34, 197, 94] },
    { offset: 1, color: [220, 38, 38] },
  ],
  'cyan-blue': [
    { offset: 0, color: [34, 211, 238] },
    { offset: 1, color: [37, 99, 235] },
  ],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function metricStatsByName(snapshot: SensorSnapshot | null): Map<string, SensorMetricStats> {
  return new Map((snapshot?.metrics ?? []).map((metric) => [metric.name, metric]));
}

export function buildMetricStats(samples: SensorSampleRecord[]): SensorMetricStats[] {
  const metrics = new Map<string, SensorMetricStats>();
  for (const sample of samples) {
    for (const metric of sample.data) {
      const current = metrics.get(metric.name);
      if (!current) {
        metrics.set(metric.name, {
          name: metric.name,
          min: metric.value,
          max: metric.value,
          unit: metric.unit ?? null,
          count: 1,
        });
        continue;
      }
      current.min = Math.min(current.min, metric.value);
      current.max = Math.max(current.max, metric.value);
      current.count += 1;
      if (!current.unit && metric.unit) current.unit = metric.unit;
    }
  }
  return [...metrics.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function getMetricValue(sample: SensorSampleRecord, metricName: string | null): number | null {
  if (!metricName) return null;
  const metric = sample.data.find((item) => item.name === metricName);
  return metric ? metric.value : null;
}

export function normalizeMetricValue(
  value: number | null,
  stats: SensorMetricStats | undefined,
  options?: NormalizeMetricValueOptions,
): number {
  const bounds = options?.bounds ?? stats;
  if (value == null || !bounds) return 0;
  const span = bounds.max - bounds.min;
  if (!Number.isFinite(span) || span <= 0) return 1;
  const ratio = (value - bounds.min) / span;
  const clampUpper = options?.clampUpper ?? true;
  return clampUpper ? Math.max(0, Math.min(1, ratio)) : Math.max(0, ratio);
}

export function sensorColor(value: number, ramp: SensorColorRampName): string {
  const normalized = clamp(value, 0, 1);
  const stops = SENSOR_COLOR_RAMPS[ramp] ?? SENSOR_COLOR_RAMPS['yellow-red'];
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const current = stops[index];
    if (normalized <= current.offset) {
      const span = current.offset - previous.offset;
      const local = span <= 0 ? 0 : (normalized - previous.offset) / span;
      const color = previous.color.map((channel, channelIndex) => Math.round(
        channel + (current.color[channelIndex] - channel) * local,
      ));
      return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
    }
  }
  const tail = stops[stops.length - 1].color;
  return `rgb(${tail[0]}, ${tail[1]}, ${tail[2]})`;
}

export function projectSensorSample(
  sample: SensorSampleRecord,
  store: StoreConfig,
  snapshot: SensorSnapshot | null,
): ProjectedSensorPoint {
  if (sample.coordinate.kind === 'normalized') {
    return {
      xCm: ((sample.coordinate.x ?? 0) / 100) * store.dimensions.width,
      zCm: ((sample.coordinate.y ?? 0) / 100) * store.dimensions.depth,
    };
  }
  const bounds = snapshot?.gpsBounds;
  const minLon = bounds?.minLon ?? sample.coordinate.lon ?? 0;
  const maxLon = bounds?.maxLon ?? sample.coordinate.lon ?? 1;
  const minLat = bounds?.minLat ?? sample.coordinate.lat ?? 0;
  const maxLat = bounds?.maxLat ?? sample.coordinate.lat ?? 1;
  const lonSpan = Math.max(1e-9, maxLon - minLon);
  const latSpan = Math.max(1e-9, maxLat - minLat);
  const xRatio = ((sample.coordinate.lon ?? minLon) - minLon) / lonSpan;
  const zRatio = 1 - (((sample.coordinate.lat ?? minLat) - minLat) / latSpan);
  return {
    xCm: xRatio * store.dimensions.width,
    zCm: zRatio * store.dimensions.depth,
  };
}

export function projectSensorSampleToGridPercent(
  sample: SensorSampleRecord,
  snapshot: SensorSnapshot | null,
): { x: number; y: number } {
  if (sample.coordinate.kind === 'normalized') {
    return {
      x: clamp(sample.coordinate.x ?? 0, 0, 100),
      y: clamp(sample.coordinate.y ?? 0, 0, 100),
    };
  }
  const bounds = snapshot?.gpsBounds;
  const minLon = bounds?.minLon ?? sample.coordinate.lon ?? 0;
  const maxLon = bounds?.maxLon ?? sample.coordinate.lon ?? 1;
  const minLat = bounds?.minLat ?? sample.coordinate.lat ?? 0;
  const maxLat = bounds?.maxLat ?? sample.coordinate.lat ?? 1;
  const lonSpan = Math.max(1e-9, maxLon - minLon);
  const latSpan = Math.max(1e-9, maxLat - minLat);
  return {
    x: clamp((((sample.coordinate.lon ?? minLon) - minLon) / lonSpan) * 100, 0, 100),
    y: clamp((1 - (((sample.coordinate.lat ?? minLat) - minLat) / latSpan)) * 100, 0, 100),
  };
}

export function filterSensorSamples(
  snapshot: SensorSnapshot | null,
  selectedSourceIds: string[],
  filter: SensorMetricFilter,
  /**
   * Snapshot whose min/max define the normalization range for the metric filter.
   * Defaults to `snapshot`, but callers that only pass a restricted subset of
   * samples (e.g. a progressive-reveal subset) must pass the full, unrestricted
   * snapshot here so the min/max always come from every sample of that metric
   * across the whole map, not just the currently visible/revealed subset.
   */
  statsSnapshot: SensorSnapshot | null = snapshot,
): SensorSampleRecord[] {
  if (!snapshot) return [];
  if (selectedSourceIds.length === 0) return [];
  const allowedSources = new Set(selectedSourceIds);
  const stats = metricStatsByName(statsSnapshot).get(filter.metricName ?? '');
  return snapshot.samples.filter((sample) => {
    if (!allowedSources.has(sample.sourceId)) return false;
    if (!filter.metricName) return true;
    const normalized = normalizeMetricValue(getMetricValue(sample, filter.metricName), stats);
    return normalized >= filter.minNormalized && normalized <= filter.maxNormalized;
  });
}

export function aggregateSensorSectors(
  samples: SensorSampleRecord[],
  snapshot: SensorSnapshot | null,
  gridResolution: number,
  colorMetric: string | null,
  heightMetric: string | null,
): AggregatedSensorSector[] {
  const resolvedGridResolution = Math.max(1, Math.min(100, Math.round(gridResolution)));
  const sectorSpan = 100 / resolvedGridResolution;
  const buckets = new Map<string, AggregatedSensorSector & {
    colorSum: number;
    colorCount: number;
    heightSum: number;
    heightCount: number;
  }>();

  for (const sample of samples) {
    const point = projectSensorSampleToGridPercent(sample, snapshot);
    const col = Math.min(resolvedGridResolution - 1, Math.max(0, Math.floor(point.x / sectorSpan)));
    const row = Math.min(resolvedGridResolution - 1, Math.max(0, Math.floor(point.y / sectorSpan)));
    const key = `${col}:${row}`;
    const existing = buckets.get(key) ?? {
      key,
      col,
      row,
      centerX: (col + 0.5) * sectorSpan,
      centerY: (row + 0.5) * sectorSpan,
      count: 0,
      colorValue: null,
      heightValue: null,
      colorSum: 0,
      colorCount: 0,
      heightSum: 0,
      heightCount: 0,
    };
    existing.count += 1;
    const colorValue = getMetricValue(sample, colorMetric);
    const heightValue = getMetricValue(sample, heightMetric);
    if (colorValue != null) {
      existing.colorSum += colorValue;
      existing.colorCount += 1;
    }
    if (heightValue != null) {
      existing.heightSum += heightValue;
      existing.heightCount += 1;
    }
    existing.colorValue = existing.colorCount ? existing.colorSum / existing.colorCount : null;
    existing.heightValue = existing.heightCount ? existing.heightSum / existing.heightCount : null;
    buckets.set(key, existing);
  }

  return [...buckets.values()]
    .sort((left, right) => (left.row - right.row) || (left.col - right.col))
    .map(({ key, col, row, centerX, centerY, count, colorValue, heightValue }) => ({
      key,
      col,
      row,
      centerX,
      centerY,
      count,
      colorValue,
      heightValue,
    }));
}

/**
 * Merges freshly aggregated sensor sectors into a residual baseline so that a sector
 * which already received data keeps displaying its last known average instead of
 * disappearing when the live buffer momentarily has no sample for it. Sectors that
 * never received any data are never added: "if it has no data, nothing is shown".
 */
export function mergeResidualSensorSectors(
  previous: AggregatedSensorSector[],
  next: AggregatedSensorSector[],
): AggregatedSensorSector[] {
  const merged = new Map<string, AggregatedSensorSector>();
  for (const sector of previous) {
    merged.set(sector.key, sector);
  }
  for (const sector of next) {
    const existing = merged.get(sector.key);
    merged.set(sector.key, {
      ...sector,
      colorValue: sector.colorValue ?? existing?.colorValue ?? null,
      heightValue: sector.heightValue ?? existing?.heightValue ?? null,
      count: sector.count || existing?.count || 0,
    });
  }
  return [...merged.values()].sort((left, right) => (left.row - right.row) || (left.col - right.col));
}

export function getSensorCellSizeCm(store: StoreConfig, cellSizePercent: number): number {
  const minSpan = Math.min(store.dimensions.width, store.dimensions.depth);
  return (clamp(cellSizePercent, 1, 100) / 100) * minSpan;
}

export function aggregateSensorCells(
  samples: SensorSampleRecord[],
  store: StoreConfig,
  snapshot: SensorSnapshot | null,
  cellSizePercent: number,
  colorMetric: string | null,
  heightMetric: string | null,
): AggregatedSensorCell[] {
  const cellSizeCm = Math.max(1e-6, getSensorCellSizeCm(store, cellSizePercent));
  const buckets = new Map<string, AggregatedSensorCell & {
    colorSum: number;
    colorCount: number;
    heightSum: number;
    heightCount: number;
  }>();

  for (const sample of samples) {
    const point = projectSensorSample(sample, store, snapshot);
    const col = Math.max(0, Math.floor(point.xCm / cellSizeCm));
    const row = Math.max(0, Math.floor(point.zCm / cellSizeCm));
    const key = `${col}:${row}`;
    const existing = buckets.get(key) ?? {
      key,
      xCm: (col + 0.5) * cellSizeCm,
      zCm: (row + 0.5) * cellSizeCm,
      count: 0,
      colorValue: null,
      heightValue: null,
      colorSum: 0,
      colorCount: 0,
      heightSum: 0,
      heightCount: 0,
    };
    existing.count += 1;
    const colorValue = getMetricValue(sample, colorMetric);
    const heightValue = getMetricValue(sample, heightMetric);
    if (colorValue != null) {
      existing.colorSum += colorValue;
      existing.colorCount += 1;
    }
    if (heightValue != null) {
      existing.heightSum += heightValue;
      existing.heightCount += 1;
    }
    existing.colorValue = existing.colorCount ? existing.colorSum / existing.colorCount : null;
    existing.heightValue = existing.heightCount ? existing.heightSum / existing.heightCount : null;
    buckets.set(key, existing);
  }

  return [...buckets.values()]
    .sort((left, right) => (left.zCm - right.zCm) || (left.xCm - right.xCm))
    .map(({ key, xCm, zCm, count, colorValue, heightValue }) => ({
      key,
      xCm,
      zCm,
      count,
      colorValue,
      heightValue,
    }));
}

export function sensorSectorFootprintCm(
  sector: Pick<AggregatedSensorSector, 'centerX' | 'centerY'>,
  gridResolution: number,
  store: StoreConfig,
): { xCm: number; zCm: number; widthCm: number; depthCm: number } {
  const resolvedGridResolution = Math.max(1, Math.min(300, Math.round(gridResolution)));
  return {
    xCm: (sector.centerX / 100) * store.dimensions.width,
    zCm: (sector.centerY / 100) * store.dimensions.depth,
    widthCm: store.dimensions.width / resolvedGridResolution,
    depthCm: store.dimensions.depth / resolvedGridResolution,
  };
}

export function reconcileProgressiveSensorReveal(
  previousVisibleIds: string[],
  previousPendingIds: string[],
  samples: SensorSampleRecord[],
): ProgressiveSensorRevealState {
  const sampleIds = samples.map((sample) => sample.id);
  const sampleIdSet = new Set(sampleIds);
  const visibleIds = previousVisibleIds.filter((id) => sampleIdSet.has(id));
  const visibleIdSet = new Set(visibleIds);
  const pendingIds = previousPendingIds.filter((id) => sampleIdSet.has(id) && !visibleIdSet.has(id));
  const queuedIds = new Set([...visibleIds, ...pendingIds]);
  for (const sampleId of sampleIds) {
    if (!queuedIds.has(sampleId)) {
      pendingIds.push(sampleId);
    }
  }
  return { visibleIds, pendingIds };
}

export function sensorRevealBatchSize(pendingCount: number): number {
  if (pendingCount >= 120) return 6;
  if (pendingCount >= 60) return 4;
  if (pendingCount >= 24) return 2;
  return 1;
}

export function isSensorSampleRecent(sample: SensorSampleRecord, nowMs: number, windowMs: number): boolean {
  if (sample.timestampMs == null) return false;
  const ageMs = nowMs - sample.timestampMs;
  return ageMs >= 0 && ageMs <= windowMs;
}

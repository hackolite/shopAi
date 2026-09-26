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

export interface AggregatedSensorCell {
  key: string;
  xCm: number;
  zCm: number;
  count: number;
  colorValue: number | null;
  heightValue: number | null;
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

export function normalizeMetricValue(value: number | null, stats: SensorMetricStats | undefined): number {
  if (value == null || !stats) return 0;
  const span = stats.max - stats.min;
  if (!Number.isFinite(span) || span <= 0) return 1;
  return Math.max(0, Math.min(1, (value - stats.min) / span));
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
): SensorSampleRecord[] {
  if (!snapshot) return [];
  if (selectedSourceIds.length === 0) return [];
  const allowedSources = new Set(selectedSourceIds);
  const stats = metricStatsByName(snapshot).get(filter.metricName ?? '');
  return snapshot.samples.filter((sample) => {
    if (!allowedSources.has(sample.sourceId)) return false;
    if (!filter.metricName) return true;
    const normalized = normalizeMetricValue(getMetricValue(sample, filter.metricName), stats);
    return normalized >= filter.minNormalized && normalized <= filter.maxNormalized;
  });
}

export function aggregateSensorCells(
  samples: SensorSampleRecord[],
  store: StoreConfig,
  snapshot: SensorSnapshot | null,
  cellSizePercent: number,
  colorMetric: string | null,
  heightMetric: string | null,
): AggregatedSensorCell[] {
  const cellSizeCm = getSensorCellSizeCm(store, cellSizePercent);
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
      xCm: col * cellSizeCm + cellSizeCm / 2,
      zCm: row * cellSizeCm + cellSizeCm / 2,
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
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key, xCm, zCm, count, colorValue, heightValue }) => ({
      key,
      xCm,
      zCm,
      count,
      colorValue,
      heightValue,
    }));
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
    .sort((left, right) => left.key.localeCompare(right.key))
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

export function getSensorCellSizeCm(store: StoreConfig, cellSizePercent: number): number {
  const minSideCm = Math.max(100, Math.min(store.dimensions.width, store.dimensions.depth));
  return Math.max(50, (cellSizePercent / 100) * minSideCm);
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
  return nowMs - sample.timestampMs <= windowMs;
}

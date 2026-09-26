import type {
  SensorMetricStats,
  SensorSampleRecord,
  SensorSnapshot,
  StoreConfig,
} from '../types/cad';

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
  sizeValue: number | null;
}

export interface ProgressiveSensorRevealState {
  visibleIds: string[];
  pendingIds: string[];
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
  sizeMetric: string | null,
): AggregatedSensorCell[] {
  const minSideCm = Math.max(100, Math.min(store.dimensions.width, store.dimensions.depth));
  const cellSizeCm = Math.max(50, (cellSizePercent / 100) * minSideCm);
  const buckets = new Map<string, AggregatedSensorCell & {
    colorSum: number;
    colorCount: number;
    heightSum: number;
    heightCount: number;
    sizeSum: number;
    sizeCount: number;
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
      sizeValue: null,
      colorSum: 0,
      colorCount: 0,
      heightSum: 0,
      heightCount: 0,
      sizeSum: 0,
      sizeCount: 0,
    };
    existing.count += 1;
    const colorValue = getMetricValue(sample, colorMetric);
    const heightValue = getMetricValue(sample, heightMetric);
    const sizeValue = getMetricValue(sample, sizeMetric);
    if (colorValue != null) {
      existing.colorSum += colorValue;
      existing.colorCount += 1;
    }
    if (heightValue != null) {
      existing.heightSum += heightValue;
      existing.heightCount += 1;
    }
    if (sizeValue != null) {
      existing.sizeSum += sizeValue;
      existing.sizeCount += 1;
    }
    existing.colorValue = existing.colorCount ? existing.colorSum / existing.colorCount : null;
    existing.heightValue = existing.heightCount ? existing.heightSum / existing.heightCount : null;
    existing.sizeValue = existing.sizeCount ? existing.sizeSum / existing.sizeCount : null;
    buckets.set(key, existing);
  }

  return [...buckets.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key, xCm, zCm, count, colorValue, heightValue, sizeValue }) => ({
      key,
      xCm,
      zCm,
      count,
      colorValue,
      heightValue,
      sizeValue,
    }));
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

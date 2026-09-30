import type { FloorZone, FloorZonePoint, SimulationAgentFrame } from '../types/cad';
import { zoneOutlinePointsCm } from './floorZones';

const CM2_PER_M2 = 10_000;

/**
 * Ray-casting point-in-polygon test on a closed outline in store coordinates (cm).
 */
export function pointInPolygonCm(xCm: number, zCm: number, outline: FloorZonePoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = outline.length - 1; index < outline.length; previous = index, index += 1) {
    const a = outline[index];
    const b = outline[previous];
    const intersects = (a.z > zCm) !== (b.z > zCm)
      && xCm < ((b.x - a.x) * (zCm - a.z)) / (b.z - a.z) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

interface OutlineBoundsCm {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function outlineBoundsCm(outline: FloorZonePoint[]): OutlineBoundsCm {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of outline) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  return { minX, maxX, minZ, maxZ };
}

interface ZoneGeometryCm {
  outline: FloorZonePoint[];
  bounds: OutlineBoundsCm;
  areaM2: number;
}

/**
 * Zone objects are immutable in the store (every edit creates a new object),
 * so the outline/bounds/area can be cached per object and reused by every
 * sample instead of being rebuilt for every zone twice a second.
 */
const zoneGeometryCache = new WeakMap<FloorZone, ZoneGeometryCm>();

function zoneGeometryCm(zone: FloorZone): ZoneGeometryCm {
  const cached = zoneGeometryCache.get(zone);
  if (cached) return cached;
  const outline = zoneOutlinePointsCm(zone);
  const geometry = { outline, bounds: outlineBoundsCm(outline), areaM2: zoneAreaM2(zone) };
  zoneGeometryCache.set(zone, geometry);
  return geometry;
}

/** Shoelace polygon area (m²) for a zone's floor outline. */
export function zoneAreaM2(zone: FloorZone): number {
  const outline = zoneOutlinePointsCm(zone);
  if (outline.length < 3) return 0;
  const areaCm2 = Math.abs(outline.reduce((sum, point, index) => {
    const next = outline[(index + 1) % outline.length];
    return sum + point.x * next.z - next.x * point.z;
  }, 0)) / 2;
  return areaCm2 / CM2_PER_M2;
}

export interface ZoneOccupancyMetrics {
  zoneId: string;
  areaM2: number;
  occupantCount: number;
  /** People per square metre currently inside the zone. */
  densityPerM2: number;
  /** People entering the zone per second, averaged since the previous sample. */
  flowPerSecond: number;
  averageDensityPerM2: number;
  averageFlowPerSecond: number;
}

export type ZoneMetricKind = 'density' | 'flow';

export interface ZoneMetricAccumulator {
  elapsedSeconds: number;
  densityPersonSeconds: number;
  flowPeople: number;
}

export function averageZoneOccupancyMetrics(
  metrics: ReadonlyMap<string, ZoneOccupancyMetrics>,
  accumulators: ReadonlyMap<string, ZoneMetricAccumulator>,
  dtSeconds: number,
): { metrics: Map<string, ZoneOccupancyMetrics>; accumulators: Map<string, ZoneMetricAccumulator> } {
  const averagedMetrics = new Map<string, ZoneOccupancyMetrics>();
  const nextAccumulators = new Map<string, ZoneMetricAccumulator>();
  const dt = Math.max(0, dtSeconds);

  metrics.forEach((metric, zoneId) => {
    const previous = accumulators.get(zoneId) ?? {
      elapsedSeconds: 0,
      densityPersonSeconds: 0,
      flowPeople: 0,
    };
    const elapsedSeconds = previous.elapsedSeconds + dt;
    const densityPersonSeconds = previous.densityPersonSeconds + metric.densityPerM2 * dt;
    const flowPeople = previous.flowPeople + metric.flowPerSecond * dt;
    nextAccumulators.set(zoneId, { elapsedSeconds, densityPersonSeconds, flowPeople });
    averagedMetrics.set(zoneId, {
      ...metric,
      averageDensityPerM2: elapsedSeconds > 0 ? densityPersonSeconds / elapsedSeconds : metric.densityPerM2,
      averageFlowPerSecond: elapsedSeconds > 0 ? flowPeople / elapsedSeconds : metric.flowPerSecond,
    });
  });

  return { metrics: averagedMetrics, accumulators: nextAccumulators };
}

export interface PinnedZoneMetric {
  zoneId: string;
  kind: ZoneMetricKind;
}

export function zoneMetricDisplay(
  kind: ZoneMetricKind,
  zoneLabel: string,
  metrics: ZoneOccupancyMetrics | undefined,
): { label: string; value: string } {
  const format = (value: number) => (
    Number.isFinite(value) ? value.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : '—'
  );
  return kind === 'density'
    ? { label: `${zoneLabel} · Densité moyenne`, value: `${format(metrics?.averageDensityPerM2 ?? 0)} pers/m²` }
    : { label: `${zoneLabel} · Flux moyen`, value: `${format(metrics?.averageFlowPerSecond ?? 0)} pers/s` };
}

/**
 * Computes, for each given zone, how many agents currently sit inside its
 * floor outline, the resulting density (people/m²) and the flow of new
 * entrants (people/s) since the previous sample.
 *
 * Stateful across calls: pass back the returned `occupantIds` map on the next
 * call (alongside the elapsed time) so the flow rate can be derived from the
 * agents that just entered the zone.
 *
 * @param zones            Zones to measure (only zones with an area > 0 count).
 * @param agents           Current agent frame (store coordinates, cm).
 * @param previousOccupants Occupant id sets per zone from the previous sample.
 * @param dtSeconds        Elapsed time since the previous sample, in seconds.
 * @param previousMetrics  Metrics returned by the previous call: a zone whose
 *                         values did not change keeps the very same object, so
 *                         reference-equality consumers (store selectors) skip
 *                         re-rendering it.
 */
export function computeZoneOccupancyMetrics(
  zones: FloorZone[],
  agents: SimulationAgentFrame[],
  previousOccupants: Map<string, Set<number>>,
  dtSeconds: number,
  previousMetrics?: ReadonlyMap<string, ZoneOccupancyMetrics>,
): { metrics: Map<string, ZoneOccupancyMetrics>; occupants: Map<string, Set<number>> } {
  const metrics = new Map<string, ZoneOccupancyMetrics>();
  const occupants = new Map<string, Set<number>>();
  const safeDt = dtSeconds > 0 ? dtSeconds : 0;

  for (const zone of zones) {
    const { outline, bounds, areaM2 } = zoneGeometryCm(zone);
    const currentOccupants = new Set<number>();
    if (outline.length >= 3) {
      // Cheap bounding-box pre-check before the O(vertices) ray-casting test:
      // most agents sit far outside any given zone, so this skips the
      // per-vertex loop entirely for the vast majority of agent/zone pairs.
      for (const agent of agents) {
        if (
          agent.xCm < bounds.minX || agent.xCm > bounds.maxX
          || agent.zCm < bounds.minZ || agent.zCm > bounds.maxZ
        ) {
          continue;
        }
        if (pointInPolygonCm(agent.xCm, agent.zCm, outline)) {
          currentOccupants.add(agent.id);
        }
      }
    }
    const previous = previousOccupants.get(zone.id);
    let newEntrants = 0;
    for (const id of currentOccupants) {
      if (!previous || !previous.has(id)) newEntrants += 1;
    }
    const flowPerSecond = safeDt > 0 ? newEntrants / safeDt : 0;
    const densityPerM2 = areaM2 > 0 ? currentOccupants.size / areaM2 : 0;
    const previousMetric = previousMetrics?.get(zone.id);
    const unchanged = previousMetric !== undefined
      && previousMetric.areaM2 === areaM2
      && previousMetric.occupantCount === currentOccupants.size
      && previousMetric.densityPerM2 === densityPerM2
      && previousMetric.flowPerSecond === flowPerSecond;
    metrics.set(zone.id, unchanged ? previousMetric : {
      zoneId: zone.id,
      areaM2,
      occupantCount: currentOccupants.size,
      densityPerM2,
      flowPerSecond,
      averageDensityPerM2: densityPerM2,
      averageFlowPerSecond: flowPerSecond,
    });
    occupants.set(zone.id, currentOccupants);
  }

  return { metrics, occupants };
}

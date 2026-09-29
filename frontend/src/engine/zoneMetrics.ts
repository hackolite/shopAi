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
 */
export function computeZoneOccupancyMetrics(
  zones: FloorZone[],
  agents: SimulationAgentFrame[],
  previousOccupants: Map<string, Set<number>>,
  dtSeconds: number,
): { metrics: Map<string, ZoneOccupancyMetrics>; occupants: Map<string, Set<number>> } {
  const metrics = new Map<string, ZoneOccupancyMetrics>();
  const occupants = new Map<string, Set<number>>();
  const safeDt = dtSeconds > 0 ? dtSeconds : 0;

  for (const zone of zones) {
    const areaM2 = zoneAreaM2(zone);
    const outline = zoneOutlinePointsCm(zone);
    const currentOccupants = new Set<number>();
    if (outline.length >= 3) {
      for (const agent of agents) {
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
    metrics.set(zone.id, {
      zoneId: zone.id,
      areaM2,
      occupantCount: currentOccupants.size,
      densityPerM2: areaM2 > 0 ? currentOccupants.size / areaM2 : 0,
      flowPerSecond,
    });
    occupants.set(zone.id, currentOccupants);
  }

  return { metrics, occupants };
}

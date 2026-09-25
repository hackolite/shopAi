import type { FloorZone, FloorZonePoint, ZonePathMode } from '../types/cad';

export function zoneShape(zone: Pick<FloorZone, 'shape'>): NonNullable<FloorZone['shape']> {
  return zone.shape ?? 'rectangle';
}

export function zoneRotationDeg(zone: Pick<FloorZone, 'rotationDeg'>): number {
  return zone.rotationDeg ?? 0;
}

export function zonePathMode(zone: Pick<FloorZone, 'pathMode'>): ZonePathMode {
  return zone.pathMode ?? 'linear';
}

export function zoneMounted(zone: Pick<FloorZone, 'mounted'>): boolean {
  return zone.mounted === true;
}

export function zoneSupportsSimulationPreview(
  zone: Pick<FloorZone, 'type' | 'mounted'>,
): boolean {
  return zone.type === 'forbidden' && !zoneMounted(zone);
}

export function zoneIsMergeableBuilding(
  zone: Pick<FloorZone, 'type' | 'pedestrianObstacle' | 'source'>,
): boolean {
  const source = zone.source;
  return zone.type === 'forbidden'
    && zone.pedestrianObstacle !== false
    && source?.isEnvelope !== true
    && Boolean(source?.osmWayId)
    && Boolean(source?.isLikelyBuilding);
}

export function sceneHasOsmSimulationProfile(
  scene: { store?: { zones?: Pick<FloorZone, 'source'>[] } | null } | null | undefined,
): boolean {
  return Boolean(
    scene?.store?.zones?.some((zone) => Boolean(zone.source?.osmWayId)),
  );
}

export function zoneHeightCm(zone: Pick<FloorZone, 'heightCm'>): number {
  return Math.max(0, zone.heightCm ?? 120);
}

export function zoneCenterCm(zone: Pick<FloorZone, 'x' | 'z' | 'width' | 'depth'>) {
  return {
    x: zone.x + zone.width / 2,
    z: zone.z + zone.depth / 2,
  };
}

/**
 * Maps a floor point (store X/Z coordinates) into the local 2D plane used by
 * Three.js ShapeGeometry before the mesh is rotated flat onto the floor.
 *
 * The floor mesh is rotated by -90° around X, so the shape plane's +Y axis
 * must point toward store -Z for the rendered fill to line up with world-space
 * outlines and rotate in the same direction.
 */
export function floorShapePlanePointCm(
  point: FloorZonePoint,
  center: FloorZonePoint = { x: 0, z: 0 },
): [number, number] {
  return [point.x - center.x, center.z - point.z];
}

interface StoreBoundsCm {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface StoreBoundsOptions {
  storeWidth?: number;
  storeDepth?: number;
  storeX?: number;
  storeZ?: number;
}

function storeBoundsCm(options?: StoreBoundsOptions): StoreBoundsCm | null {
  if (options?.storeWidth == null || options.storeDepth == null) return null;
  const minX = options.storeX ?? 0;
  const minZ = options.storeZ ?? 0;
  return {
    minX,
    maxX: minX + options.storeWidth,
    minZ,
    maxZ: minZ + options.storeDepth,
  };
}

function clampPointToStore(point: FloorZonePoint, bounds: StoreBoundsCm | null): FloorZonePoint {
  if (!bounds) return { x: point.x, z: point.z };
  return {
    x: Math.max(bounds.minX, Math.min(bounds.maxX, point.x)),
    z: Math.max(bounds.minZ, Math.min(bounds.maxZ, point.z)),
  };
}

function pushDistinctPoint(target: FloorZonePoint[], point: FloorZonePoint) {
  const previous = target[target.length - 1];
  if (previous && Math.abs(previous.x - point.x) < 1e-6 && Math.abs(previous.z - point.z) < 1e-6) return;
  target.push(point);
}

function rotatePoint(point: FloorZonePoint, center: FloorZonePoint, angleDeg: number): FloorZonePoint {
  if (Math.abs(angleDeg) < 1e-6) return point;
  const angle = (angleDeg * Math.PI) / 180;
  const dx = point.x - center.x;
  const dz = point.z - center.z;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: center.x + dx * cos - dz * sin,
    z: center.z + dx * sin + dz * cos,
  };
}

function catmullRomPoint(
  p0: FloorZonePoint,
  p1: FloorZonePoint,
  p2: FloorZonePoint,
  p3: FloorZonePoint,
  t: number,
): FloorZonePoint {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (
      (2 * p1.x)
      + (-p0.x + p2.x) * t
      + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
      + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
    ),
    z: 0.5 * (
      (2 * p1.z)
      + (-p0.z + p2.z) * t
      + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2
      + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3
    ),
  };
}

function smoothClosedPoints(
  points: FloorZonePoint[],
  samplesPerSegment = 10,
  bounds: StoreBoundsCm | null = null,
): FloorZonePoint[] {
  if (points.length < 3) return points.map((point) => ({ x: point.x, z: point.z }));
  const sampled: FloorZonePoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const p0 = points[(index - 1 + points.length) % points.length];
    const p1 = points[index];
    const p2 = points[(index + 1) % points.length];
    const p3 = points[(index + 2) % points.length];
    pushDistinctPoint(sampled, clampPointToStore(p1, bounds));
    if (p1.corner || p2.corner) continue;
    for (let step = 1; step < samplesPerSegment; step += 1) {
      pushDistinctPoint(sampled, clampPointToStore(catmullRomPoint(p0, p1, p2, p3, step / samplesPerSegment), bounds));
    }
  }
  return sampled;
}

export function floorZoneValidationError(
  points: FloorZonePoint[],
  options?: {
    storeWidth?: number;
    storeDepth?: number;
    storeX?: number;
    storeZ?: number;
    pathMode?: ZonePathMode;
  },
): string | null {
  if (points.length < 3) return 'Ajoutez au moins 3 points pour fermer la zone.';
  const bounds = storeBoundsCm(options);
  const outline = (options?.pathMode ?? 'linear') === 'smooth'
    ? smoothClosedPoints(points, 10, bounds)
    : points.map((point) => ({ x: point.x, z: point.z }));
  if (outline.length < 3) return 'La zone doit contenir au moins 3 points distincts.';
  if (bounds) {
    const outOfBounds = outline.some((point) =>
      point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ,
    );
    if (outOfBounds) return 'La zone doit rester à l’intérieur du magasin.';
  }
  const intersects = (a1: FloorZonePoint, a2: FloorZonePoint, b1: FloorZonePoint, b2: FloorZonePoint) => {
    const orientation = (p: FloorZonePoint, q: FloorZonePoint, r: FloorZonePoint) => {
      const value = (q.z - p.z) * (r.x - q.x) - (q.x - p.x) * (r.z - q.z);
      if (Math.abs(value) < 1e-6) return 0;
      return value > 0 ? 1 : 2;
    };
    const o1 = orientation(a1, a2, b1);
    const o2 = orientation(a1, a2, b2);
    const o3 = orientation(b1, b2, a1);
    const o4 = orientation(b1, b2, a2);
    return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
  };
  for (let index = 0; index < outline.length; index += 1) {
    const a1 = outline[index];
    const a2 = outline[(index + 1) % outline.length];
    for (let otherIndex = index + 1; otherIndex < outline.length; otherIndex += 1) {
      const nextOther = (otherIndex + 1) % outline.length;
      if (
        index === otherIndex
        || (index + 1) % outline.length === otherIndex
        || index === nextOther
      ) {
        continue;
      }
      const b1 = outline[otherIndex];
      const b2 = outline[nextOther];
      if (intersects(a1, a2, b1, b2)) {
        return 'La zone se croise sur elle-même. Corrigez le tracé avant validation.';
      }
    }
  }
  const area = Math.abs(outline.reduce((sum, point, index) => {
    const next = outline[(index + 1) % outline.length];
    return sum + point.x * next.z - next.x * point.z;
  }, 0)) / 2;
  if (area < 10_000) return 'La zone est trop petite. Dessinez une surface plus grande.';
  return null;
}

export function zoneOutlinePointsCm(zone: FloorZone, options?: StoreBoundsOptions): FloorZonePoint[] {
  const shape = zoneShape(zone);
  const center = zoneCenterCm(zone);
  const bounds = storeBoundsCm(options);
  const basePoints: FloorZonePoint[] =
    shape === 'circle'
      ? Array.from({ length: 48 }, (_, index) => {
          const angle = (Math.PI * 2 * index) / 48;
          return {
            x: center.x + Math.cos(angle) * zone.width / 2,
            z: center.z + Math.sin(angle) * zone.depth / 2,
          };
        })
      : shape === 'diamond'
        ? [
            { x: center.x, z: zone.z },
            { x: zone.x + zone.width, z: center.z },
            { x: center.x, z: zone.z + zone.depth },
            { x: zone.x, z: center.z },
          ]
        : shape === 'polygon' && zone.points && zone.points.length >= 3
          ? (
            zonePathMode(zone) === 'smooth'
              ? smoothClosedPoints(zone.points, 10, bounds)
              : zone.points.map((point) => ({ x: point.x, z: point.z }))
          )
          : [
              { x: zone.x, z: zone.z },
              { x: zone.x + zone.width, z: zone.z },
              { x: zone.x + zone.width, z: zone.z + zone.depth },
              { x: zone.x, z: zone.z + zone.depth },
            ];
  return basePoints.map((point) => rotatePoint(point, center, zoneRotationDeg(zone)));
}

export function zoneSupportsResizeHandles(zone: FloorZone): boolean {
  return zoneShape(zone) !== 'polygon' && Math.abs(zoneRotationDeg(zone)) < 1e-6;
}

import type { FloorZone, FloorZonePoint } from '../types/cad';

export function zoneShape(zone: Pick<FloorZone, 'shape'>): NonNullable<FloorZone['shape']> {
  return zone.shape ?? 'rectangle';
}

export function zoneRotationDeg(zone: Pick<FloorZone, 'rotationDeg'>): number {
  return zone.rotationDeg ?? 0;
}

export function zoneCenterCm(zone: Pick<FloorZone, 'x' | 'z' | 'width' | 'depth'>) {
  return {
    x: zone.x + zone.width / 2,
    z: zone.z + zone.depth / 2,
  };
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

export function zoneOutlinePointsCm(zone: FloorZone): FloorZonePoint[] {
  const shape = zoneShape(zone);
  const center = zoneCenterCm(zone);
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
          ? zone.points.map((point) => ({ x: point.x, z: point.z }))
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

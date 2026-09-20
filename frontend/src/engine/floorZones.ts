import type { FloorZone } from '../types/cad';

export function zoneShape(zone: Pick<FloorZone, 'shape'>): NonNullable<FloorZone['shape']> {
  return zone.shape ?? 'rectangle';
}

export function zoneSupportsResizeHandles(zone: FloorZone): boolean {
  return zoneShape(zone) !== 'polygon';
}

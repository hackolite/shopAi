import { describe, expect, it } from 'vitest';
import { zoneShape, zoneSupportsResizeHandles } from './floorZones';
import type { FloorZone } from '../types/cad';

function zone(partial: Partial<FloorZone>): FloorZone {
  return {
    id: 'zone',
    type: 'forbidden',
    label: 'Zone',
    x: 0,
    z: 0,
    width: 100,
    depth: 100,
    ...partial,
  };
}

describe('floorZones helpers', () => {
  it('defaults missing shapes to rectangle', () => {
    expect(zoneShape(zone({}))).toBe('rectangle');
  });

  it('keeps resize handles for bounded shapes but not free polygons', () => {
    expect(zoneSupportsResizeHandles(zone({ shape: 'rectangle' }))).toBe(true);
    expect(zoneSupportsResizeHandles(zone({ shape: 'circle' }))).toBe(true);
    expect(zoneSupportsResizeHandles(zone({ shape: 'diamond' }))).toBe(true);
    expect(zoneSupportsResizeHandles(zone({
      shape: 'polygon',
      points: [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 0, z: 100 }],
    }))).toBe(false);
  });
});

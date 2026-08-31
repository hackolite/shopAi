import { describe, expect, it } from 'vitest';
import { bottomLeftFurniturePosition, bottomLeftWaypointPosition } from './placement';
import type { StoreConfig } from '../types/cad';

const store: StoreConfig = {
  id: 'store-1',
  name: 'Store',
  position: [0, 0, 0],
  dimensions: { width: 3000, depth: 2000, height: 300 },
  floorColor: '#000',
  wallColor: '#111',
};

describe('bottomLeftFurniturePosition', () => {
  it('places new furniture near the bottom-left corner of the grid', () => {
    expect(bottomLeftFurniturePosition(store, { width: 120, depth: 60 })).toEqual([100, 0, 100]);
  });

  it('follows the store origin when the store is not at (0, 0)', () => {
    const shifted = { ...store, position: [-500, 0, 250] as [number, number, number] };
    expect(bottomLeftFurniturePosition(shifted, { width: 120, depth: 60 })).toEqual([-400, 0, 350]);
  });

  it('keeps oversized furniture inside the store', () => {
    expect(bottomLeftFurniturePosition(store, { width: 4000, depth: 1950 })).toEqual([0, 0, 50]);
  });

  it('falls back to the origin when the scene is unknown', () => {
    expect(bottomLeftFurniturePosition(null, { width: 100, depth: 100 })).toEqual([0, 0, 0]);
  });
});

describe('bottomLeftWaypointPosition', () => {
  it('offsets the waypoint centre by its radius so its disc fits in the store', () => {
    expect(bottomLeftWaypointPosition(store, 120)).toEqual({ x: 160, z: 160 });
  });

  it('never goes below the default margin for small radii', () => {
    expect(bottomLeftWaypointPosition(store, 10)).toEqual({ x: 100, z: 100 });
  });

  it('follows the store origin', () => {
    const shifted = { ...store, position: [1000, 0, -200] as [number, number, number] };
    expect(bottomLeftWaypointPosition(shifted, 120)).toEqual({ x: 1160, z: -40 });
  });
});

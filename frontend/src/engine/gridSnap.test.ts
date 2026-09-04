import { describe, it, expect } from 'vitest';
import {
  GRID_CELL_CM,
  snapToCell,
  snapSizeToCell,
  footprintHalfSpanCm,
  snapFurniturePositionCm,
  snapFurnitureCentreCm,
  gridPlaneSpec,
} from './gridSnap';

describe('snapToCell', () => {
  it('snaps to the nearest cell of the lattice anchored on the origin', () => {
    expect(snapToCell(120)).toBe(100);
    expect(snapToCell(130)).toBe(150);
    expect(snapToCell(130, 20)).toBe(120);
    expect(snapToCell(-130)).toBe(-150);
  });

  it('is idempotent', () => {
    const once = snapToCell(133.7, 25);
    expect(snapToCell(once, 25)).toBe(once);
  });
});

describe('snapSizeToCell', () => {
  it('snaps dimensions to whole cells and honours the minimum', () => {
    expect(snapSizeToCell(120, 20)).toBe(100);
    expect(snapSizeToCell(10, 20)).toBe(GRID_CELL_CM);
    expect(snapSizeToCell(0, 20)).toBe(GRID_CELL_CM);
  });
});

describe('footprintHalfSpanCm', () => {
  it('swaps width and depth for a quarter turn', () => {
    expect(footprintHalfSpanCm(0, 200, 100)).toEqual({ x: 100, z: 50 });
    expect(footprintHalfSpanCm(90, 200, 100)).toEqual({ x: 50, z: 100 });
    expect(footprintHalfSpanCm(180, 200, 100)).toEqual({ x: 100, z: 50 });
    expect(footprintHalfSpanCm(-90, 200, 100)).toEqual({ x: 50, z: 100 });
  });
});

describe('snapFurniturePositionCm', () => {
  const dims = { width: 150, depth: 100 };

  it('puts the footprint corner on a cell border (no rotation)', () => {
    const snapped = snapFurniturePositionCm([137, 0, -12], dims, 0);
    expect(snapped[0]).toBe(150);
    expect(snapped[2]).toBe(0);
  });

  it('keeps the Y coordinate untouched', () => {
    expect(snapFurniturePositionCm([137, 42, -12], dims, 0)[1]).toBe(42);
  });

  it('puts the rotated footprint corner on a cell border', () => {
    const snapped = snapFurniturePositionCm([137, 0, -12], dims, 90);
    // Footprint spans depth along X and width along Z once rotated.
    const centreX = snapped[0] + dims.width / 2;
    const centreZ = snapped[2] + dims.depth / 2;
    expect(Math.abs((centreX - dims.depth / 2) % GRID_CELL_CM)).toBe(0);
    expect(Math.abs((centreZ - dims.width / 2) % GRID_CELL_CM)).toBe(0);
  });

  it('anchors the lattice on the store origin', () => {
    const origin = { x: 25, z: -75 };
    const snapped = snapFurniturePositionCm([137, 0, -12], dims, 0, origin);
    expect(snapped[0]).toBe(125);
    expect(snapped[2]).toBe(-25);
  });

  it('is idempotent', () => {
    const once = snapFurniturePositionCm([137, 0, -12], dims, 90, { x: 25, z: -75 });
    const twice = snapFurniturePositionCm(once, dims, 90, { x: 25, z: -75 });
    expect(twice).toEqual(once);
  });
});

describe('snapFurnitureCentreCm', () => {
  it('matches the position-based snap', () => {
    const dims = { width: 150, depth: 100 };
    const position: [number, number, number] = [137, 0, -12];
    const centre = snapFurnitureCentreCm(
      position[0] + dims.width / 2,
      position[2] + dims.depth / 2,
      dims,
      90,
    );
    const snapped = snapFurniturePositionCm(position, dims, 90);
    expect(centre.x).toBeCloseTo(snapped[0] + dims.width / 2, 6);
    expect(centre.z).toBeCloseTo(snapped[2] + dims.depth / 2, 6);
  });
});

describe('gridPlaneSpec', () => {
  it('keeps the plane untouched when its centre is already on the lattice', () => {
    expect(gridPlaneSpec(0, 1800)).toEqual({ sizeCm: 1800, centreCm: 900 });
  });

  it('re-centres on the lattice and pads so the floor stays covered', () => {
    const { sizeCm, centreCm } = gridPlaneSpec(0, 1750);
    expect(Math.abs((centreCm - 0) % GRID_CELL_CM)).toBe(0);
    expect(centreCm - sizeCm / 2).toBeLessThanOrEqual(0);
    expect(centreCm + sizeCm / 2).toBeGreaterThanOrEqual(1750);
    expect(sizeCm - 1750).toBeLessThanOrEqual(GRID_CELL_CM);
  });

  it('anchors on a non-zero origin', () => {
    const origin = -325;
    const { sizeCm, centreCm } = gridPlaneSpec(origin, 1750);
    expect(Math.abs((centreCm - origin) % GRID_CELL_CM)).toBe(0);
    expect(centreCm - sizeCm / 2).toBeLessThanOrEqual(origin);
    expect(centreCm + sizeCm / 2).toBeGreaterThanOrEqual(origin + 1750);
  });
});

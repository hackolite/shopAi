import { describe, expect, it } from 'vitest';
import type { FurnitureInstance } from '../types/cad';
import {
  MAGNET_THRESHOLD_CM,
  furnitureFootprintCm,
  magnetiseFurnitureCentreCm,
  magnetiseFurniturePositionCm,
} from './furnitureMagnet';

function makeFurniture(
  id: string,
  position: [number, number, number],
  width = 120,
  depth = 60,
  rotationY = 0,
): FurnitureInstance {
  return {
    id,
    type: 'gondola',
    name: id,
    position,
    rotation: [0, rotationY, 0],
    dimensions: { width, depth, height: 180 },
  } as FurnitureInstance;
}

describe('furnitureFootprintCm', () => {
  it('returns the axis-aligned footprint, rotation-aware', () => {
    const flat = furnitureFootprintCm(makeFurniture('a', [0, 0, 0]));
    expect(flat).toEqual({ minX: 0, maxX: 120, minZ: 0, maxZ: 60 });
    const rotated = furnitureFootprintCm(makeFurniture('a', [0, 0, 0], 120, 60, 90));
    expect(rotated.maxX - rotated.minX).toBeCloseTo(60);
    expect(rotated.maxZ - rotated.minZ).toBeCloseTo(120);
  });
});

describe('magnetiseFurnitureCentreCm', () => {
  const neighbour = makeFurniture('b', [0, 0, 0]); // footprint x:[0,120] z:[0,60]

  it('moves freely with total precision when nothing is nearby', () => {
    const dragged = makeFurniture('a', [500, 0, 500]);
    const centre = magnetiseFurnitureCentreCm(563.37, 512.91, dragged, [neighbour]);
    expect(centre).toEqual({ x: 563.37, z: 512.91 });
  });

  it('sticks flush against a neighbour face (collage, no overlap)', () => {
    const dragged = makeFurniture('a', [0, 0, 0]);
    // Approaching the right side of the neighbour: dragged minX ≈ 127 → 120.
    const centre = magnetiseFurnitureCentreCm(127 + 60, 30, dragged, [neighbour]);
    expect(centre.x).toBeCloseTo(120 + 60);
    // Both footprints touch exactly, they do not overlap.
    expect(centre.x - 60).toBeCloseTo(120);
  });

  it('pushes out a slightly overlapping drag so the faces just touch', () => {
    const dragged = makeFurniture('a', [0, 0, 0]);
    const centre = magnetiseFurnitureCentreCm(115 + 60, 30, dragged, [neighbour]);
    expect(centre.x).toBeCloseTo(120 + 60);
  });

  it('aligns the perpendicular edges when sticking (corner-to-corner)', () => {
    const dragged = makeFurniture('a', [0, 0, 0]);
    // Face collage on X plus a ~5 cm Z misalignment → Z aligns to the edge.
    const centre = magnetiseFurnitureCentreCm(126 + 60, 35, dragged, [neighbour]);
    expect(centre.x).toBeCloseTo(180);
    expect(centre.z).toBeCloseTo(30);
  });

  it('does not magnetise beyond the threshold', () => {
    const dragged = makeFurniture('a', [0, 0, 0]);
    const rawX = 120 + MAGNET_THRESHOLD_CM + 5 + 60;
    const centre = magnetiseFurnitureCentreCm(rawX, 30, dragged, [neighbour]);
    expect(centre.x).toBeCloseTo(rawX);
  });

  it('ignores the dragged furniture itself', () => {
    const dragged = makeFurniture('a', [0, 0, 0]);
    const centre = magnetiseFurnitureCentreCm(63, 33, dragged, [dragged]);
    expect(centre).toEqual({ x: 63, z: 33 });
  });

  it('magnetises against a rotated neighbour footprint', () => {
    const rotated = makeFurniture('b', [0, 0, 0], 120, 60, 90); // AABB x:[30,90] z:[-30,90]
    const dragged = makeFurniture('a', [0, 0, 0]);
    const centre = magnetiseFurnitureCentreCm(95 + 60, 30, dragged, [rotated]);
    expect(centre.x).toBeCloseTo(90 + 60);
  });
});

describe('magnetiseFurniturePositionCm', () => {
  it('converts through the stored bottom-left corner convention and keeps Y', () => {
    const neighbour = makeFurniture('b', [0, 0, 0]);
    const dragged = makeFurniture('a', [0, 42, 0]);
    const position = magnetiseFurniturePositionCm([126, 42, 0], dragged, [neighbour]);
    expect(position[0]).toBeCloseTo(120);
    expect(position[1]).toBe(42);
    expect(position[2]).toBeCloseTo(0);
  });
});

import { describe, it, expect } from 'vitest';
import { anchorFurniturePosition } from './furnitureAnchor';
import type { Vec3 } from '../types/cad';

// Rotation-by-θ about Y (Three.js convention) used to reason about the anchor edge.
function rotY(v: Vec3, deg: number): Vec3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const [x, y, z] = v;
  return [x * c + z * s, y, -x * s + z * c];
}

// World position of the planogram's anchored edge given a furniture position,
// dimensions, rotation and face. Mirrors SceneEditor's overlay anchoring:
//   front/top → local −X edge, back → local +X edge (mirror), left/right → local −Z edge.
function anchorWorld(
  position: Vec3,
  dims: { width: number; depth: number },
  rotDeg: number,
  face: 'front' | 'back' | 'top' | 'left' | 'right',
): Vec3 {
  const center: Vec3 = [
    position[0] + dims.width / 2,
    0,
    position[2] + dims.depth / 2,
  ];
  const localEdge: Vec3 =
    face === 'left' || face === 'right'
      ? [0, 0, -dims.depth / 2] // local −Z edge
      : face === 'back'
        ? [dims.width / 2, 0, 0] // local +X edge (back is a mirror of the front)
        : [-dims.width / 2, 0, 0]; // local −X edge (front/top)
  const rotated = rotY(localEdge, rotDeg);
  return [center[0] + rotated[0], 0, center[2] + rotated[2]];
}

describe('anchorFurniturePosition', () => {
  const pos: Vec3 = [10, 0, 20];

  it('is a no-op at 0° rotation (preserves existing behaviour)', () => {
    expect(anchorFurniturePosition(pos, 'front', 100, 110, 0)).toEqual(pos);
    expect(anchorFurniturePosition(pos, 'left', 40, 50, 0)).toEqual(pos);
  });

  describe.each([0, 90, 180, 270])('front/back face at %d°', (deg) => {
    it('keeps the column-0 edge world-anchored when adding a column', () => {
      const oldW = 100;
      const newW = 110;
      const newPos = anchorFurniturePosition(pos, 'front', oldW, newW, deg);
      const before = anchorWorld(pos, { width: oldW, depth: 40 }, deg, 'front');
      const after = anchorWorld(newPos, { width: newW, depth: 40 }, deg, 'front');
      expect(after[0]).toBeCloseTo(before[0], 6);
      expect(after[2]).toBeCloseTo(before[2], 6);
    });

    it('keeps the column-0 edge world-anchored when removing a column', () => {
      const oldW = 110;
      const newW = 100;
      const newPos = anchorFurniturePosition(pos, 'back', oldW, newW, deg);
      const before = anchorWorld(pos, { width: oldW, depth: 40 }, deg, 'back');
      const after = anchorWorld(newPos, { width: newW, depth: 40 }, deg, 'back');
      expect(after[0]).toBeCloseTo(before[0], 6);
      expect(after[2]).toBeCloseTo(before[2], 6);
    });
  });

  describe.each([0, 90, 180, 270])('left/right face at %d°', (deg) => {
    it('keeps the column-0 edge world-anchored when the depth axis changes', () => {
      const oldD = 40;
      const newD = 50;
      const newPos = anchorFurniturePosition(pos, 'right', oldD, newD, deg);
      const before = anchorWorld(pos, { width: 100, depth: oldD }, deg, 'right');
      const after = anchorWorld(newPos, { width: 100, depth: newD }, deg, 'right');
      expect(after[0]).toBeCloseTo(before[0], 6);
      expect(after[2]).toBeCloseTo(before[2], 6);
    });
  });

  it('flipped (180°) front face grows on the same physical side as 0°', () => {
    // At 0° the −X anchor edge stays fixed and the block grows toward +X.
    const at0 = anchorFurniturePosition(pos, 'front', 100, 110, 0);
    // At 180° the position must shift so the same physical (column-0) edge stays put.
    const at180 = anchorFurniturePosition(pos, 'front', 100, 110, 180);
    expect(at0).toEqual(pos); // unchanged
    expect(at180[0]).toBeCloseTo(pos[0] - 10, 6); // shifted by the full delta
  });

  it('back face is a mirror: at 0° it grows toward −X (shifts by the full delta)', () => {
    // The back overlay is a mirror of the front, so appending to the back planogram
    // renders toward −X. The anchor keeps the +X edge fixed, which at 0° means the
    // whole block shifts by the full delta toward −X (mirror of the front's 0° no-op).
    const front = anchorFurniturePosition(pos, 'front', 100, 110, 0);
    const back = anchorFurniturePosition(pos, 'back', 100, 110, 0);
    expect(front).toEqual(pos); // front keeps the −X edge fixed → no-op at 0°
    expect(back[0]).toBeCloseTo(pos[0] - 10, 6); // back keeps the +X edge fixed
    expect(back[1]).toBe(pos[1]);
    expect(back[2]).toBeCloseTo(pos[2], 6);
  });

  it('back face is a no-op at 180° (mirror of the front no-op at 0°)', () => {
    const back = anchorFurniturePosition(pos, 'back', 100, 110, 180);
    expect(back[0]).toBeCloseTo(pos[0], 6);
    expect(back[2]).toBeCloseTo(pos[2], 6);
  });

  describe.each([0, 90, 180, 270])('back face at %d°', (deg) => {
    it('keeps the −X (column-0) edge world-anchored when adding a column', () => {
      const oldW = 100;
      const newW = 110;
      const newPos = anchorFurniturePosition(pos, 'back', oldW, newW, deg);
      const before = anchorWorld(pos, { width: oldW, depth: 40 }, deg, 'back');
      const after = anchorWorld(newPos, { width: newW, depth: 40 }, deg, 'back');
      expect(after[0]).toBeCloseTo(before[0], 6);
      expect(after[2]).toBeCloseTo(before[2], 6);
    });
  });
});

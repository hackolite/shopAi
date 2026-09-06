/**
 * Furniture-to-furniture magnetisation ("aimantation mobilier").
 *
 * Furniture moves with total precision (no floor-grid snapping).  While
 * dragging, the moved footprint magnetises onto the *other furniture items*:
 *  - **collage** — a face of the dragged footprint sticks flush against the
 *    nearest facing side of a neighbour (touching, never overlapping);
 *  - **alignement** — when sticking to (or sliding along) a neighbour, the
 *    perpendicular edges also align so gondolas line up corner to corner.
 *
 * All computations work on the axis-aligned footprint of the rotated box
 * (rotations are quantised to 90°, so the AABB is exact).
 */

import type { FurnitureInstance } from '../types/cad';
import { footprintHalfSpanCm } from './gridSnap';

/** Distance (cm) under which a face or edge magnetises onto a neighbour. */
export const MAGNET_THRESHOLD_CM = 12;

export interface FootprintCm {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Axis-aligned floor footprint (cm) of a furniture item. */
export function furnitureFootprintCm(furniture: FurnitureInstance): FootprintCm {
  const half = footprintHalfSpanCm(
    furniture.rotation[1],
    furniture.dimensions.width,
    furniture.dimensions.depth,
  );
  const centreX = furniture.position[0] + furniture.dimensions.width / 2;
  const centreZ = furniture.position[2] + furniture.dimensions.depth / 2;
  return {
    minX: centreX - half.x,
    maxX: centreX + half.x,
    minZ: centreZ - half.z,
    maxZ: centreZ + half.z,
  };
}

/** 1D interval overlap/adjacency test with a tolerance margin. */
function spansAreClose(
  aMin: number,
  aMax: number,
  bMin: number,
  bMax: number,
  margin: number,
): boolean {
  return aMin <= bMax + margin && aMax >= bMin - margin;
}

/** Keep the candidate delta with the smallest magnitude under the threshold. */
function better(candidate: number, best: number | null, threshold: number): number | null {
  if (!Number.isFinite(candidate) || Math.abs(candidate) > threshold) return best;
  if (best === null || Math.abs(candidate) < Math.abs(best)) return candidate;
  return best;
}

/** 1D strict interval overlap (touching edges do not count as overlap). */
function spansOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  const epsilon = 1e-6;
  return aMin < bMax - epsilon && aMax > bMin + epsilon;
}

/**
 * Best magnet delta along one axis for the dragged span [`min`, `max`]
 * against a neighbour span [`otherMin`, `otherMax`].
 *
 * `collage` — the spans on the *other* axis are close, so face-to-face collage
 * applies (stick `min` flush against `otherMax`, or `max` against `otherMin`).
 * `alignment` — the boxes sit side by side on the other axis (near but not
 * overlapping), so edge alignment applies (`min`↔`otherMin`, `max`↔`otherMax`)
 * to line gondolas up corner to corner.
 */
function axisMagnetDelta(
  min: number,
  max: number,
  otherMin: number,
  otherMax: number,
  collage: boolean,
  alignment: boolean,
  threshold: number,
): number | null {
  let best: number | null = null;
  if (collage) {
    best = better(otherMax - min, best, threshold);
    best = better(otherMin - max, best, threshold);
  }
  if (alignment) {
    best = better(otherMin - min, best, threshold);
    best = better(otherMax - max, best, threshold);
  }
  return best;
}

/**
 * Magnetise the footprint centre (cm) of a dragged furniture item onto the
 * other furniture in the scene.  Returns the adjusted centre; when nothing is
 * within `thresholdCm` the input is returned untouched (free movement with
 * total precision).
 */
export function magnetiseFurnitureCentreCm(
  centreXCm: number,
  centreZCm: number,
  furniture: FurnitureInstance,
  others: readonly FurnitureInstance[],
  thresholdCm: number = MAGNET_THRESHOLD_CM,
): { x: number; z: number } {
  const half = footprintHalfSpanCm(
    furniture.rotation[1],
    furniture.dimensions.width,
    furniture.dimensions.depth,
  );
  let x = centreXCm;
  let z = centreZCm;
  const neighbours = others
    .filter((item) => item.id !== furniture.id)
    .map((item) => furnitureFootprintCm(item));

  // Two passes so that a collage on one axis unlocks the edge alignment on the
  // other axis (and vice versa) within a single call.
  for (let pass = 0; pass < 2; pass += 1) {
    const minX = x - half.x;
    const maxX = x + half.x;
    const minZ = z - half.z;
    const maxZ = z + half.z;
    let bestDx: number | null = null;
    let bestDz: number | null = null;
    for (const other of neighbours) {
      const xNear = spansAreClose(minX, maxX, other.minX, other.maxX, thresholdCm);
      const zNear = spansAreClose(minZ, maxZ, other.minZ, other.maxZ, thresholdCm);
      const xOverlap = spansOverlap(minX, maxX, other.minX, other.maxX);
      const zOverlap = spansOverlap(minZ, maxZ, other.minZ, other.maxZ);
      bestDx = better(
        axisMagnetDelta(
          minX, maxX, other.minX, other.maxX,
          zNear,
          zNear && !zOverlap,
          thresholdCm,
        ) ?? Infinity,
        bestDx,
        thresholdCm,
      );
      bestDz = better(
        axisMagnetDelta(
          minZ, maxZ, other.minZ, other.maxZ,
          xNear,
          xNear && !xOverlap,
          thresholdCm,
        ) ?? Infinity,
        bestDz,
        thresholdCm,
      );
    }
    if (bestDx === null && bestDz === null) break;
    if (bestDx !== null) x += bestDx;
    if (bestDz !== null) z += bestDz;
  }

  return { x, z };
}

/**
 * Magnetised stored position (bottom-left corner convention) for a candidate
 * position of `furniture`; Y is preserved.
 */
export function magnetiseFurniturePositionCm(
  positionCm: readonly [number, number, number],
  furniture: FurnitureInstance,
  others: readonly FurnitureInstance[],
  thresholdCm: number = MAGNET_THRESHOLD_CM,
): [number, number, number] {
  const centre = magnetiseFurnitureCentreCm(
    positionCm[0] + furniture.dimensions.width / 2,
    positionCm[2] + furniture.dimensions.depth / 2,
    furniture,
    others,
    thresholdCm,
  );
  return [
    centre.x - furniture.dimensions.width / 2,
    positionCm[1],
    centre.z - furniture.dimensions.depth / 2,
  ];
}

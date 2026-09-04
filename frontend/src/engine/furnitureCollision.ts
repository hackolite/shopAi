import type { FurnitureInstance, StoreConfig } from '../types/cad';
import { footprintHalfSpanCm, snapFurniturePositionCm } from './gridSnap';

const EPSILON_CM = 1e-6;

function footprint(furniture: FurnitureInstance) {
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

/** True only when two floor footprints overlap; furniture touching at an edge is allowed. */
export function furnitureOverlaps(a: FurnitureInstance, b: FurnitureInstance): boolean {
  const first = footprint(a);
  const second = footprint(b);
  return first.minX < second.maxX - EPSILON_CM
    && first.maxX > second.minX + EPSILON_CM
    && first.minZ < second.maxZ - EPSILON_CM
    && first.maxZ > second.minZ + EPSILON_CM;
}

export function canPlaceFurniture(candidate: FurnitureInstance, furniture: readonly FurnitureInstance[]): boolean {
  return !furniture.some((item) => item.id !== candidate.id && furnitureOverlaps(candidate, item));
}

/**
 * Finds the nearest free grid position, starting at the requested position.
 * The returned item remains inside the store floor; null means no grid slot fits.
 */
export function findFreeFurniturePosition(
  furniture: FurnitureInstance,
  occupied: readonly FurnitureInstance[],
  store: StoreConfig,
): [number, number, number] | null {
  const origin = { x: store.position?.[0] ?? 0, z: store.position?.[2] ?? 0 };
  const requested = snapFurniturePositionCm(
    furniture.position,
    furniture.dimensions,
    furniture.rotation[1],
    origin,
  );
  const maxRadius = Math.ceil(Math.max(store.dimensions.width, store.dimensions.depth) / 50);

  for (let radius = 0; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (const dz of [-radius, radius]) {
        if (radius > 0 && Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
        const position: [number, number, number] = [
          requested[0] + dx * 50,
          requested[1],
          requested[2] + dz * 50,
        ];
        const candidate = { ...furniture, position };
        const bounds = footprint(candidate);
        const withinStore = bounds.minX >= origin.x - EPSILON_CM
          && bounds.maxX <= origin.x + store.dimensions.width + EPSILON_CM
          && bounds.minZ >= origin.z - EPSILON_CM
          && bounds.maxZ <= origin.z + store.dimensions.depth + EPSILON_CM;
        if (withinStore && canPlaceFurniture(candidate, occupied)) return position;
      }
    }
  }
  return null;
}

import { describe, expect, it } from 'vitest';
import type { FurnitureInstance, StoreConfig } from '../types/cad';
import { canPlaceFurniture, findFreeFurniturePosition, furnitureOverlaps } from './furnitureCollision';

const store: StoreConfig = {
  id: 'store', name: 'Store', position: [0, 0, 0],
  dimensions: { width: 500, depth: 500, height: 300 }, floorColor: '#000', wallColor: '#000',
};

function furniture(id: string, x: number, z: number): FurnitureInstance {
  return {
    id, name: id, type: 'gondola', libraryId: id, position: [x, 0, z], rotation: [0, 0, 0],
    dimensions: { width: 100, depth: 100, height: 100 }, materialId: 'default',
    visible: true, locked: false, mounted: true, parentId: null, childIds: [], faces: {},
  };
}

describe('furniture collision', () => {
  it('allows furniture to touch but not overlap', () => {
    const first = furniture('first', 0, 0);
    expect(furnitureOverlaps(first, furniture('touching', 100, 0))).toBe(false);
    expect(furnitureOverlaps(first, furniture('overlapping', 50, 0))).toBe(true);
  });

  it('rejects a placement inside another furniture footprint', () => {
    const first = furniture('first', 0, 0);
    expect(canPlaceFurniture(furniture('next', 50, 50), [first])).toBe(false);
  });

  it('moves a new item to the nearest free grid position', () => {
    const first = furniture('first', 100, 100);
    const candidate = furniture('next', 100, 100);
    const position = findFreeFurniturePosition(candidate, [first], store);
    expect(position).not.toBeNull();
    expect(canPlaceFurniture({ ...candidate, position: position! }, [first])).toBe(true);
    expect(position![0] % 50).toBe(0);
    expect(position![2] % 50).toBe(0);
  });
});

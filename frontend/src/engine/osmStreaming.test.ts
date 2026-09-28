import { describe, expect, it } from 'vitest';
import {
  buildZoneTileIndex,
  lodLevelForDistance,
  rankTilesForStreaming,
  updateTileLru,
} from './osmStreaming';
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
    mounted: true,
    ...partial,
  };
}

describe('osmStreaming helpers', () => {
  it('indexes zones into spatial tiles and tracks per-zone coverage', () => {
    const zones = [
      zone({ id: 'a', x: 0, z: 0, width: 400, depth: 400 }),
      zone({ id: 'b', x: 950, z: 0, width: 200, depth: 200 }),
    ];
    const index = buildZoneTileIndex(zones, 1000);

    expect(index.tiles.get('0:0')).toEqual(expect.arrayContaining(['a', 'b']));
    expect(index.tiles.get('1:0')).toEqual(['b']);
    expect(index.zoneToTiles.get('a')).toEqual(['0:0']);
    expect(index.zoneToTiles.get('b')).toEqual(expect.arrayContaining(['0:0', '1:0']));
  });

  it('prioritizes forward-facing nearby tiles when streaming', () => {
    const zones = [
      zone({ id: 'front', x: 1000, z: 0, width: 300, depth: 300 }),
      zone({ id: 'back', x: -1200, z: 0, width: 300, depth: 300 }),
    ];
    const index = buildZoneTileIndex(zones, 1000);

    const ranked = rankTilesForStreaming(index, {
      x: 0,
      z: 0,
      dirX: 1,
      dirZ: 0,
      speedCmPerSec: 260,
    }, 'balanced');

    expect(ranked[0]?.tileKey).toBe('1:0');
    const backRank = ranked.findIndex((entry) => entry.tileKey === '-2:0');
    expect(backRank).toBeGreaterThan(0);
  });

  it('returns LOD tiers from distance and quality thresholds', () => {
    expect(lodLevelForDistance(800, 'performance')).toBe(0);
    expect(lodLevelForDistance(1500, 'performance')).toBe(1);
    expect(lodLevelForDistance(3500, 'performance')).toBe(2);
  });

  it('evicts least-recently-used tiles beyond resident cap', () => {
    const lru = new Map<string, number>([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);

    const evicted = updateTileLru(lru, ['b', 'd'], 3);

    expect(evicted).toEqual(['a']);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
    expect(lru.has('d')).toBe(true);
  });
});

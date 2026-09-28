import { zoneBoundsCm } from './floorZones';
import type { FloorZone } from '../types/cad';

export type ZoneLodLevel = 0 | 1 | 2;
export type OSMRenderQuality = 'high' | 'balanced' | 'performance';

export interface CameraSnapshotCm {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  speedCmPerSec: number;
}

export interface ZoneTileBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  radiusCm: number;
}

export interface ZoneTileIndex {
  tileSizeCm: number;
  tiles: Map<string, string[]>;
  zoneToTiles: Map<string, string[]>;
  zoneBounds: Map<string, ZoneTileBounds>;
}

export interface StreamingPriority {
  tileKey: string;
  distanceTiles: number;
  score: number;
}

export interface StreamingQualitySettings {
  nearRadiusTiles: number;
  farRadiusTiles: number;
  immediateTiles: number;
  streamStepTiles: number;
  maxResidentTiles: number;
  lodNearCm: number;
  lodMidCm: number;
}

export interface TileLruUpdateResult {
  evicted: string[];
  nextStamp: number;
}

const QUALITY_SETTINGS: Record<OSMRenderQuality, StreamingQualitySettings> = {
  high: {
    nearRadiusTiles: 3,
    farRadiusTiles: 6,
    immediateTiles: 20,
    streamStepTiles: 8,
    maxResidentTiles: 84,
    lodNearCm: 1800,
    lodMidCm: 4200,
  },
  balanced: {
    nearRadiusTiles: 2,
    farRadiusTiles: 5,
    immediateTiles: 14,
    streamStepTiles: 6,
    maxResidentTiles: 56,
    lodNearCm: 1400,
    lodMidCm: 3000,
  },
  performance: {
    nearRadiusTiles: 2,
    farRadiusTiles: 4,
    immediateTiles: 10,
    streamStepTiles: 4,
    maxResidentTiles: 36,
    lodNearCm: 900,
    lodMidCm: 2200,
  },
};

function tileCoord(valueCm: number, tileSizeCm: number): number {
  return Math.floor(valueCm / tileSizeCm);
}

function tileCoordMaxInclusive(valueCm: number, tileSizeCm: number): number {
  const epsilon = Math.max(1e-6, tileSizeCm * 1e-6);
  return Math.floor((valueCm - epsilon) / tileSizeCm);
}

export function tileKey(ix: number, iz: number): string {
  return `${ix}:${iz}`;
}

export function parseTileKey(key: string): { ix: number; iz: number } {
  const [ixRaw, izRaw] = key.split(':', 2);
  return {
    ix: Number(ixRaw),
    iz: Number(izRaw),
  };
}

export function qualitySettings(quality: OSMRenderQuality): StreamingQualitySettings {
  return QUALITY_SETTINGS[quality];
}

export function buildZoneTileIndex(zones: FloorZone[], tileSizeCm: number): ZoneTileIndex {
  const tiles = new Map<string, string[]>();
  const zoneToTiles = new Map<string, string[]>();
  const zoneBounds = new Map<string, ZoneTileBounds>();

  zones.forEach((zone) => {
    const bounds = zoneBoundsCm(zone);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const halfW = (bounds.maxX - bounds.minX) / 2;
    const halfD = (bounds.maxZ - bounds.minZ) / 2;
    const radiusCm = Math.hypot(halfW, halfD);

    const tileBounds: ZoneTileBounds = {
      ...bounds,
      centerX,
      centerZ,
      radiusCm,
    };
    zoneBounds.set(zone.id, tileBounds);

    const minIx = tileCoord(bounds.minX, tileSizeCm);
    const maxIx = tileCoordMaxInclusive(bounds.maxX, tileSizeCm);
    const minIz = tileCoord(bounds.minZ, tileSizeCm);
    const maxIz = tileCoordMaxInclusive(bounds.maxZ, tileSizeCm);

    const keys: string[] = [];
    for (let iz = minIz; iz <= maxIz; iz += 1) {
      for (let ix = minIx; ix <= maxIx; ix += 1) {
        const key = tileKey(ix, iz);
        keys.push(key);
        const ids = tiles.get(key);
        if (ids) ids.push(zone.id);
        else tiles.set(key, [zone.id]);
      }
    }

    zoneToTiles.set(zone.id, keys);
  });

  return {
    tileSizeCm,
    tiles,
    zoneToTiles,
    zoneBounds,
  };
}

function tileCenterCm(key: string, tileSizeCm: number): { x: number; z: number } {
  const { ix, iz } = parseTileKey(key);
  return {
    x: (ix + 0.5) * tileSizeCm,
    z: (iz + 0.5) * tileSizeCm,
  };
}

export function rankTilesForStreaming(
  index: ZoneTileIndex,
  camera: CameraSnapshotCm,
  quality: OSMRenderQuality,
): StreamingPriority[] {
  const settings = qualitySettings(quality);
  const priorities: StreamingPriority[] = [];

  index.tiles.forEach((_, key) => {
    const center = tileCenterCm(key, index.tileSizeCm);
    const dx = center.x - camera.x;
    const dz = center.z - camera.z;
    const distanceCm = Math.hypot(dx, dz);
    const distanceTiles = distanceCm / index.tileSizeCm;
    if (distanceTiles > settings.farRadiusTiles) return;

    const invLen = distanceCm > 1e-6 ? 1 / distanceCm : 0;
    const toTileX = dx * invLen;
    const toTileZ = dz * invLen;
    const forwardDot = toTileX * camera.dirX + toTileZ * camera.dirZ;

    // Forward-facing and close tiles get loaded first.
    const directionalPenalty = forwardDot >= 0 ? (1 - forwardDot) * 0.4 : (1 - forwardDot) * 0.9;
    const speedBias = camera.speedCmPerSec > 220
      ? Math.max(0, forwardDot) * 0.3
      : Math.max(0, forwardDot) * 0.12;
    const score = distanceTiles + directionalPenalty - speedBias;

    priorities.push({
      tileKey: key,
      distanceTiles,
      score,
    });
  });

  priorities.sort((left, right) => left.score - right.score);
  return priorities;
}

export function lodLevelForDistance(distanceCm: number, quality: OSMRenderQuality): ZoneLodLevel {
  const settings = qualitySettings(quality);
  if (distanceCm <= settings.lodNearCm) return 0;
  if (distanceCm <= settings.lodMidCm) return 1;
  return 2;
}

export function planActiveTileKeys(
  priorities: StreamingPriority[],
  previousActive: Iterable<string>,
  selectedTileKeys: Iterable<string>,
  settings: StreamingQualitySettings,
): string[] {
  const candidateKeys = priorities.map((priority) => priority.tileKey);
  const candidateSet = new Set(candidateKeys);
  const nextTileSet = new Set<string>();

  priorities.forEach((priority) => {
    if (priority.distanceTiles <= settings.nearRadiusTiles) nextTileSet.add(priority.tileKey);
  });
  for (let index = 0; index < Math.min(settings.immediateTiles, candidateKeys.length); index += 1) {
    nextTileSet.add(candidateKeys[index]);
  }
  for (const key of selectedTileKeys) nextTileSet.add(key);
  for (const key of previousActive) {
    if (candidateSet.has(key)) nextTileSet.add(key);
  }
  let streamedAdds = 0;
  for (const key of candidateKeys) {
    if (nextTileSet.has(key)) continue;
    if (streamedAdds >= settings.streamStepTiles) break;
    nextTileSet.add(key);
    streamedAdds += 1;
  }
  return [...nextTileSet];
}

export function updateTileLru(
  lru: Map<string, number>,
  activeKeys: Iterable<string>,
  maxSize: number,
  startStamp = 0,
): TileLruUpdateResult {
  let stamp = startStamp;
  for (const key of activeKeys) {
    stamp += 1;
    lru.set(key, stamp);
  }
  if (lru.size <= maxSize) return { evicted: [], nextStamp: stamp };

  const sorted = [...lru.entries()].sort((a, b) => a[1] - b[1]);
  const toEvict = sorted.slice(0, Math.max(0, lru.size - maxSize)).map(([key]) => key);
  toEvict.forEach((key) => lru.delete(key));
  return { evicted: toEvict, nextStamp: stamp };
}

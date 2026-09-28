export type BuildingEdgeLod = 'far' | 'mid' | 'near';

/** Edge-only LOD thresholds for large mounted building zones (in world units/metres). */
const BUILDING_EDGE_NEAR_DISTANCE = 90;
const BUILDING_EDGE_MID_DISTANCE = 180;

export function edgeLodForDistanceSquared(distanceSquared: number): BuildingEdgeLod {
  if (distanceSquared <= BUILDING_EDGE_NEAR_DISTANCE * BUILDING_EDGE_NEAR_DISTANCE) return 'near';
  if (distanceSquared <= BUILDING_EDGE_MID_DISTANCE * BUILDING_EDGE_MID_DISTANCE) return 'mid';
  return 'far';
}

export function horizontalDistanceSquared(
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function shouldUseLightweightBuildingEdges({
  mounted,
  isBuildingZone,
  isSelected,
  hovered,
}: {
  mounted: boolean;
  isBuildingZone: boolean;
  isSelected: boolean;
  hovered: boolean;
}): boolean {
  return mounted && isBuildingZone && !isSelected && !hovered;
}

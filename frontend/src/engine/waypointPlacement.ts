import type { SimulationWaypoint } from '../types/cad';

export function shouldPlaceWaypointOnFloorClick(
  selectionType: string | null,
  waypointPlacementType: SimulationWaypoint['type'] | null,
): waypointPlacementType is SimulationWaypoint['type'] {
  return selectionType !== 'planogram_cell' && waypointPlacementType !== null;
}

export function floorClickWaypointPositionCm(args: {
  pointXUnit: number;
  pointZUnit: number;
  unitToCm: number;
  originXCm: number;
  originZCm: number;
  widthCm: number;
  depthCm: number;
}): { x: number; z: number } {
  const {
    pointXUnit,
    pointZUnit,
    unitToCm,
    originXCm,
    originZCm,
    widthCm,
    depthCm,
  } = args;
  const maxXCm = originXCm + widthCm;
  const maxZCm = originZCm + depthCm;
  return {
    x: Math.round(Math.max(originXCm, Math.min(maxXCm, pointXUnit * unitToCm))),
    z: Math.round(Math.max(originZCm, Math.min(maxZCm, pointZUnit * unitToCm))),
  };
}

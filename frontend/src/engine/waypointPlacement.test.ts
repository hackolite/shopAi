import { describe, expect, it } from 'vitest';
import { floorClickWaypointPositionCm, shouldPlaceWaypointOnFloorClick } from './waypointPlacement';

describe('waypointPlacement', () => {
  it('does not place waypoint when a planogram cell is selected', () => {
    expect(shouldPlaceWaypointOnFloorClick('planogram_cell', 'entry')).toBe(false);
  });

  it('places waypoint when placement mode is selected', () => {
    expect(shouldPlaceWaypointOnFloorClick(null, 'transit')).toBe(true);
  });

  it('clamps floor click position to store bounds', () => {
    expect(floorClickWaypointPositionCm({
      pointXUnit: 20.5,
      pointZUnit: -5.2,
      unitToCm: 100,
      originXCm: 200,
      originZCm: 300,
      widthCm: 500,
      depthCm: 400,
    })).toEqual({ x: 700, z: 300 });
  });
});

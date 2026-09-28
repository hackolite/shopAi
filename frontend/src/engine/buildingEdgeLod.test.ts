import { describe, expect, it } from 'vitest';
import {
  edgeLodForDistanceSquared,
  horizontalDistanceSquared,
  shouldUseLightweightBuildingEdges,
} from './buildingEdgeLod';

describe('shouldUseLightweightBuildingEdges', () => {
  it('uses lightweight edges only for idle mounted building zones', () => {
    expect(shouldUseLightweightBuildingEdges({
      mounted: true,
      isBuildingZone: true,
      isSelected: false,
      hovered: false,
    })).toBe(true);
  });

  it('keeps full edges when the building is selected or hovered', () => {
    expect(shouldUseLightweightBuildingEdges({
      mounted: true,
      isBuildingZone: true,
      isSelected: true,
      hovered: false,
    })).toBe(false);
    expect(shouldUseLightweightBuildingEdges({
      mounted: true,
      isBuildingZone: true,
      isSelected: false,
      hovered: true,
    })).toBe(false);
  });

  it('does not switch non-building or flat zones to lightweight edges', () => {
    expect(shouldUseLightweightBuildingEdges({
      mounted: false,
      isBuildingZone: true,
      isSelected: false,
      hovered: false,
    })).toBe(false);
    expect(shouldUseLightweightBuildingEdges({
      mounted: true,
      isBuildingZone: false,
      isSelected: false,
      hovered: false,
    })).toBe(false);
  });
});

describe('edgeLodForDistanceSquared', () => {
  it('keeps full vertical edges near the camera and simplifies as distance grows', () => {
    expect(edgeLodForDistanceSquared(80 * 80)).toBe('near');
    expect(edgeLodForDistanceSquared(120 * 120)).toBe('mid');
    expect(edgeLodForDistanceSquared(220 * 220)).toBe('far');
  });
});

describe('horizontalDistanceSquared', () => {
  it('ignores camera height so edge LOD follows footprint distance', () => {
    expect(horizontalDistanceSquared({ x: 10, z: 20 }, { x: 13, z: 24 })).toBe(25);
  });
});

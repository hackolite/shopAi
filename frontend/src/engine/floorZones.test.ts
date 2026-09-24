import { describe, expect, it } from 'vitest';
import {
  floorShapePlanePointCm,
  floorZoneValidationError,
  zoneHeightCm,
  zoneMounted,
  zoneOutlinePointsCm,
  zonePathMode,
  zoneRotationDeg,
  zoneShape,
  zoneSupportsSimulationPreview,
  zoneSupportsResizeHandles,
} from './floorZones';
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
    ...partial,
  };
}

describe('floorZones helpers', () => {
  it('defaults missing shapes to rectangle', () => {
    expect(zoneShape(zone({}))).toBe('rectangle');
    expect(zoneRotationDeg(zone({}))).toBe(0);
    expect(zonePathMode(zone({}))).toBe('linear');
    expect(zoneMounted(zone({}))).toBe(false);
    expect(zoneHeightCm(zone({}))).toBe(120);
  });

  it('keeps mounted forbidden zones in full 3D during simulation', () => {
    expect(zoneSupportsSimulationPreview(zone({ type: 'forbidden', mounted: false }))).toBe(true);
    expect(zoneSupportsSimulationPreview(zone({ type: 'forbidden', mounted: true }))).toBe(false);
    expect(zoneSupportsSimulationPreview(zone({ type: 'entrance', mounted: true }))).toBe(false);
  });

  it('keeps resize handles for bounded shapes but not free polygons', () => {
    expect(zoneSupportsResizeHandles(zone({ shape: 'rectangle' }))).toBe(true);
    expect(zoneSupportsResizeHandles(zone({ shape: 'circle' }))).toBe(true);
    expect(zoneSupportsResizeHandles(zone({ shape: 'diamond' }))).toBe(true);
    expect(zoneSupportsResizeHandles(zone({
      shape: 'polygon',
      points: [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 0, z: 100 }],
    }))).toBe(false);
    expect(zoneSupportsResizeHandles(zone({ shape: 'rectangle', rotationDeg: 15 }))).toBe(false);
  });

  it('rotates bounded floor drawings around their center', () => {
    expect(zoneOutlinePointsCm(zone({
      shape: 'rectangle',
      width: 200,
      depth: 100,
      rotationDeg: 90,
    }))).toEqual([
      { x: 150, z: -50 },
      { x: 150, z: 150 },
      { x: 50, z: 150 },
      { x: 50, z: -50 },
    ]);
  });

  it('maps floor points onto the shape plane without mirroring the floor fill', () => {
    expect(floorShapePlanePointCm({ x: 130, z: 260 }, { x: 100, z: 200 })).toEqual([30, -60]);
    expect(floorShapePlanePointCm({ x: 130, z: 260 })).toEqual([130, -260]);
  });

  it('rejects self-intersecting floor drawings', () => {
    expect(floorZoneValidationError([
      { x: 0, z: 0 },
      { x: 200, z: 200 },
      { x: 0, z: 200 },
      { x: 200, z: 0 },
    ])).toContain('croise');
  });

  it('rejects floor drawings that leave the store bounds', () => {
    expect(floorZoneValidationError(
      [{ x: 0, z: 0 }, { x: 200, z: 0 }, { x: 200, z: 200 }, { x: 0, z: 200 }],
      { storeWidth: 150, storeDepth: 150 },
    )).toContain('intérieur du magasin');
  });

  it('samples smooth polygon drawings into curves', () => {
    const outline = zoneOutlinePointsCm(zone({
      shape: 'polygon',
      pathMode: 'smooth',
      points: [
        { x: 0, z: 0 },
        { x: 100, z: 0 },
        { x: 100, z: 100 },
        { x: 0, z: 100 },
      ],
    }));
    expect(outline.length).toBeGreaterThan(4);
  });

  it('keeps smooth drawings inside the store boundary', () => {
    const points = [
      { x: 0, z: 0 },
      { x: 150, z: 0 },
      { x: 150, z: 150 },
      { x: 0, z: 150 },
    ];
    expect(floorZoneValidationError(points, {
      storeWidth: 150,
      storeDepth: 150,
      pathMode: 'smooth',
    })).toBeNull();
    const outline = zoneOutlinePointsCm(zone({
      shape: 'polygon',
      pathMode: 'smooth',
      points,
    }), {
      storeWidth: 150,
      storeDepth: 150,
    });
    expect(Math.min(...outline.map((point) => point.x))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...outline.map((point) => point.x))).toBeLessThanOrEqual(150);
    expect(Math.min(...outline.map((point) => point.z))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...outline.map((point) => point.z))).toBeLessThanOrEqual(150);
  });
});

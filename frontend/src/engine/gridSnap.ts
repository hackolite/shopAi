/**
 * Grid snapping helpers ("magnétisme").
 *
 * The floor grid drawn in the 3D editor is anchored on the **store origin**, so
 * every snapped value must be a multiple of the cell size *relative to that
 * origin* — snapping to absolute world multiples would drift by up to half a
 * cell whenever the store origin (or its centre) is not itself on the lattice.
 *
 * Furniture positions are stored as the bottom-left corner of the *unrotated*
 * bounding box, while the rendered footprint is the box rotated around its
 * centre.  Snapping therefore works on the rotated (axis-aligned) footprint so
 * a rotated item lands exactly on cell borders too.
 */

/** Size of one grid cell, in centimetres (0.5 m). */
export const GRID_CELL_CM = 50;

/** Guard against float drift when converting between cm and Three.js units. */
const EPSILON_CM = 1e-6;

function clean(value: number): number {
  const rounded = Math.round(value / EPSILON_CM) * EPSILON_CM;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Snap a coordinate (cm) to the nearest grid line of the lattice anchored on
 * `originCm`.
 */
export function snapToCell(valueCm: number, originCm = 0, cellCm: number = GRID_CELL_CM): number {
  if (!Number.isFinite(valueCm)) return originCm;
  const cell = cellCm > 0 ? cellCm : GRID_CELL_CM;
  const origin = Number.isFinite(originCm) ? originCm : 0;
  return clean(origin + Math.round((valueCm - origin) / cell) * cell);
}

/**
 * Snap a dimension (cm) to a whole number of cells, never below `minCm`
 * (which is itself rounded up to a whole cell).
 */
export function snapSizeToCell(valueCm: number, minCm = 0, cellCm: number = GRID_CELL_CM): number {
  const cell = cellCm > 0 ? cellCm : GRID_CELL_CM;
  const floor = Math.max(cell, Math.ceil(Math.max(0, minCm) / cell) * cell);
  const snapped = Math.round((Number.isFinite(valueCm) ? valueCm : 0) / cell) * cell;
  return clean(Math.max(floor, snapped));
}

/**
 * Half extent (cm) of the axis-aligned footprint of a `widthCm` × `depthCm` box
 * rotated by `rotationYDeg` around its centre.
 */
export function footprintHalfSpanCm(
  rotationYDeg: number,
  widthCm: number,
  depthCm: number,
): { x: number; z: number } {
  const rad = ((Number.isFinite(rotationYDeg) ? rotationYDeg : 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    x: clean((cos * widthCm + sin * depthCm) / 2),
    z: clean((sin * widthCm + cos * depthCm) / 2),
  };
}

export interface GridOriginCm {
  x: number;
  z: number;
}

export interface SnapDimensionsCm {
  width: number;
  depth: number;
}

/**
 * Snap a furniture position so the **corner of its rotated footprint** lands on
 * a grid cell border.  `positionCm` follows the `FurnitureInstance.position`
 * convention (bottom-left corner of the unrotated box); the Y component is
 * returned untouched.
 */
export function snapFurniturePositionCm(
  positionCm: readonly [number, number, number],
  dimensionsCm: SnapDimensionsCm,
  rotationYDeg: number,
  origin: GridOriginCm = { x: 0, z: 0 },
  cellCm: number = GRID_CELL_CM,
): [number, number, number] {
  const half = footprintHalfSpanCm(rotationYDeg, dimensionsCm.width, dimensionsCm.depth);
  // Footprint centre implied by the stored position.
  const centreX = positionCm[0] + dimensionsCm.width / 2;
  const centreZ = positionCm[2] + dimensionsCm.depth / 2;
  // Snap the footprint corner, then convert back to the stored convention.
  const cornerX = snapToCell(centreX - half.x, origin.x, cellCm);
  const cornerZ = snapToCell(centreZ - half.z, origin.z, cellCm);
  return [
    clean(cornerX + half.x - dimensionsCm.width / 2),
    positionCm[1],
    clean(cornerZ + half.z - dimensionsCm.depth / 2),
  ];
}

/**
 * Footprint centre (cm) of a furniture item — the world position of the group
 * that renders it.
 */
export function furnitureCentreCm(
  positionCm: readonly [number, number, number],
  dimensionsCm: SnapDimensionsCm,
): { x: number; z: number } {
  return {
    x: positionCm[0] + dimensionsCm.width / 2,
    z: positionCm[2] + dimensionsCm.depth / 2,
  };
}

/**
 * Snap a footprint centre (cm) so the rotated footprint corner falls on a cell
 * border.  Used while dragging, where only the centre is known.
 */
export function snapFurnitureCentreCm(
  centreXCm: number,
  centreZCm: number,
  dimensionsCm: SnapDimensionsCm,
  rotationYDeg: number,
  origin: GridOriginCm = { x: 0, z: 0 },
  cellCm: number = GRID_CELL_CM,
): { x: number; z: number } {
  const half = footprintHalfSpanCm(rotationYDeg, dimensionsCm.width, dimensionsCm.depth);
  return {
    x: clean(snapToCell(centreXCm - half.x, origin.x, cellCm) + half.x),
    z: clean(snapToCell(centreZCm - half.z, origin.z, cellCm) + half.z),
  };
}

/**
 * Geometry of the rendered grid plane along one axis.
 *
 * The `<Grid>` helper draws its lines at multiples of the cell size **from the
 * centre of its plane**, so the centre has to sit on the lattice anchored on
 * the store origin.  The plane is padded symmetrically (by at most one cell)
 * so that it still covers the whole floor once re-centred.
 */
export function gridPlaneSpec(
  originCm: number,
  sizeCm: number,
  cellCm: number = GRID_CELL_CM,
): { sizeCm: number; centreCm: number } {
  const cell = cellCm > 0 ? cellCm : GRID_CELL_CM;
  const size = Math.max(0, Number.isFinite(sizeCm) ? sizeCm : 0);
  const rawCentre = originCm + size / 2;
  const centre = snapToCell(rawCentre, originCm, cell);
  const pad = 2 * Math.abs(centre - rawCentre);
  return { sizeCm: clean(size + pad), centreCm: clean(centre) };
}

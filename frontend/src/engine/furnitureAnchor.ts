// ─── Furniture anchoring ─────────────────────────────────────────────────────
//
// When a planogram column is added or removed, the linked gondola furniture grows
// or shrinks along one horizontal axis. The planogram overlay is aligned to a
// fixed *physical* edge of the block (see SceneEditor overlay logic):
//   • front / top face → horizontal axis is the furniture's local X, and column 0
//     sits at the local −X edge (new columns are appended toward +X). Growing keeps
//     the local −X edge fixed.
//   • back face → the overlay is a true mirror of the front (its texture is not
//     flipped, see SceneEditor): data column 0 sits at the local +X edge. A column
//     appended to the back planogram (its right, in editor order) therefore appears
//     at the local −X end, so growing must keep the local +X edge fixed instead.
//   • left / right faces → horizontal axis is the furniture's local Z, and
//     column 0 sits at the local −Z edge.
//
// The furniture geometry is centred on `position + dimensions/2`, so simply changing
// a dimension while keeping `position` fixed moves the block symmetrically about its
// centre. Once the block is rotated (most notably flipped 180° to face the opposite
// aisle) the anchor edge maps to a different world edge and the existing planogram
// content shifts — columns then appear to grow from the wrong physical side.
//
// `anchorFurniturePosition` compensates the furniture position for its Y-axis
// rotation so the anchored edge stays put in world space, making add/remove-column
// behave identically regardless of how the block is oriented.

import type { FaceId, Vec3 } from '../types/cad';

/**
 * Returns the furniture world position that keeps the planogram's anchored edge
 * fixed when a horizontal dimension changes from `oldHorizontalCm` to
 * `newHorizontalCm`.
 *
 * The anchored edge is the local −X edge for front/top (and the local −Z edge for
 * left/right), and the local +X edge for the back face (which is rendered as a
 * mirror of the front).
 *
 * @param position        Current furniture position (world-space min corner, cm).
 * @param face            Face the planogram is attached to.
 * @param oldHorizontalCm Horizontal dimension before the change (width for
 *                        front/back/top, depth for left/right), in cm.
 * @param newHorizontalCm Horizontal dimension after the change, in cm.
 * @param rotationYDeg    Furniture Y-axis rotation, in degrees.
 */
export function anchorFurniturePosition(
  position: Vec3,
  face: FaceId,
  oldHorizontalCm: number,
  newHorizontalCm: number,
  rotationYDeg: number,
): Vec3 {
  const half = (newHorizontalCm - oldHorizontalCm) / 2;
  const theta = (rotationYDeg * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const [px, py, pz] = position;

  if (face === 'left' || face === 'right') {
    // Horizontal axis = local Z, anchor the local −Z edge.
    return [px + s * half, py, pz - (1 - c) * half];
  }
  if (face === 'back') {
    // Mirror of the front: horizontal axis = local X, anchor the local +X edge so
    // that appending to the back planogram (which renders toward −X) grows the block
    // toward −X and keeps existing back content fixed in world space.
    return [px - (1 + c) * half, py, pz + s * half];
  }
  // front / top: horizontal axis = local X, anchor the local −X edge so new columns
  // grow toward +X.
  return [px - (1 - c) * half, py, pz - s * half];
}

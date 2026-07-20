// ─── Furniture anchoring ─────────────────────────────────────────────────────
//
// When a planogram column is added or removed, the linked gondola furniture grows
// or shrinks along one horizontal axis. The planogram overlay is aligned to a
// fixed *physical* edge of the block (see SceneEditor overlay logic):
//   • front / back / top face → horizontal axis is the furniture's local X, and
//     column 0 sits at the local −X edge (new columns grow toward +X). The same
//     planogram is shown on every face, so the back uses the identical −X anchor as the
//     front; its overlay texture is flipped to cancel the plane's π rotation so columns
//     stay at the same physical X position on both faces.
//   • left / right faces → horizontal axis is the furniture's local Z, and
//     column 0 sits at the local −Z edge.
//
// The furniture geometry is centred on `position + dimensions/2`, so simply changing
// a dimension while keeping `position` fixed moves the block symmetrically about its
// centre. At 0° rotation this happens to keep the anchor edge fixed, but once the
// block is rotated (most notably flipped 180° to face the opposite aisle) the anchor
// edge maps to a different world edge and the existing planogram content shifts —
// columns then appear to grow from the wrong physical side.
//
// `anchorFurniturePosition` compensates the furniture position for its Y-axis
// rotation so the column-0 edge stays put in world space, making add/remove-column
// behave identically regardless of how the block is oriented. At 0° it is a no-op,
// preserving the established behaviour.

import type { FaceId, Vec3 } from '../types/cad';

/**
 * Returns the furniture world position that keeps the planogram's column-0 edge
 * anchored when a horizontal dimension changes from `oldHorizontalCm` to
 * `newHorizontalCm`.
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
  // front / back / top: horizontal axis = local X, anchor the local −X edge so new
  // columns grow toward +X. The back overlay is flipped to keep columns at the same
  // physical X as the front, so it shares this anchor rather than mirroring it.
  return [px - (1 - c) * half, py, pz - s * half];
}

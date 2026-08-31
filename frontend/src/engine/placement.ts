import type { StoreConfig } from '../types/cad';

/**
 * Placement helpers for newly created objects.
 *
 * Everything created from a panel (furniture, simulation waypoint) must appear
 * at the **bottom-left corner of the grid** — i.e. next to the store origin —
 * so the user immediately sees it instead of having to hunt for it far away in
 * the scene.
 */

/** Distance (cm) kept between the store walls and a freshly created object. */
export const NEW_OBJECT_MARGIN_CM = 100;
/**
 * Extra clearance (cm) added around a waypoint radius so that a waypoint
 * dropped in the corner still satisfies the backend walkability constraints
 * (an exit needs its whole radius plus the agent radius inside the store).
 */
export const WAYPOINT_MARGIN_PADDING_CM = 40;

function storeOrigin(store: StoreConfig | null | undefined): { x: number; z: number } {
  return { x: store?.position?.[0] ?? 0, z: store?.position?.[2] ?? 0 };
}

function storeSize(store: StoreConfig | null | undefined): { width: number; depth: number } {
  return {
    width: store?.dimensions?.width ?? 0,
    depth: store?.dimensions?.depth ?? 0,
  };
}

function clampToSpan(offset: number, span: number, size: number): number {
  // Keep the object inside the store even when it is larger than the margin
  // (or larger than the store itself, in which case it sticks to the origin).
  const maxOffset = Math.max(0, span - size);
  return Math.max(0, Math.min(offset, maxOffset));
}

/**
 * Bottom-left position (cm) for a new furniture item.
 * The returned value is the bottom-left corner of its bounding box, which is
 * the convention used by `FurnitureInstance.position`.
 */
export function bottomLeftFurniturePosition(
  store: StoreConfig | null | undefined,
  dimensions: { width: number; depth: number },
  marginCm: number = NEW_OBJECT_MARGIN_CM,
): [number, number, number] {
  const origin = storeOrigin(store);
  const size = storeSize(store);
  const x = origin.x + clampToSpan(marginCm, size.width, dimensions.width);
  const z = origin.z + clampToSpan(marginCm, size.depth, dimensions.depth);
  return [x, 0, z];
}

/**
 * Bottom-left centre position (cm) for a new simulation waypoint of the given
 * radius. The margin grows with the radius so the waypoint disc stays fully
 * inside the walkable area.
 */
export function bottomLeftWaypointPosition(
  store: StoreConfig | null | undefined,
  radiusCm: number,
  marginCm: number = NEW_OBJECT_MARGIN_CM,
): { x: number; z: number } {
  const origin = storeOrigin(store);
  const size = storeSize(store);
  const margin = Math.max(marginCm, radiusCm + WAYPOINT_MARGIN_PADDING_CM);
  return {
    x: Math.round(origin.x + clampToSpan(margin, size.width, margin)),
    z: Math.round(origin.z + clampToSpan(margin, size.depth, margin)),
  };
}

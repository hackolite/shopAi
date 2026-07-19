// ─── Gondola — separator-based planogram model ───────────────────────────────
//
// Source of truth: gondola geometry (width, shelves, separator positions).
// Boxes are NEVER stored — they are derived by computeBoxes().
// Convention: vertical axis indexed bottom-up (position 0 = bottom of gondola).
// Unit: centimetres everywhere.

export type SeparatorType = 'virtual' | 'physical';

/** A vertical boundary within a shelf. */
export interface Separator {
  id: string;
  /** X position from the left edge of the gondola (0 … gondola.width_cm). */
  position_cm: number;
  /** "virtual" = freely movable logical boundary; "physical" = fixed furniture constraint. */
  type: SeparatorType;
  /** Derived from type but explicit for clarity and future exceptions. */
  movable: boolean;
}

/** A horizontal shelf (one level of the gondola), bottom-up ordered. */
export interface Shelf {
  id: string;
  /** Physical height of this shelf level. */
  height_cm: number;
  /**
   * All vertical boundaries for this shelf, including the left (0) and right (width_cm)
   * edges which must always be present with movable=false.
   * Kept sorted by position_cm; enforced by every command.
   */
  separators: Separator[];
}

/**
 * A product assigned to a box.  The box is identified by the PAIR
 * (leftSeparatorId, rightSeparatorId) on a given shelf — never by an index,
 * which would shift on separator insert/delete.
 */
export interface ProductPlacement {
  /** EAN of the product. */
  productId: string;
  shelfId: string;
  leftSeparatorId: string;
  rightSeparatorId: string;
  rotation?: 0 | 90 | 180 | 270;
  /** Preserved for backward-compat round-trips with the legacy cell format. */
  cellId?: string;
}

/**
 * The main gondola object.  Only width_cm is resizable; height_cm is always fixed.
 * shelves[0] = bottom-most shelf, shelves[N-1] = top-most shelf.
 */
export interface Gondola {
  id: string;
  width_cm: number;
  /** Fixed: never resized by the user. */
  height_cm: number;
  depth_cm: number;
  /** Ordered bottom-up: shelves[0] is the lowest shelf. */
  shelves: Shelf[];
  productPlacements: ProductPlacement[];
}

// ─── Computed (never stored) ──────────────────────────────────────────────────

/** A computed box — the space between two adjacent separators on a shelf. */
export interface Box {
  shelfId: string;
  /** 0 = top-most shelf in display order, N-1 = bottom-most. */
  shelfDisplayIndex: number;
  /** Left-to-right index within the shelf (0 = leftmost box). */
  boxIndex: number;
  /** Left edge X in cm from the gondola's left edge. */
  x_cm: number;
  width_cm: number;
  /** Y position from the physical bottom of the gondola. */
  y_cm: number;
  height_cm: number;
  leftSeparatorId: string;
  rightSeparatorId: string;
  placement?: ProductPlacement;
}

/**
 * Visual selection key for a box: `${shelfDisplayIndex}-${boxIndex}`.
 * shelfDisplayIndex 0 = top shelf (mirrors the old row=0 convention).
 * Equivalent to the old `${row}-${col}` key.
 */
export type BoxKey = string;

export function makeBoxKey(shelfDisplayIndex: number, boxIndex: number): BoxKey {
  return `${shelfDisplayIndex}-${boxIndex}`;
}

export function parseBoxKey(key: BoxKey): [number, number] | null {
  const parts = key.split('-').map(Number);
  if (
    parts.length !== 2 ||
    !Number.isInteger(parts[0]) || parts[0] < 0 ||
    !Number.isInteger(parts[1]) || parts[1] < 0
  ) return null;
  return [parts[0], parts[1]];
}

/**
 * Gondola engine — boundary-based planogram model.
 *
 * All functions are pure (no side effects, no mutations).
 * The gondola is the single source of truth; boxes are computed on demand.
 *
 * §2 data model, §3 compute function, §4 business rules, §6 adapters.
 */
import type {
  Box,
  BoxKey,
  Gondola,
  ProductPlacement,
  Separator,
  Shelf,
} from '../types/gondola';
import { makeBoxKey } from '../types/gondola';
import type { Planogram, PlanogramCell } from '../types/cad';

// ─── Constants ────────────────────────────────────────────────────────────────
export const DEFAULT_SHELF_HEIGHT_CM = 30;
export const DEFAULT_SEP_SPACING_CM = 15;
export const MIN_BOX_CM = 2;
export const DEFAULT_GONDOLA_DEPTH_CM = 45;

// ─── §3 Core: computeBoxes ────────────────────────────────────────────────────

/**
 * Derives all boxes from the gondola geometry.
 * Pure function — called at every render, never stored.
 * Produces boxes ordered: shelves top-to-bottom, boxes left-to-right.
 */
export function computeBoxes(gondola: Gondola): Box[] {
  const boxes: Box[] = [];
  const shelfCount = gondola.shelves.length;

  // Build cumulative y positions bottom-up first
  const yBottoms: number[] = new Array(shelfCount).fill(0);
  let yAcc = 0;
  for (let i = 0; i < shelfCount; i++) {
    yBottoms[i] = yAcc;
    yAcc += gondola.shelves[i].height_cm;
  }

  // Iterate shelves in display order (top = shelves[N-1], bottom = shelves[0])
  for (let di = 0; di < shelfCount; di++) {
    const physIdx = shelfCount - 1 - di; // physical index (0=bottom)
    const shelf = gondola.shelves[physIdx];

    const sortedSeps = [...shelf.separators].sort((a, b) => a.position_cm - b.position_cm);

    for (let bi = 0; bi < sortedSeps.length - 1; bi++) {
      const leftSep = sortedSeps[bi];
      const rightSep = sortedSeps[bi + 1];

      const placement = gondola.productPlacements.find(
        (p) =>
          p.shelfId === shelf.id &&
          p.leftSeparatorId === leftSep.id &&
          p.rightSeparatorId === rightSep.id,
      );

      boxes.push({
        shelfId: shelf.id,
        shelfDisplayIndex: di,
        boxIndex: bi,
        x_cm: leftSep.position_cm,
        width_cm: rightSep.position_cm - leftSep.position_cm,
        y_cm: yBottoms[physIdx],
        height_cm: shelf.height_cm,
        leftSeparatorId: leftSep.id,
        rightSeparatorId: rightSep.id,
        placement,
      });
    }
  }

  return boxes;
}

/** Build a Map<BoxKey, Box> for O(1) lookup. */
export function buildBoxMap(boxes: Box[]): Map<BoxKey, Box> {
  const map = new Map<BoxKey, Box>();
  for (const box of boxes) {
    map.set(makeBoxKey(box.shelfDisplayIndex, box.boxIndex), box);
  }
  return map;
}

// ─── Shelf access helpers ─────────────────────────────────────────────────────

/** Returns the shelf shown at display row `di` (0=top). */
export function getShelfByDisplayIndex(gondola: Gondola, di: number): Shelf | undefined {
  return gondola.shelves[gondola.shelves.length - 1 - di];
}

/** Returns sorted separators for a shelf. */
export function sortedSeps(shelf: Shelf): Separator[] {
  return [...shelf.separators].sort((a, b) => a.position_cm - b.position_cm);
}

/** Returns the number of boxes in a shelf (= separators - 1). */
export function shelfBoxCount(shelf: Shelf): number {
  return Math.max(0, shelf.separators.length - 1);
}

// ─── Invariant enforcement ─────────────────────────────────────────────────────

/**
 * After any command: sorts separators and forces the leftmost to 0 and the
 * rightmost to gondola.width_cm (§4 truncation invariant).
 */
export function enforceInvariants(gondola: Gondola): Gondola {
  return {
    ...gondola,
    shelves: gondola.shelves.map((shelf) => {
      const sorted = [...shelf.separators].sort((a, b) => a.position_cm - b.position_cm);
      if (sorted.length < 2) return shelf; // degenerate — skip
      // Force left and right boundaries
      sorted[0] = { ...sorted[0], position_cm: 0, movable: false };
      sorted[sorted.length - 1] = {
        ...sorted[sorted.length - 1],
        position_cm: gondola.width_cm,
        movable: false,
      };
      return { ...shelf, separators: sorted };
    }),
  };
}

// ─── §4 Commands ─────────────────────────────────────────────────────────────
// All commands are pure functions that return a new Gondola.

/** §4 Resize cell (move a separator). Enforces MIN_BOX_CM on both sides. */
export function cmdMoveSeparator(
  g: Gondola,
  shelfId: string,
  sepId: string,
  newPos: number,
): Gondola {
  const shelf = g.shelves.find((s) => s.id === shelfId);
  if (!shelf) return g;
  const sorted = sortedSeps(shelf);
  const idx = sorted.findIndex((s) => s.id === sepId);
  if (idx < 0) return g;
  const sep = sorted[idx];
  if (!sep.movable) return g; // §5 physical separators are immovable

  // Clamp: left neighbour + MIN_BOX_CM … right neighbour − MIN_BOX_CM
  const leftBound = (sorted[idx - 1]?.position_cm ?? 0) + MIN_BOX_CM;
  const rightBound = (sorted[idx + 1]?.position_cm ?? g.width_cm) - MIN_BOX_CM;

  // §4 crush-blocker: don't compress a box that has a product below the product's minimum
  // (simple clamp — product dimension check is done in the UI layer)
  const clamped = Math.max(leftBound, Math.min(rightBound, newPos));

  return enforceInvariants({
    ...g,
    shelves: g.shelves.map((s) =>
      s.id === shelfId
        ? {
            ...s,
            separators: s.separators.map((sep2) =>
              sep2.id === sepId ? { ...sep2, position_cm: clamped } : sep2,
            ),
          }
        : s,
    ),
  });
}

/** §4 Add cell (insert a new virtual separator). */
export function cmdInsertSeparator(
  g: Gondola,
  shelfId: string,
  position_cm: number,
): Gondola {
  const newSep: Separator = {
    id: crypto.randomUUID(),
    position_cm,
    type: 'virtual',
    movable: true,
  };
  return enforceInvariants({
    ...g,
    shelves: g.shelves.map((s) =>
      s.id === shelfId
        ? { ...s, separators: [...s.separators, newSep] }
        : s,
    ),
  });
}

/**
 * §4 Delete cell / §4 Fuse facings: remove a separator, merging the two
 * adjacent boxes. Any ProductPlacement on either side is deleted.
 * The left and right boundary separators (position 0 and width_cm) cannot be removed.
 */
export function cmdRemoveSeparator(
  g: Gondola,
  shelfId: string,
  sepId: string,
): Gondola {
  const shelf = g.shelves.find((s) => s.id === shelfId);
  if (!shelf) return g;
  const sorted = sortedSeps(shelf);
  const idx = sorted.findIndex((s) => s.id === sepId);
  // Cannot remove boundary separators (first or last)
  if (idx <= 0 || idx >= sorted.length - 1) return g;

  const leftSepId = sorted[idx - 1].id;
  const rightSepId = sorted[idx + 1].id;

  // Remove placements whose box touches the removed separator (both left and right sides)
  const newPlacements = g.productPlacements.filter((p) => {
    if (p.shelfId !== shelfId) return true;
    // The left box: leftSepId … sepId
    if (p.leftSeparatorId === leftSepId && p.rightSeparatorId === sepId) return false;
    // The right box: sepId … rightSepId
    if (p.leftSeparatorId === sepId && p.rightSeparatorId === rightSepId) return false;
    return true;
  });

  return enforceInvariants({
    ...g,
    shelves: g.shelves.map((s) =>
      s.id === shelfId
        ? { ...s, separators: s.separators.filter((sep) => sep.id !== sepId) }
        : s,
    ),
    productPlacements: newPlacements,
  });
}

/** Remove ALL internal separators between fromSepId and toSepId on a shelf (fuse facings). */
export function cmdFuseBoxes(
  g: Gondola,
  shelfId: string,
  fromSepId: string,
  toSepId: string,
): Gondola {
  const shelf = g.shelves.find((s) => s.id === shelfId);
  if (!shelf) return g;
  const sorted = sortedSeps(shelf);
  const fromIdx = sorted.findIndex((s) => s.id === fromSepId);
  const toIdx = sorted.findIndex((s) => s.id === toSepId);
  if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) return g;
  if (toIdx - fromIdx < 2) return g; // no internal separators to remove

  // IDs of separators to remove: all strictly between fromIdx and toIdx
  const toRemoveIds = new Set(sorted.slice(fromIdx + 1, toIdx).map((s) => s.id));
  if (toRemoveIds.size === 0) return g;

  // Remove placements whose box falls within the fused range
  const newPlacements = g.productPlacements.filter((p) => {
    if (p.shelfId !== shelfId) return true;
    const lIdx = sorted.findIndex((s) => s.id === p.leftSeparatorId);
    const rIdx = sorted.findIndex((s) => s.id === p.rightSeparatorId);
    // Keep only placements fully outside the fused range
    if (lIdx < fromIdx || rIdx > toIdx) return true;
    return false;
  });

  return enforceInvariants({
    ...g,
    shelves: g.shelves.map((s) =>
      s.id === shelfId
        ? { ...s, separators: s.separators.filter((sep) => !toRemoveIds.has(sep.id)) }
        : s,
    ),
    productPlacements: newPlacements,
  });
}

/** §4 Split facing: insert a new separator inside a box.
 *  If the original box had a product placement, it is preserved on the left sub-box.
 */
export function cmdSplitBox(
  g: Gondola,
  shelfId: string,
  leftSepId: string,
  rightSepId: string,
  splitPos: number,
): Gondola {
  const shelf = g.shelves.find((s) => s.id === shelfId);
  if (!shelf) return g;
  const sorted = sortedSeps(shelf);
  const lIdx = sorted.findIndex((s) => s.id === leftSepId);
  const rIdx = sorted.findIndex((s) => s.id === rightSepId);
  if (lIdx < 0 || rIdx < 0 || rIdx !== lIdx + 1) return g;

  const leftPos = sorted[lIdx].position_cm;
  const rightPos = sorted[rIdx].position_cm;
  const clampedPos = Math.max(leftPos + MIN_BOX_CM, Math.min(rightPos - MIN_BOX_CM, splitPos));

  // Remember any existing placement so we can move it to the left sub-box.
  const existingPlacement = g.productPlacements.find(
    (p) => p.shelfId === shelfId && p.leftSeparatorId === leftSepId && p.rightSeparatorId === rightSepId,
  );

  // Remove the placement for the original box before inserting the separator.
  const placementsWithoutOld = g.productPlacements.filter(
    (p) => !(p.shelfId === shelfId && p.leftSeparatorId === leftSepId && p.rightSeparatorId === rightSepId),
  );

  const existingIds = new Set(sorted.map((s) => s.id));
  const gAfterSplit = cmdInsertSeparator(
    { ...g, productPlacements: placementsWithoutOld },
    shelfId,
    clampedPos,
  );

  if (existingPlacement) {
    // Find the newly created separator (its id was not in the original set).
    const newShelf = gAfterSplit.shelves.find((s) => s.id === shelfId);
    const newSep = newShelf?.separators.find((s) => !existingIds.has(s.id));
    if (newSep) {
      // Re-add the placement pointing to leftSepId → newSep (left sub-box).
      // Preserve the original cellId so the placement keeps the same identity.
      return {
        ...gAfterSplit,
        productPlacements: [
          ...gAfterSplit.productPlacements,
          { ...existingPlacement, rightSeparatorId: newSep.id },
        ],
      };
    }
  }

  return gAfterSplit;
}

/** Place or replace a product in a box. */
export function cmdSetPlacement(
  g: Gondola,
  shelfId: string,
  leftSepId: string,
  rightSepId: string,
  ean: string,
  rotation: 0 | 90 | 180 | 270 = 0,
  cellId?: string,
): Gondola {
  const placement: ProductPlacement = {
    productId: ean,
    shelfId,
    leftSeparatorId: leftSepId,
    rightSeparatorId: rightSepId,
    rotation,
    cellId: cellId ?? crypto.randomUUID(),
  };
  const filtered = g.productPlacements.filter(
    (p) =>
      !(p.shelfId === shelfId && p.leftSeparatorId === leftSepId && p.rightSeparatorId === rightSepId),
  );
  return { ...g, productPlacements: [...filtered, placement] };
}

/** Remove the product from a box. */
export function cmdClearPlacement(
  g: Gondola,
  shelfId: string,
  leftSepId: string,
  rightSepId: string,
): Gondola {
  return {
    ...g,
    productPlacements: g.productPlacements.filter(
      (p) =>
        !(p.shelfId === shelfId && p.leftSeparatorId === leftSepId && p.rightSeparatorId === rightSepId),
    ),
  };
}

/** Remove all product placements from the gondola. */
export function cmdClearAllPlacements(g: Gondola): Gondola {
  return { ...g, productPlacements: [] };
}

/** Remove all product placements from a set of boxes (by BoxKey). */
export function cmdClearBoxesByKeys(
  g: Gondola,
  boxes: Box[],
  keys: Set<BoxKey>,
): Gondola {
  const toRemove: Array<{ shelfId: string; leftSepId: string; rightSepId: string }> = [];
  for (const key of keys) {
    const box = boxes.find(
      (b) => makeBoxKey(b.shelfDisplayIndex, b.boxIndex) === key,
    );
    if (box) toRemove.push({ shelfId: box.shelfId, leftSepId: box.leftSeparatorId, rightSepId: box.rightSeparatorId });
  }
  let result = g;
  for (const { shelfId, leftSepId, rightSepId } of toRemove) {
    result = cmdClearPlacement(result, shelfId, leftSepId, rightSepId);
  }
  return result;
}

/**
 * §4 Add shelf: inserts a new shelf above the given one (or at top if omitted).
 * Shrinks the top shelf by newHeight_cm; blocked if insufficient space.
 */
export function cmdAddShelf(
  g: Gondola,
  newHeight_cm: number,
  insertAboveShelfId?: string,
): Gondola {
  const newShelf = makeDefaultShelf(g.width_cm, newHeight_cm, Math.max(MIN_BOX_CM, DEFAULT_SEP_SPACING_CM));

  if (!insertAboveShelfId) {
    // Insert at top (append to end of shelves array which is bottom-up)
    const topShelf = g.shelves[g.shelves.length - 1];
    const topH = topShelf.height_cm - newHeight_cm;
    if (topH < MIN_BOX_CM) return g; // blocked
    return {
      ...g,
      shelves: [
        ...g.shelves.slice(0, -1),
        { ...topShelf, height_cm: topH },
        newShelf,
      ],
      height_cm: g.height_cm, // total height stays fixed
    };
  }

  const idx = g.shelves.findIndex((s) => s.id === insertAboveShelfId);
  if (idx < 0) return g;

  // Shrink the shelf above the insertion point (or the top shelf if inserting at top)
  const absorbIdx = idx + 1 < g.shelves.length ? idx + 1 : idx;
  const absorb = g.shelves[absorbIdx];
  const absorbNewH = absorb.height_cm - newHeight_cm;
  if (absorbNewH < MIN_BOX_CM) return g; // blocked

  const newShelves = g.shelves.map((s, i) => (i === absorbIdx ? { ...s, height_cm: absorbNewH } : s));
  newShelves.splice(idx + 1, 0, newShelf);

  return { ...g, shelves: newShelves };
}

/**
 * §4 Remove shelf: deletes a shelf, giving its height to the shelf above it
 * (or to the one below if it was the top shelf).
 */
export function cmdRemoveShelf(g: Gondola, shelfId: string): Gondola {
  if (g.shelves.length <= 1) return g; // must keep at least one shelf

  const idx = g.shelves.findIndex((s) => s.id === shelfId);
  if (idx < 0) return g;

  const removedH = g.shelves[idx].height_cm;
  // Absorber: shelf above (idx+1) if it exists, otherwise shelf below (idx-1)
  const absorbIdx = idx + 1 < g.shelves.length ? idx + 1 : idx - 1;

  const newShelves = g.shelves
    .filter((_, i) => i !== idx)
    .map((s, i) => {
      const origIdx = i >= idx ? i + 1 : i; // map back to original index
      return origIdx === absorbIdx ? { ...s, height_cm: s.height_cm + removedH } : s;
    });

  // Remove all placements associated with the deleted shelf
  const newPlacements = g.productPlacements.filter((p) => p.shelfId !== shelfId);

  return { ...g, shelves: newShelves, productPlacements: newPlacements };
}

/**
 * §4 Extend gondola height: inserts a new shelf without taking height from any
 * existing shelf.  The gondola's total height_cm grows by newShelfHeightCm.
 *
 * Use this when the planogram edition needs to add a row beyond the current
 * capacity (i.e. when cmdAddShelf is blocked because the absorber shelf is too
 * small).  The linked furniture dimensions must be updated by the caller via
 * syncFurnitureDimension so the 3D gondola follows the planogram.
 *
 * insertAboveShelfId — when provided the new shelf is inserted just above that
 *   shelf (bottom-up array position idx+1); when omitted the new shelf is
 *   appended at the top.
 */
export function extendGondolaHeight(
  g: Gondola,
  newShelfHeightCm: number,
  insertAboveShelfId?: string,
): Gondola {
  const newShelf = makeDefaultShelf(g.width_cm, newShelfHeightCm, DEFAULT_SEP_SPACING_CM);
  const newHeightCm = g.height_cm + newShelfHeightCm;

  if (!insertAboveShelfId) {
    // Append at top (bottom-up array: top shelf has the highest index)
    return { ...g, height_cm: newHeightCm, shelves: [...g.shelves, newShelf] };
  }

  const idx = g.shelves.findIndex((s) => s.id === insertAboveShelfId);
  if (idx < 0) {
    // Unknown shelf id — fall back to inserting at top
    return { ...g, height_cm: newHeightCm, shelves: [...g.shelves, newShelf] };
  }

  const newShelves = [...g.shelves];
  newShelves.splice(idx + 1, 0, newShelf);
  return { ...g, height_cm: newHeightCm, shelves: newShelves };
}

/**
 * Resize two adjacent shelves simultaneously (drag border between them).
 * shelfId1 is the top shelf, shelfId2 is the bottom shelf in display order.
 * In the gondola's bottom-up array, shelfId2 has the lower physical index.
 */
export function cmdResizeAdjacentShelves(
  g: Gondola,
  shelfId1: string,
  h1: number,
  shelfId2: string,
  h2: number,
): Gondola {
  return {
    ...g,
    shelves: g.shelves.map((s) => {
      if (s.id === shelfId1) return { ...s, height_cm: Math.max(MIN_BOX_CM, h1) };
      if (s.id === shelfId2) return { ...s, height_cm: Math.max(MIN_BOX_CM, h2) };
      return s;
    }),
  };
}

// ─── §4 Snapping ─────────────────────────────────────────────────────────────

/**
 * §4 Snapping: snap a separator position to the nearest separator in the shelf
 * below (shelves[displayIndex + 1]), within thresholdCm.
 */
export function snapToShelfBelow(
  gondola: Gondola,
  shelfDisplayIndex: number,
  valueCm: number,
  thresholdCm: number,
): { snapped: number; idx: number } {
  const belowShelf = getShelfByDisplayIndex(gondola, shelfDisplayIndex + 1);
  if (!belowShelf) return { snapped: valueCm, idx: -1 };

  const boundaries = sortedSeps(belowShelf).map((s) => s.position_cm);
  let best = valueCm;
  let minDist = Infinity;
  let snapIdx = -1;
  for (let i = 0; i < boundaries.length; i++) {
    const dist = Math.abs(valueCm - boundaries[i]);
    if (dist < thresholdCm && dist < minDist) {
      minDist = dist;
      best = boundaries[i];
      snapIdx = i;
    }
  }
  return { snapped: best, idx: snapIdx };
}

// ─── §6 Migration helpers ─────────────────────────────────────────────────────

/** Create a shelf with evenly-spaced separators (left + internal + right). */
function makeDefaultShelf(
  widthCm: number,
  heightCm: number,
  spacing: number,
): Shelf {
  const id = crypto.randomUUID();
  const leftSep: Separator = { id: crypto.randomUUID(), position_cm: 0, type: 'virtual', movable: false };
  const rightSep: Separator = { id: crypto.randomUUID(), position_cm: widthCm, type: 'virtual', movable: false };
  const internals: Separator[] = [];
  let pos = spacing;
  while (pos < widthCm - MIN_BOX_CM) {
    internals.push({ id: crypto.randomUUID(), position_cm: pos, type: 'virtual', movable: true });
    pos += spacing;
  }
  return { id, height_cm: heightCm, separators: [leftSep, ...internals, rightSep] };
}

/**
 * §6 legacyCellsToSeparators: convert an old Planogram (cells/rows/cols) to a Gondola.
 * A regular grid of cells translates directly to equidistant separators.
 */
export function legacyCellsToSeparators(planogram: Planogram): Gondola {
  const gondolaId = planogram.id;
  const shelves: Shelf[] = [];
  const placements: ProductPlacement[] = [];

  const rowHeights = getEffectiveRowHeights(planogram);
  const colWidths = getEffectiveColWidths(planogram);

  // Old model: row 0 = top → display index 0 = top → physical index N-1 (bottom-up)
  for (let displayRow = 0; displayRow < planogram.rows; displayRow++) {
    const physIdx = planogram.rows - 1 - displayRow;
    const rowColCount = planogram.rowColCounts?.[displayRow] ?? planogram.cols;

    // Build separators for this shelf: left boundary + internal + right boundary
    const separators: Separator[] = [];
    const leftSep: Separator = {
      id: crypto.randomUUID(),
      position_cm: 0,
      type: 'virtual',
      movable: false,
    };
    separators.push(leftSep);

    let posX = 0;
    for (let c = 0; c < rowColCount; c++) {
      const overrideKey = `${displayRow}-${c}`;
      const cellW =
        planogram.cellWidthOverrides?.[overrideKey] ??
        colWidths[c] ??
        (planogram.widthCm / planogram.cols);
      posX += cellW;

      if (c < rowColCount - 1) {
        // Internal separator (movable)
        separators.push({
          id: crypto.randomUUID(),
          position_cm: posX,
          type: 'virtual',
          movable: true,
        });
      }
    }

    // Right boundary
    const rightSep: Separator = {
      id: crypto.randomUUID(),
      position_cm: planogram.widthCm,
      type: 'virtual',
      movable: false,
    };
    separators.push(rightSep);

    const shelfId = crypto.randomUUID();
    shelves[physIdx] = {
      id: shelfId,
      height_cm: rowHeights[displayRow],
      separators,
    };

    // Build product placements
    for (let c = 0; c < rowColCount; c++) {
      const cell = planogram.cells.find((cl) => cl.row === displayRow && cl.col === c);
      if (cell) {
        placements.push({
          productId: cell.ean,
          shelfId,
          leftSeparatorId: separators[c].id,
          rightSeparatorId: separators[c + 1].id,
          rotation: cell.rotation,
          cellId: cell.id,
        });
      }
    }
  }

  return {
    id: gondolaId,
    width_cm: planogram.widthCm,
    height_cm: planogram.heightCm,
    depth_cm: DEFAULT_GONDOLA_DEPTH_CM,
    shelves,
    productPlacements: placements,
  };
}

/**
 * §6 boxesToLegacyCells: convert a Gondola to the legacy Planogram format
 * consumed by the 3D view and the REST API.
 *
 * Returns a full Planogram object with cells, rows, cols, colWidthsCm,
 * rowHeightsCm, rowColCounts, and cellWidthOverrides populated from the gondola.
 */
export function gondolaToLegacyPlanogram(
  gondola: Gondola,
  base: Omit<Planogram, 'rows' | 'cols' | 'widthCm' | 'heightCm' | 'cells' | 'colWidthsCm' | 'rowHeightsCm' | 'rowColCounts' | 'cellWidthOverrides' | 'cellHeightOverrides' | 'mergedSpans'> & { gondola?: Gondola },
): Planogram {
  const boxes = computeBoxes(gondola);
  const shelfCount = gondola.shelves.length;

  const rows = shelfCount;
  // Global cols: maximum box count across all shelves
  let maxCols = 0;
  for (let di = 0; di < shelfCount; di++) {
    const shelf = getShelfByDisplayIndex(gondola, di);
    if (shelf) maxCols = Math.max(maxCols, shelfBoxCount(shelf));
  }
  const cols = Math.max(1, maxCols);

  // Per-row heights (display order: row 0 = top)
  const rowHeightsCm: number[] = [];
  for (let di = 0; di < shelfCount; di++) {
    const shelf = getShelfByDisplayIndex(gondola, di);
    rowHeightsCm.push(shelf?.height_cm ?? 0);
  }

  // Per-row column counts
  const rowColCountsRaw: number[] = [];
  for (let di = 0; di < shelfCount; di++) {
    const shelf = getShelfByDisplayIndex(gondola, di);
    rowColCountsRaw.push(shelf ? shelfBoxCount(shelf) : cols);
  }
  const rowColCounts = rowColCountsRaw.every((c) => c === cols) ? undefined : rowColCountsRaw;

  // Per-cell width overrides (all cells get explicit widths)
  const cellWidthOverrides: Record<string, number> = {};
  for (const box of boxes) {
    cellWidthOverrides[`${box.shelfDisplayIndex}-${box.boxIndex}`] = box.width_cm;
  }

  // Cells (legacy PlanogramCell format)
  const cells: PlanogramCell[] = [];
  for (const box of boxes) {
    if (box.placement) {
      cells.push({
        id: box.placement.cellId ?? crypto.randomUUID(),
        ean: box.placement.productId,
        row: box.shelfDisplayIndex,
        col: box.boxIndex,
        rotation: box.placement.rotation ?? 0,
      });
    }
  }

  return {
    ...base,
    gondola,
    rows,
    cols,
    widthCm: gondola.width_cm,
    heightCm: gondola.height_cm,
    cells,
    colWidthsCm: undefined,
    rowHeightsCm,
    rowColCounts,
    cellWidthOverrides: Object.keys(cellWidthOverrides).length ? cellWidthOverrides : undefined,
    cellHeightOverrides: undefined,
    mergedSpans: undefined,
  };
}

// ─── Local helpers (mirrors the editor's helpers for use in tests) ─────────────

function getEffectiveColWidths(p: {
  cols: number;
  widthCm: number;
  colWidthsCm?: number[];
}): number[] {
  return p.colWidthsCm?.length === p.cols
    ? p.colWidthsCm
    : Array(p.cols).fill(p.widthCm / p.cols);
}

function getEffectiveRowHeights(p: {
  rows: number;
  heightCm: number;
  rowHeightsCm?: number[];
}): number[] {
  return p.rowHeightsCm?.length === p.rows
    ? p.rowHeightsCm
    : Array(p.rows).fill(p.heightCm / p.rows);
}

/** Looks up a box in an array by its (shelfDisplayIndex, boxIndex). */
export function findBox(
  boxes: Box[],
  shelfDisplayIndex: number,
  boxIndex: number,
): Box | undefined {
  return boxes.find(
    (b) => b.shelfDisplayIndex === shelfDisplayIndex && b.boxIndex === boxIndex,
  );
}

/** Returns all boxes on a given display row, sorted by boxIndex. */
export function getRowBoxes(boxes: Box[], shelfDisplayIndex: number): Box[] {
  return boxes.filter((b) => b.shelfDisplayIndex === shelfDisplayIndex).sort((a, b) => a.boxIndex - b.boxIndex);
}

/** Computes separator positions (cm) for a shelf sorted left-to-right. */
export function getSeparatorPositions(shelf: Shelf): number[] {
  return sortedSeps(shelf).map((s) => s.position_cm);
}

/**
 * §4 Shrink gondola width: removes the last column from every shelf (or a
 * specific shelf when `shelfId` is supplied) and moves the right boundary to the
 * position of the last internal separator, reducing `gondola.width_cm`.
 *
 * Any product placement in the removed column is discarded.
 * No-op when there is only one column on a shelf (boundary pair only) or the
 * resulting width would fall below `MIN_BOX_CM * 2`.
 */
export function shrinkGondolaWidth(gondola: Gondola, shelfId?: string): Gondola {
  // ── Pass 1: determine the target new width ────────────────────────────────
  // Only the shelf(es) in scope (all when shelfId is undefined, or the
  // specified shelf) contribute to the new width decision.  We take the
  // minimum of their second-to-last separator positions so the column removed
  // from the right is anchored to the left on every shelf.
  let newWidthCm = gondola.width_cm;
  for (const shelf of gondola.shelves) {
    if (shelfId && shelf.id !== shelfId) continue;
    const sorted = [...shelf.separators].sort((a, b) => a.position_cm - b.position_cm);
    // Need at least 3 separators (left boundary + 1 internal + right boundary)
    if (sorted.length < 3) continue;
    const newRightPos = sorted[sorted.length - 2].position_cm;
    if (newRightPos < MIN_BOX_CM * 2) continue;
    newWidthCm = Math.min(newWidthCm, newRightPos);
  }

  if (newWidthCm >= gondola.width_cm) return gondola; // nothing can be shrunk

  // ── Pass 2: apply newWidthCm consistently to ALL shelves ─────────────────
  // Every shelf's right boundary is moved to newWidthCm and any internal
  // separators that now lie at or beyond newWidthCm are removed.  This
  // guarantees all shelves stay in sync with the gondola's declared width
  // (reduction from the right, anchored to the left).
  const shelves = gondola.shelves.map((shelf) => {
    const sorted = [...shelf.separators].sort((a, b) => a.position_cm - b.position_cm);
    if (sorted.length < 2) return shelf; // malformed shelf, leave unchanged

    // Keep all separators strictly left of newWidthCm (including the left
    // boundary at 0), then append a right boundary at newWidthCm reusing the
    // existing right boundary's ID so product placements remain valid.
    const interior = sorted.slice(0, -1).filter(sep => sep.position_cm < newWidthCm);
    const newRightBoundary: Separator = {
      ...sorted[sorted.length - 1],
      position_cm: newWidthCm,
      movable: false,
      type: 'virtual',
    };

    return {
      ...shelf,
      separators: [...interior, newRightBoundary],
    };
  });

  // Drop product placements whose right separator was removed.
  const productPlacements = gondola.productPlacements.filter((p) => {
    const shelf = shelves.find((s) => s.id === p.shelfId);
    if (!shelf) return true;
    const leftSep  = shelf.separators.find((s) => s.id === p.leftSeparatorId);
    const rightSep = shelf.separators.find((s) => s.id === p.rightSeparatorId);
    return leftSep !== undefined && rightSep !== undefined;
  });

  return { ...gondola, width_cm: newWidthCm, shelves, productPlacements };
}

/**
 * §4 Extend gondola width: grows the gondola to `newWidthCm`, adding empty boxes
 * in the new region `[oldWidthCm, newWidthCm)` on every shelf.
 *
 * Existing shelves and product placements are fully preserved.  New internal
 * separators are spaced at the same width as the last existing column on each shelf
 * (or DEFAULT_SEP_SPACING_CM when there is only the boundary pair).
 *
 * No-op when `newWidthCm <= gondola.width_cm`.
 */
export function extendGondolaWidth(gondola: Gondola, newWidthCm: number): Gondola {
  if (newWidthCm <= gondola.width_cm + MIN_BOX_CM / 2) return gondola;

  const oldWidthCm = gondola.width_cm;

  return {
    ...gondola,
    width_cm: newWidthCm,
    shelves: gondola.shelves.map((shelf) => {
      const sorted = [...shelf.separators].sort((a, b) => a.position_cm - b.position_cm);
      if (sorted.length < 2) return shelf;

      // Estimate column spacing from the last existing column on this shelf.
      const lastColWidth =
        sorted[sorted.length - 1].position_cm - sorted[sorted.length - 2].position_cm;
      const colSpacing = Math.max(MIN_BOX_CM, lastColWidth);

      // Move the right boundary separator to the new width.
      const newSorted = sorted.map((sep, idx) =>
        idx === sorted.length - 1 ? { ...sep, position_cm: newWidthCm } : sep,
      );

      // Add internal separators in the new region at regular intervals.
      // Start at oldWidthCm (the old right boundary) so that a separator is
      // always placed there, creating a clean left edge for the first new box
      // instead of merging it with the last existing column.
      const extraSeps: Separator[] = [];
      let pos = oldWidthCm;
      while (pos < newWidthCm - MIN_BOX_CM) {
        extraSeps.push({
          id: crypto.randomUUID(),
          position_cm: pos,
          type: 'virtual',
          movable: true,
        });
        pos += colSpacing;
      }

      return {
        ...shelf,
        separators: [
          ...newSorted.slice(0, -1), // existing seps except right boundary
          ...extraSeps,              // new empty-box separators
          newSorted[newSorted.length - 1], // right boundary at newWidthCm
        ],
      };
    }),
  };
}

/**
 * §4 Extend gondola width from the LEFT: grows the gondola to `newWidthCm`,
 * inserting empty boxes in the new region `[0, newWidthCm - oldWidthCm)` on every
 * shelf. Existing columns keep their content and are shifted right by the delta,
 * so column 0 becomes the newly inserted empty box (insertion "au début / à
 * gauche" of the planogram).
 *
 * This is the left-anchored mirror of `extendGondolaWidth`. It is used to keep the
 * opposite gondola face in sync: when a column is appended to one face (on the
 * right), the matching column is prepended to the opposite face (on the left) so
 * both new columns land on the same physical end of the gondola.
 *
 * Existing product placements are fully preserved: separators keep their IDs, so
 * placements stay attached to the same boxes as they shift right.
 *
 * No-op when `newWidthCm <= gondola.width_cm`.
 */
export function extendGondolaWidthLeft(gondola: Gondola, newWidthCm: number): Gondola {
  if (newWidthCm <= gondola.width_cm + MIN_BOX_CM / 2) return gondola;

  const oldWidthCm = gondola.width_cm;
  const shiftAmt = newWidthCm - oldWidthCm;

  return {
    ...gondola,
    width_cm: newWidthCm,
    shelves: gondola.shelves.map((shelf) => {
      const sorted = [...shelf.separators].sort((a, b) => a.position_cm - b.position_cm);
      if (sorted.length < 2) return shelf;

      // Estimate column spacing from the first existing column on this shelf.
      const firstColWidth = sorted[1].position_cm - sorted[0].position_cm;
      const colSpacing = Math.max(MIN_BOX_CM, firstColWidth);

      // Shift every existing separator right by the added width. The old left
      // boundary (now at shiftAmt) is demoted to a movable internal separator so
      // it forms a clean right edge for the last new box; a fresh left boundary is
      // added at 0.
      const shifted: Separator[] = sorted.map((sep, idx) => ({
        ...sep,
        position_cm: sep.position_cm + shiftAmt,
        // The former left boundary becomes an internal separator; all others keep
        // their movability (the former right boundary stays a fixed boundary).
        movable: idx === 0 ? true : sep.movable,
        type: idx === 0 ? 'virtual' : sep.type,
      }));

      // New left boundary at 0.
      const newLeftBoundary: Separator = {
        id: crypto.randomUUID(),
        position_cm: 0,
        type: 'virtual',
        movable: false,
      };

      // Add internal separators in the new region `(0, shiftAmt)` at regular
      // intervals so the inserted region is split into evenly sized empty boxes.
      const extraSeps: Separator[] = [];
      let pos = colSpacing;
      while (pos < shiftAmt - MIN_BOX_CM) {
        extraSeps.push({
          id: crypto.randomUUID(),
          position_cm: pos,
          type: 'virtual',
          movable: true,
        });
        pos += colSpacing;
      }

      return {
        ...shelf,
        separators: [newLeftBoundary, ...extraSeps, ...shifted],
      };
    }),
  };
}

/**
 * §4 Shrink gondola width from the LEFT: removes the leftmost column(s) from every
 * shelf until the gondola reaches `targetWidthCm`, shifting the remaining columns
 * left and keeping the right boundary anchored. This is the left-anchored mirror
 * of `shrinkGondolaWidth`, used to keep the opposite gondola face in sync when a
 * column is removed from the right of the active face.
 *
 * Product placements whose left or right separator is removed are discarded.
 * No-op when `targetWidthCm >= gondola.width_cm`.
 */
export function shrinkGondolaWidthLeft(gondola: Gondola, targetWidthCm: number): Gondola {
  const delta = gondola.width_cm - targetWidthCm;
  if (delta <= MIN_BOX_CM / 2) return gondola;

  const shelves = gondola.shelves.map((shelf) => {
    const sorted = [...shelf.separators].sort((a, b) => a.position_cm - b.position_cm);
    if (sorted.length < 2) return shelf;

    // Keep all separators strictly right of `delta` (they become the surviving
    // interior + right boundary once shifted left), plus a fresh left boundary at 0.
    const survivors = sorted
      .slice(1) // drop the current left boundary
      .filter((sep) => sep.position_cm > delta)
      .map((sep) => ({
        ...sep,
        position_cm: sep.position_cm - delta,
      }));

    if (survivors.length === 0) return shelf; // nothing left to keep — leave unchanged

    const newLeftBoundary: Separator = {
      ...sorted[0],
      position_cm: 0,
      movable: false,
      type: 'virtual',
    };
    // Ensure the right-most survivor is a fixed boundary at the target width.
    const last = survivors[survivors.length - 1];
    survivors[survivors.length - 1] = {
      ...last,
      position_cm: targetWidthCm,
      movable: false,
      type: 'virtual',
    };

    return { ...shelf, separators: [newLeftBoundary, ...survivors] };
  });

  // Drop product placements whose left or right separator was removed.
  const productPlacements = gondola.productPlacements.filter((p) => {
    const shelf = shelves.find((s) => s.id === p.shelfId);
    if (!shelf) return true;
    const leftSep = shelf.separators.find((s) => s.id === p.leftSeparatorId);
    const rightSep = shelf.separators.find((s) => s.id === p.rightSeparatorId);
    return leftSep !== undefined && rightSep !== undefined;
  });

  return { ...gondola, width_cm: targetWidthCm, shelves, productPlacements };
}

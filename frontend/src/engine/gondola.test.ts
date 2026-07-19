/**
 * Unit tests for the gondola engine — covers every rule in §4 of the spec.
 *
 * Run with: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import {
  computeBoxes,
  buildBoxMap,
  cmdMoveSeparator,
  cmdInsertSeparator,
  cmdRemoveSeparator,
  cmdSetPlacement,
  cmdClearPlacement,
  cmdClearAllPlacements,
  cmdAddShelf,
  cmdRemoveShelf,
  cmdResizeAdjacentShelves,
  cmdFuseBoxes,
  cmdSplitBox,
  legacyCellsToSeparators,
  gondolaToLegacyPlanogram,
  enforceInvariants,
  getShelfByDisplayIndex,
  shelfBoxCount,
  sortedSeps,
  extendGondolaHeight,
  MIN_BOX_CM,
} from './gondola';
import type { Gondola, Shelf, Separator } from '../types/gondola';
import type { Planogram } from '../types/cad';

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeShelf(id: string, height: number, positions: number[]): Shelf {
  const seps: Separator[] = positions.map((pos, i) => ({
    id: `sep-${id}-${i}`,
    position_cm: pos,
    type: 'virtual' as const,
    movable: i !== 0 && i !== positions.length - 1,
  }));
  return { id, height_cm: height, separators: seps };
}

/** Simple 2-shelf gondola: width=100, bottom shelf 30cm, top shelf 20cm.
 *  Bottom shelf (shelves[0]) has 3 boxes of 33.3 cm.
 *  Top shelf (shelves[1]) has 2 boxes of 50 cm.
 */
function makeGondola(): Gondola {
  return {
    id: 'g1',
    width_cm: 100,
    height_cm: 50,
    depth_cm: 45,
    shelves: [
      makeShelf('shelf-bot', 30, [0, 33.33, 66.66, 100]),  // 3 boxes
      makeShelf('shelf-top', 20, [0, 50, 100]),             // 2 boxes
    ],
    productPlacements: [],
  };
}

// ─── §3 computeBoxes ─────────────────────────────────────────────────────────

describe('computeBoxes', () => {
  it('produces correct number of boxes', () => {
    const g = makeGondola();
    const boxes = computeBoxes(g);
    // top shelf (displayIndex 0): 2 boxes; bottom shelf (displayIndex 1): 3 boxes
    expect(boxes.length).toBe(5);
  });

  it('assigns shelfDisplayIndex 0 to the top shelf', () => {
    const g = makeGondola();
    const boxes = computeBoxes(g);
    const topBoxes = boxes.filter((b) => b.shelfDisplayIndex === 0);
    expect(topBoxes.length).toBe(2); // top shelf has 2 boxes
    expect(topBoxes[0].shelfId).toBe('shelf-top');
  });

  it('assigns shelfDisplayIndex 1 to the bottom shelf', () => {
    const g = makeGondola();
    const boxes = computeBoxes(g);
    const botBoxes = boxes.filter((b) => b.shelfDisplayIndex === 1);
    expect(botBoxes.length).toBe(3);
    expect(botBoxes[0].shelfId).toBe('shelf-bot');
  });

  it('computes y_cm bottom-up correctly', () => {
    const g = makeGondola();
    const boxes = computeBoxes(g);
    // Bottom shelf y_cm = 0, top shelf y_cm = 30
    const botBox = boxes.find((b) => b.shelfId === 'shelf-bot');
    const topBox = boxes.find((b) => b.shelfId === 'shelf-top');
    expect(botBox?.y_cm).toBe(0);
    expect(topBox?.y_cm).toBe(30);
  });

  it('computes box width from separator positions', () => {
    const g = makeGondola();
    const boxes = computeBoxes(g);
    const topBoxes = boxes.filter((b) => b.shelfDisplayIndex === 0);
    expect(topBoxes[0].width_cm).toBeCloseTo(50);
    expect(topBoxes[1].width_cm).toBeCloseTo(50);
  });

  it('attaches product placement to the correct box', () => {
    const g = makeGondola();
    const shelf = g.shelves[1]; // top shelf (physIdx 1)
    const seps = sortedSeps(shelf);
    const withPlacement: Gondola = {
      ...g,
      productPlacements: [{
        productId: 'EAN-001',
        shelfId: shelf.id,
        leftSeparatorId: seps[0].id,
        rightSeparatorId: seps[1].id,
      }],
    };
    const boxes = computeBoxes(withPlacement);
    const box = boxes.find(
      (b) => b.shelfId === shelf.id && b.boxIndex === 0,
    );
    expect(box?.placement?.productId).toBe('EAN-001');
    // Second box should have no placement
    const box2 = boxes.find((b) => b.shelfId === shelf.id && b.boxIndex === 1);
    expect(box2?.placement).toBeUndefined();
  });

  it('pure function — does not mutate input', () => {
    const g = makeGondola();
    const original = JSON.stringify(g);
    computeBoxes(g);
    expect(JSON.stringify(g)).toBe(original);
  });
});

// ─── §4 Resize separator (§4 "Resize de cellule") ────────────────────────────

describe('cmdMoveSeparator', () => {
  it('moves a separator to a new position', () => {
    const g = makeGondola();
    const shelf = g.shelves[1]; // top shelf
    const seps = sortedSeps(shelf);
    const midSep = seps[1]; // internal separator at 50
    const updated = cmdMoveSeparator(g, shelf.id, midSep.id, 40);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    const newPos = sortedSeps(newShelf)[1].position_cm;
    expect(newPos).toBeCloseTo(40);
  });

  it('enforces MIN_BOX_CM on the left side', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const midSep = seps[1];
    // Try to move to position 0.5 (< MIN_BOX_CM from left boundary at 0)
    const updated = cmdMoveSeparator(g, shelf.id, midSep.id, 0.5);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    const newPos = sortedSeps(newShelf)[1].position_cm;
    expect(newPos).toBeGreaterThanOrEqual(MIN_BOX_CM);
  });

  it('enforces MIN_BOX_CM on the right side', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const midSep = seps[1];
    // Try to move to 99.5 (< MIN_BOX_CM from right boundary at 100)
    const updated = cmdMoveSeparator(g, shelf.id, midSep.id, 99.5);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    const newPos = sortedSeps(newShelf)[1].position_cm;
    expect(newPos).toBeLessThanOrEqual(100 - MIN_BOX_CM);
  });

  it('does not move physical/immovable separators', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const rightBoundary = seps[seps.length - 1]; // movable: false
    const updated = cmdMoveSeparator(g, shelf.id, rightBoundary.id, 80);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    const newRight = sortedSeps(newShelf)[2].position_cm;
    expect(newRight).toBe(100); // unchanged
  });

  it('is a pure function', () => {
    const g = makeGondola();
    const original = JSON.stringify(g);
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    cmdMoveSeparator(g, shelf.id, seps[1].id, 40);
    expect(JSON.stringify(g)).toBe(original);
  });
});

// ─── §4 Add cell (insert separator) ──────────────────────────────────────────

describe('cmdInsertSeparator', () => {
  it('adds a new box to a shelf', () => {
    const g = makeGondola();
    const shelf = g.shelves[1]; // 2 boxes
    const updated = cmdInsertSeparator(g, shelf.id, 25);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    expect(shelfBoxCount(newShelf)).toBe(3);
  });

  it('forces right boundary to gondola.width_cm after insert', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const updated = cmdInsertSeparator(g, shelf.id, 25);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    const seps = sortedSeps(newShelf);
    expect(seps[seps.length - 1].position_cm).toBe(100);
  });

  it('keeps separators sorted', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const updated = cmdInsertSeparator(g, shelf.id, 75);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    const positions = sortedSeps(newShelf).map((s) => s.position_cm);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});

// ─── §4 Delete cell / fuse (remove separator) ────────────────────────────────

describe('cmdRemoveSeparator', () => {
  it('merges two boxes', () => {
    const g = makeGondola();
    const shelf = g.shelves[1]; // 2 boxes, seps at 0, 50, 100
    const seps = sortedSeps(shelf);
    const midSep = seps[1]; // internal
    const updated = cmdRemoveSeparator(g, shelf.id, midSep.id);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    expect(shelfBoxCount(newShelf)).toBe(1);
  });

  it('removes product placements from both adjacent boxes', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const withProducts: Gondola = {
      ...g,
      productPlacements: [
        { productId: 'A', shelfId: shelf.id, leftSeparatorId: seps[0].id, rightSeparatorId: seps[1].id },
        { productId: 'B', shelfId: shelf.id, leftSeparatorId: seps[1].id, rightSeparatorId: seps[2].id },
      ],
    };
    const updated = cmdRemoveSeparator(withProducts, shelf.id, seps[1].id);
    expect(updated.productPlacements.filter((p) => p.shelfId === shelf.id)).toHaveLength(0);
  });

  it('cannot remove left boundary (position 0)', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const leftBound = seps[0]; // position 0
    const updated = cmdRemoveSeparator(g, shelf.id, leftBound.id);
    expect(updated).toBe(g); // no change
  });

  it('cannot remove right boundary (position width_cm)', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const rightBound = seps[seps.length - 1];
    const updated = cmdRemoveSeparator(g, shelf.id, rightBound.id);
    expect(updated).toBe(g);
  });
});

// ─── §4 Product placement ─────────────────────────────────────────────────────

describe('cmdSetPlacement / cmdClearPlacement', () => {
  it('places a product in a box', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const updated = cmdSetPlacement(g, shelf.id, seps[0].id, seps[1].id, 'EAN-123');
    expect(updated.productPlacements).toHaveLength(1);
    expect(updated.productPlacements[0].productId).toBe('EAN-123');
  });

  it('replaces existing product in same box', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const g1 = cmdSetPlacement(g, shelf.id, seps[0].id, seps[1].id, 'EAN-A');
    const g2 = cmdSetPlacement(g1, shelf.id, seps[0].id, seps[1].id, 'EAN-B');
    expect(g2.productPlacements).toHaveLength(1);
    expect(g2.productPlacements[0].productId).toBe('EAN-B');
  });

  it('clears a product placement', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const g1 = cmdSetPlacement(g, shelf.id, seps[0].id, seps[1].id, 'EAN-A');
    const g2 = cmdClearPlacement(g1, shelf.id, seps[0].id, seps[1].id);
    expect(g2.productPlacements).toHaveLength(0);
  });
});

describe('cmdClearAllPlacements', () => {
  it('removes all placements', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const g1 = cmdSetPlacement(g, shelf.id, seps[0].id, seps[1].id, 'A');
    const g2 = cmdSetPlacement(g1, shelf.id, seps[1].id, seps[2].id, 'B');
    expect(cmdClearAllPlacements(g2).productPlacements).toHaveLength(0);
  });
});

// ─── §4 Add / remove shelf ─────────────────────────────────────────────────────

describe('cmdAddShelf', () => {
  it('adds a shelf and shrinks the top shelf', () => {
    const g = makeGondola(); // top shelf: 20 cm
    const updated = cmdAddShelf(g, 10);
    expect(updated.shelves.length).toBe(3);
    // Top physical shelf (shelves[2]) should be new
    const topShelf = updated.shelves[updated.shelves.length - 1];
    expect(topShelf.height_cm).toBe(10);
    // Previous top shelf (now shelves[1]) should have been shrunk by 10
    const previousTop = updated.shelves[updated.shelves.length - 2];
    expect(previousTop.height_cm).toBeCloseTo(10); // was 20, now 20-10
  });

  it('blocks when top shelf has insufficient height', () => {
    const g = makeGondola(); // top shelf: 20 cm
    // Requesting more than available (20 cm - MIN_BOX_CM)
    const updated = cmdAddShelf(g, 19);
    expect(updated.shelves.length).toBe(2); // unchanged
  });

  it('total height stays fixed', () => {
    const g = makeGondola(); // height_cm = 50
    const updated = cmdAddShelf(g, 5);
    const totalH = updated.shelves.reduce((acc, s) => acc + s.height_cm, 0);
    expect(totalH).toBeCloseTo(50);
  });
});

describe('cmdRemoveShelf', () => {
  it('removes a shelf and gives its height to the shelf above', () => {
    const g = makeGondola();
    const botShelf = g.shelves[0]; // 30 cm
    const updated = cmdRemoveShelf(g, botShelf.id);
    expect(updated.shelves.length).toBe(1);
    // Top shelf absorbs the removed shelf's height: 20 + 30 = 50
    expect(updated.shelves[0].height_cm).toBeCloseTo(50);
  });

  it('cannot remove the last shelf', () => {
    const g: Gondola = {
      ...makeGondola(),
      shelves: [makeGondola().shelves[0]],
    };
    const updated = cmdRemoveShelf(g, g.shelves[0].id);
    expect(updated).toBe(g);
  });

  it('removes all placements on the deleted shelf', () => {
    const g = makeGondola();
    const botShelf = g.shelves[0];
    const seps = sortedSeps(botShelf);
    const g1 = cmdSetPlacement(g, botShelf.id, seps[0].id, seps[1].id, 'X');
    const updated = cmdRemoveShelf(g1, botShelf.id);
    expect(updated.productPlacements.filter((p) => p.shelfId === botShelf.id)).toHaveLength(0);
  });
});

// ─── §4 extendGondolaHeight ───────────────────────────────────────────────────

describe('extendGondolaHeight', () => {
  it('appends a new shelf at the top', () => {
    const g = makeGondola(); // 2 shelves, height=50
    const updated = extendGondolaHeight(g, 15);
    expect(updated.shelves.length).toBe(3);
    // New shelf is at the top (last in bottom-up array)
    const newTop = updated.shelves[updated.shelves.length - 1];
    expect(newTop.height_cm).toBeCloseTo(15);
  });

  it('grows total height_cm by the new shelf height', () => {
    const g = makeGondola(); // height_cm = 50
    const updated = extendGondolaHeight(g, 15);
    expect(updated.height_cm).toBeCloseTo(65);
    const sumH = updated.shelves.reduce((acc, s) => acc + s.height_cm, 0);
    expect(sumH).toBeCloseTo(65);
  });

  it('leaves existing shelves unchanged', () => {
    const g = makeGondola();
    const updated = extendGondolaHeight(g, 20);
    expect(updated.shelves[0].height_cm).toBeCloseTo(g.shelves[0].height_cm);
    expect(updated.shelves[1].height_cm).toBeCloseTo(g.shelves[1].height_cm);
  });

  it('inserts above a specified shelf when insertAboveShelfId is provided', () => {
    const g = makeGondola(); // shelves[0]=bottom(30), shelves[1]=top(20)
    const botShelf = g.shelves[0];
    const updated = extendGondolaHeight(g, 10, botShelf.id);
    expect(updated.shelves.length).toBe(3);
    // New shelf should be at index 1 (just above bottom shelf)
    expect(updated.shelves[1].height_cm).toBeCloseTo(10);
    // Bottom and top shelves should be unchanged
    expect(updated.shelves[0].height_cm).toBeCloseTo(30);
    expect(updated.shelves[2].height_cm).toBeCloseTo(20);
  });

  it('falls back to inserting at top for unknown insertAboveShelfId', () => {
    const g = makeGondola();
    const updated = extendGondolaHeight(g, 10, 'nonexistent-id');
    expect(updated.shelves.length).toBe(3);
    expect(updated.shelves[updated.shelves.length - 1].height_cm).toBeCloseTo(10);
  });
});

// ─── §4 Resize shelves ─────────────────────────────────────────────────────────

describe('cmdResizeAdjacentShelves', () => {
  it('updates both shelf heights', () => {
    const g = makeGondola();
    const s1 = g.shelves[1].id; // top
    const s2 = g.shelves[0].id; // bottom
    const updated = cmdResizeAdjacentShelves(g, s1, 15, s2, 35);
    expect(updated.shelves.find((s) => s.id === s1)?.height_cm).toBeCloseTo(15);
    expect(updated.shelves.find((s) => s.id === s2)?.height_cm).toBeCloseTo(35);
  });

  it('enforces MIN_BOX_CM on each shelf', () => {
    const g = makeGondola();
    const s1 = g.shelves[1].id;
    const s2 = g.shelves[0].id;
    const updated = cmdResizeAdjacentShelves(g, s1, 0, s2, 50);
    expect(updated.shelves.find((s) => s.id === s1)?.height_cm).toBeGreaterThanOrEqual(MIN_BOX_CM);
  });
});

// ─── §4 Fuse facings ─────────────────────────────────────────────────────────

describe('cmdFuseBoxes', () => {
  it('removes internal separators and merges boxes', () => {
    const g = makeGondola();
    const shelf = g.shelves[0]; // 3 boxes
    const seps = sortedSeps(shelf);
    // Fuse all 3 boxes into 1
    const updated = cmdFuseBoxes(g, shelf.id, seps[0].id, seps[3].id);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    expect(shelfBoxCount(newShelf)).toBe(1);
  });

  it('removes product placements from fused boxes', () => {
    const g = makeGondola();
    const shelf = g.shelves[0];
    const seps = sortedSeps(shelf);
    const g1 = cmdSetPlacement(g, shelf.id, seps[0].id, seps[1].id, 'A');
    const g2 = cmdSetPlacement(g1, shelf.id, seps[1].id, seps[2].id, 'B');
    const updated = cmdFuseBoxes(g2, shelf.id, seps[0].id, seps[3].id);
    expect(updated.productPlacements.filter((p) => p.shelfId === shelf.id)).toHaveLength(0);
  });
});

// ─── §4 Split facing ─────────────────────────────────────────────────────────

describe('cmdSplitBox', () => {
  it('splits a box into two', () => {
    const g = makeGondola();
    const shelf = g.shelves[1]; // 2 boxes (seps at 0, 50, 100)
    const seps = sortedSeps(shelf);
    const updated = cmdSplitBox(g, shelf.id, seps[0].id, seps[1].id, 25);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    expect(shelfBoxCount(newShelf)).toBe(3);
  });

  it('moves product placement to the left sub-box after split', () => {
    const g = makeGondola();
    const shelf = g.shelves[1];
    const seps = sortedSeps(shelf);
    const g1 = cmdSetPlacement(g, shelf.id, seps[0].id, seps[1].id, 'X');
    const updated = cmdSplitBox(g1, shelf.id, seps[0].id, seps[1].id, 25);
    const placements = updated.productPlacements.filter((p) => p.shelfId === shelf.id);
    // Exactly one placement must survive, on the left sub-box.
    expect(placements).toHaveLength(1);
    expect(placements[0].leftSeparatorId).toBe(seps[0].id);
    expect(placements[0].productId).toBe('X');
    // The right separator of the surviving placement must be the new (split) separator.
    expect(placements[0].rightSeparatorId).not.toBe(seps[1].id);
  });

  it('enforces MIN_BOX_CM on each half', () => {
    const g = makeGondola();
    const shelf = g.shelves[1]; // 50 cm wide box
    const seps = sortedSeps(shelf);
    // Try to split at position 0.5 (too close to left boundary)
    const updated = cmdSplitBox(g, shelf.id, seps[0].id, seps[1].id, 0.5);
    const newShelf = updated.shelves.find((s) => s.id === shelf.id)!;
    const newSeps = sortedSeps(newShelf);
    const splitPos = newSeps[1].position_cm;
    expect(splitPos).toBeGreaterThanOrEqual(MIN_BOX_CM);
    expect(50 - splitPos).toBeGreaterThanOrEqual(MIN_BOX_CM);
  });
});

// ─── §6 enforceInvariants ────────────────────────────────────────────────────

describe('enforceInvariants', () => {
  it('forces leftmost separator to 0', () => {
    const g = makeGondola();
    // Artificially move left boundary away from 0
    const mutated: Gondola = {
      ...g,
      shelves: g.shelves.map((s) => ({
        ...s,
        separators: s.separators.map((sep, i) => (i === 0 ? { ...sep, position_cm: 5 } : sep)),
      })),
    };
    const fixed = enforceInvariants(mutated);
    for (const shelf of fixed.shelves) {
      const seps = sortedSeps(shelf);
      expect(seps[0].position_cm).toBe(0);
    }
  });

  it('forces rightmost separator to gondola.width_cm', () => {
    const g = makeGondola();
    const mutated: Gondola = {
      ...g,
      shelves: g.shelves.map((s) => ({
        ...s,
        separators: s.separators.map((sep) =>
          sep.position_cm >= 99 ? { ...sep, position_cm: 95 } : sep,
        ),
      })),
    };
    const fixed = enforceInvariants(mutated);
    for (const shelf of fixed.shelves) {
      const seps = sortedSeps(shelf);
      expect(seps[seps.length - 1].position_cm).toBe(100);
    }
  });
});

// ─── §6 Migration: legacyCellsToSeparators ───────────────────────────────────

describe('legacyCellsToSeparators', () => {
  const legacyPlanogram: Planogram = {
    id: 'p1',
    name: 'Test',
    furnitureId: 'f1',
    face: 'front',
    rows: 2,
    cols: 3,
    widthCm: 90,
    heightCm: 60,
    cells: [
      { id: 'c1', ean: 'EAN-A', row: 0, col: 0, rotation: 0 },
      { id: 'c2', ean: 'EAN-B', row: 1, col: 2, rotation: 0 },
    ],
  };

  it('creates the correct number of shelves', () => {
    const g = legacyCellsToSeparators(legacyPlanogram);
    expect(g.shelves.length).toBe(2);
  });

  it('maps row 0 (top display) to the top physical shelf (physIdx=1)', () => {
    const g = legacyCellsToSeparators(legacyPlanogram);
    // physIdx 0 = bottom, physIdx 1 = top
    // display row 0 → physIdx = rows-1-0 = 1 → shelves[1]
    const topShelf = g.shelves[1];
    expect(topShelf).toBeDefined();
    // top shelf should have 3 boxes (cols=3, 4 separators)
    expect(topShelf.separators.length).toBe(4);
  });

  it('preserves product placements in correct boxes', () => {
    const g = legacyCellsToSeparators(legacyPlanogram);
    // c1: row=0,col=0 → top shelf, box 0
    const topShelf = g.shelves[1];
    const topSeps = sortedSeps(topShelf);
    const placement = g.productPlacements.find(
      (p) => p.shelfId === topShelf.id && p.leftSeparatorId === topSeps[0].id,
    );
    expect(placement?.productId).toBe('EAN-A');
  });

  it('preserves gondola dimensions', () => {
    const g = legacyCellsToSeparators(legacyPlanogram);
    expect(g.width_cm).toBe(90);
    expect(g.height_cm).toBe(60);
  });

  it('separator positions sum to gondola width', () => {
    const g = legacyCellsToSeparators(legacyPlanogram);
    for (const shelf of g.shelves) {
      const seps = sortedSeps(shelf);
      expect(seps[0].position_cm).toBe(0);
      expect(seps[seps.length - 1].position_cm).toBe(90);
    }
  });
});

// ─── §6 Migration: gondolaToLegacyPlanogram ───────────────────────────────────

describe('gondolaToLegacyPlanogram', () => {
  it('round-trips: legacy → gondola → legacy preserves cell EANs', () => {
    const legacyPlanogram: Planogram = {
      id: 'p2',
      name: 'RT',
      furnitureId: 'f1',
      face: 'front',
      rows: 2,
      cols: 2,
      widthCm: 100,
      heightCm: 50,
      cells: [
        { id: 'c1', ean: 'X1', row: 0, col: 0, rotation: 0 },
        { id: 'c2', ean: 'X2', row: 1, col: 1, rotation: 0 },
      ],
    };
    const g = legacyCellsToSeparators(legacyPlanogram);
    const base = {
      id: legacyPlanogram.id,
      name: legacyPlanogram.name,
      furnitureId: legacyPlanogram.furnitureId,
      face: legacyPlanogram.face,
    };
    const result = gondolaToLegacyPlanogram(g, base);
    const eans = result.cells.map((c) => c.ean).sort();
    expect(eans).toEqual(['X1', 'X2']);
  });

  it('populates rowHeightsCm', () => {
    const g = makeGondola();
    const result = gondolaToLegacyPlanogram(g, {
      id: 'g1', name: 'G', furnitureId: 'f', face: 'front',
    });
    expect(result.rowHeightsCm).toBeDefined();
    expect(result.rowHeightsCm?.length).toBe(2);
  });

  it('populates cellWidthOverrides for all boxes', () => {
    const g = makeGondola();
    const result = gondolaToLegacyPlanogram(g, {
      id: 'g1', name: 'G', furnitureId: 'f', face: 'front',
    });
    // 5 boxes total: overrides for all
    expect(Object.keys(result.cellWidthOverrides ?? {})).toHaveLength(5);
  });

  it('embeds gondola in the returned planogram', () => {
    const g = makeGondola();
    const result = gondolaToLegacyPlanogram(g, {
      id: 'g1', name: 'G', furnitureId: 'f', face: 'front',
    });
    expect(result.gondola).toBe(g);
  });
});

// ─── buildBoxMap ──────────────────────────────────────────────────────────────

describe('buildBoxMap', () => {
  it('creates a map keyed by displayRow-boxIdx', () => {
    const g = makeGondola();
    const boxes = computeBoxes(g);
    const map = buildBoxMap(boxes);
    expect(map.get('0-0')).toBeDefined();
    expect(map.get('0-1')).toBeDefined();
    expect(map.get('1-0')).toBeDefined();
    expect(map.get('1-2')).toBeDefined();
    expect(map.get('2-0')).toBeUndefined();
  });
});

// ─── getShelfByDisplayIndex ───────────────────────────────────────────────────

describe('getShelfByDisplayIndex', () => {
  it('returns the top shelf for displayIndex 0', () => {
    const g = makeGondola();
    const shelf = getShelfByDisplayIndex(g, 0);
    // shelves[1] is the top physical shelf
    expect(shelf?.id).toBe('shelf-top');
  });

  it('returns the bottom shelf for displayIndex N-1', () => {
    const g = makeGondola();
    const shelf = getShelfByDisplayIndex(g, 1);
    expect(shelf?.id).toBe('shelf-bot');
  });

  it('returns undefined for out-of-range', () => {
    const g = makeGondola();
    expect(getShelfByDisplayIndex(g, 99)).toBeUndefined();
  });
});

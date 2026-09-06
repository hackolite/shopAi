import type { Planogram, PlanogramCell } from '../types/cad';
import { cellRectCm, columnAtRatio, rowCellCount } from './planogramLayout';

export type NavigationDirection = 'up' | 'down' | 'left' | 'right';

/** Map a keyboard event key to a navigation direction, or null. */
export function directionFromKey(key: string): NavigationDirection | null {
  switch (key) {
    case 'ArrowUp':    return 'up';
    case 'ArrowDown':  return 'down';
    case 'ArrowLeft':  return 'left';
    case 'ArrowRight': return 'right';
    default:           return null;
  }
}

function cellAt(planogram: Planogram, row: number, col: number): PlanogramCell | null {
  return planogram.cells.find((cell) => cell.row === row && cell.col === col) ?? null;
}

/** Nearest occupied cell of `row` around the target column (ties go left). */
function nearestCellInRow(planogram: Planogram, row: number, targetCol: number): PlanogramCell | null {
  let best: PlanogramCell | null = null;
  let bestDistance = Infinity;
  for (const cell of planogram.cells) {
    if (cell.row !== row) continue;
    const distance = Math.abs(cell.col - targetCol);
    if (distance < bestDistance || (distance === bestDistance && best !== null && cell.col < best.col)) {
      best = cell;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Cell reached from `cellId` when navigating in `direction` on the 3D face
 * (row 0 is the top shelf, column 0 the left end of the drawn texture).
 *
 * Horizontal moves step through the same row, skipping empty slots.  Vertical
 * moves land on the column of the adjacent row whose horizontal span contains
 * the centre of the current cell — rows may have different column counts and
 * widths — falling back to the nearest occupied cell of that row.  Returns
 * null when there is nowhere to go (edge of the planogram, empty rows…).
 */
export function navigatePlanogramCell(
  planogram: Planogram,
  cellId: string,
  direction: NavigationDirection,
): PlanogramCell | null {
  const current = planogram.cells.find((cell) => cell.id === cellId);
  if (!current) return null;

  if (direction === 'left' || direction === 'right') {
    const step = direction === 'left' ? -1 : 1;
    const count = rowCellCount(planogram, current.row);
    for (let col = current.col + step; col >= 0 && col < count; col += step) {
      const cell = cellAt(planogram, current.row, col);
      if (cell) return cell;
    }
    return null;
  }

  const step = direction === 'up' ? -1 : 1;
  const { xCm, widthCm } = cellRectCm(planogram, current.row, current.col);
  const centerRatio = (xCm + widthCm / 2) / Math.max(1, planogram.widthCm);
  for (let row = current.row + step; row >= 0 && row < planogram.rows; row += step) {
    const col = columnAtRatio(planogram, row, centerRatio);
    const cell = cellAt(planogram, row, col) ?? nearestCellInRow(planogram, row, col);
    if (cell) return cell;
  }
  return null;
}

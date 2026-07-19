import { useState, useEffect, useRef, Fragment } from 'react';
import { usePlanogramStore } from '../../store/planogramStore';
import { useCatalogStore } from '../../store/catalogStore';
import { useSceneStore } from '../../store/sceneStore';
import { cadApi } from '../../api/cad';
import { OVERFLOW_TOLERANCE_CM } from '../../types/cad';
import type { CADProduct, Planogram, PlanogramCell } from '../../types/cad';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  'Épicerie':  '#F5C518',
  'Boissons':  '#2196F3',
  'Frais':     '#4CAF50',
  'Hygiène':   '#9C27B0',
  'Bébé':      '#FF9800',
  'Promotion': '#F44336',
};

/** Min / max cell pixel widths and height ratios for the planogram grid. */
const CELL_MIN_PX     = 48;
/** Width scale: multiply physical cm-per-col by this to get pixel width. */
const CELL_WIDTH_SCALE  = 1.2;
/** Height scale: multiply physical cm-per-row by this to get pixel height. */
const CELL_HEIGHT_SCALE = 0.6;

/** Minimum cell physical size (cm) enforced during drag-resize. */
const MIN_CELL_CM_W = 2;
const MIN_CELL_CM_H = 2;
/** Width/height (px) of resize handle strips between columns and rows. */
const RESIZE_HANDLE_PX = 4;
/** Tooltip position offset from the cursor (px) during resize. */
const RESIZE_TOOLTIP_DX = 14;
const RESIZE_TOOLTIP_DY = -28;
/** Snap threshold in pixels: when a cell edge is within this distance of a global column boundary, it snaps. */
const SNAP_THRESHOLD_PX = 12;

/** Returns per-column widths in cm, falling back to equal distribution. */
function getEffectiveColWidths(p: { cols: number; widthCm: number; colWidthsCm?: number[] }): number[] {
  return p.colWidthsCm?.length === p.cols
    ? p.colWidthsCm
    : Array(p.cols).fill(p.widthCm / p.cols);
}

/** Returns per-row heights in cm, falling back to equal distribution. */
function getEffectiveRowHeights(p: { rows: number; heightCm: number; rowHeightsCm?: number[] }): number[] {
  return p.rowHeightsCm?.length === p.rows
    ? p.rowHeightsCm
    : Array(p.rows).fill(p.heightCm / p.rows);
}

/**
 * Returns cumulative column boundary positions in cm.
 * boundaries[0] = 0 (left edge), boundaries[c+1] = sum of widths 0..c.
 * Used for snap-to-column-boundary when resizing cells.
 */
function getColBoundariesCm(p: Planogram): number[] {
  const widths = getEffectiveColWidths(p);
  const boundaries: number[] = [0];
  let cum = 0;
  for (const w of widths) {
    cum += w;
    boundaries.push(cum);
  }
  return boundaries;
}

/**
 * Returns cumulative row boundary positions in cm.
 * boundaries[0] = 0 (top edge), boundaries[r+1] = sum of heights 0..r.
 * Used for snap-to-row-boundary when resizing cells vertically.
 */
function getRowBoundariesCm(p: Planogram): number[] {
  const heights = getEffectiveRowHeights(p);
  const boundaries: number[] = [0];
  let cum = 0;
  for (const h of heights) {
    cum += h;
    boundaries.push(cum);
  }
  return boundaries;
}

/**
 * Snaps `valueCm` to the nearest entry in `boundaries` if it is within
 * `thresholdCm`; returns the snapped value (or `valueCm` if nothing is close).
 * Also returns the index of the snapped boundary (-1 when no snap).
 */
function snapCmToBoundary(
  valueCm: number,
  boundaries: number[],
  thresholdCm: number,
): { snapped: number; idx: number } {
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

/** Zoom control bounds and step for the planogram view. */
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 4;
const ZOOM_STEP = 0.25;

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? '#9E9E9E';
}

type CellMap = Map<string, PlanogramCell>;

function buildCellMap(cells: PlanogramCell[]): CellMap {
  const map = new Map<string, PlanogramCell>();
  for (const cell of cells) map.set(`${cell.row}-${cell.col}`, cell);
  return map;
}

/** Default SVG thumbnail shown when a product has no imageUrl. */
function DefaultThumb({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: '100%', height: '100%' }}
    >
      <rect x="2" y="2" width="36" height="36" rx="3" fill={color + '33'} stroke={color} strokeWidth="1.5" />
      <rect x="8" y="12" width="24" height="3" rx="1.5" fill={color + 'aa'} />
      <rect x="8" y="19" width="18" height="2" rx="1" fill={color + '77'} />
      <rect x="8" y="25" width="14" height="2" rx="1" fill={color + '55'} />
    </svg>
  );
}

/** Product thumbnail: shows imageUrl if available, otherwise a colored SVG. */
function ProductThumb({ product }: { product: CADProduct }) {
  const color = getCategoryColor(product.category);
  const [imgError, setImgError] = useState(false);
  if (product.imageUrl && !imgError) {
    return (
      <img
        src={product.imageUrl}
        alt={product.name}
        className="w-full h-full object-contain"
        onError={() => setImgError(true)}
      />
    );
  }
  return <DefaultThumb color={color} />;
}

interface PlanogramEditorProps {
  projectId: string | null;
  planogramId: string;
  onClose: () => void;
}

export default function PlanogramEditor({ projectId, planogramId, onClose }: PlanogramEditorProps) {
  const [planogram, setPlanogram] = useState<Planogram | null>(null);
  const [cellMap,   setCellMap]   = useState<CellMap>(new Map());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [history,   setHistory]   = useState<Planogram[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [dragOver,  setDragOver]  = useState<string | null>(null);
  const [uploadingEan, setUploadingEan] = useState<string | null>(null);
  /** Zoom multiplier: 1 = default, max 3. */
  const [zoom, setZoom] = useState(1.5);
  /** Local per-column widths (cm) while a column resize drag is in progress. */
  const [localColWidths,  setLocalColWidths]  = useState<number[] | null>(null);
  /** Local per-row heights (cm) while a row resize drag is in progress. */
  const [localRowHeights, setLocalRowHeights] = useState<number[] | null>(null);
  /** Which axis is currently being resized (used for cursor management). */
  const [isResizing, setIsResizing] = useState<'col' | 'row' | null>(null);
  /** Floating tooltip shown near cursor during resize (dimension in cm). */
  const [resizeTooltip, setResizeTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  /** Per-cell width overrides (live preview during cell-specific drag). Key: "row-col". */
  const [localCellWidthOverrides,  setLocalCellWidthOverrides]  = useState<Record<string, number> | null>(null);
  /** Per-cell height overrides (live preview during cell-specific drag). Key: "row-col". */
  const [localCellHeightOverrides, setLocalCellHeightOverrides] = useState<Record<string, number> | null>(null);
  /** Index of the column selected by clicking its header label (null = none). */
  const [selectedHeaderCol, setSelectedHeaderCol] = useState<number | null>(null);
  /** Index of the row selected by clicking its header label (null = none). */
  const [selectedHeaderRow, setSelectedHeaderRow] = useState<number | null>(null);
  /**
   * Index of the global column boundary (0..cols) that is currently being snapped to
   * during a per-cell width resize drag. Boundary i+1 is between col i and col i+1.
   * Used to highlight the corresponding column-header separator.
   */
  const [activeSnapBoundary, setActiveSnapBoundary] = useState<number | null>(null);
  /**
   * Index of the global row boundary (0..rows) that is currently being snapped to
   * during a per-cell height resize drag.
   */
  const [activeRowSnapBoundary, setActiveRowSnapBoundary] = useState<number | null>(null);

  // ── Redo stack (cleared on every new action) ─────────────────────────────
  const [future, setFuture] = useState<Planogram[]>([]);
  // ── Multi-selection (Ctrl+click / Shift+click) ───────────────────────────
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  // ── Internal drag (cell → cell move/swap) ────────────────────────────────
  const internalDragSrcRef = useRef<{ row: number; col: number; ean: string } | null>(null);
  const [internalDragOver, setInternalDragOver] = useState<string | null>(null);
  // ── Crush navigation ─────────────────────────────────────────────────────
  const [crushNavIdx, setCrushNavIdx] = useState(0);
  // ── AddRow dialog (suggest auto-shrink top row) ──────────────────────────
  const [addRowDialog, setAddRowDialog] = useState<{
    canAutoFix: boolean;
    topRowH: number;
    needed: number;
  } | null>(null);
  // ── Clear-all confirmation ────────────────────────────────────────────────
  const [clearAllConfirm, setClearAllConfirm] = useState(false);

  const saveTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadInputRef  = useRef<HTMLInputElement>(null);
  /** Stores the EAN to upload for when the file input fires. */
  const pendingUploadEan = useRef<string | null>(null);

  const { setActivePlanogram } = usePlanogramStore();
  const { products, selectedEan, addRecentlyUsed, setProducts } = useCatalogStore();
  const { scene } = useSceneStore();

  const productByEan = new Map(products.map((p) => [p.ean, p] as const));

  // ── Physical cell dimensions (cm) ────────────────────────────────────────
  const physCellW = planogram ? planogram.widthCm  / planogram.cols : 0;
  const physCellH = planogram ? planogram.heightCm / planogram.rows : 0;

  // ── Overflow detection ───────────────────────────────────────────────────
  const furniture = planogram
    ? scene?.furniture.find(f => f.id === planogram.furnitureId)
    : null;

  const isOverflowing = planogram && furniture
    ? planogram.widthCm  > furniture.dimensions.width  + OVERFLOW_TOLERANCE_CM ||
      planogram.heightCm > furniture.dimensions.height + OVERFLOW_TOLERANCE_CM
    : false;

  // ── Add-row / add-col guards (stay within 3D furniture bounds) ───────────
  // How much gondola space is still available beyond the current planogram size
  const gondolaRemainingW: number = (planogram && furniture)
    ? furniture.dimensions.width  + OVERFLOW_TOLERANCE_CM - planogram.widthCm
    : Infinity;
  const gondolaRemainingH: number = (planogram && furniture)
    ? furniture.dimensions.height + OVERFLOW_TOLERANCE_CM - planogram.heightCm
    : Infinity;

  // Default width/height for a new column/row: average cell size capped at remaining gondola space
  const newColWidthCm  = planogram ? Math.max(MIN_CELL_CM_W, Math.min(physCellW, gondolaRemainingW))  : 0;
  const newRowHeightCm = planogram ? Math.max(MIN_CELL_CM_H, Math.min(physCellH, gondolaRemainingH)) : 0;

  const canAddCol = planogram ? gondolaRemainingW >= MIN_CELL_CM_W : false;
  const canAddRow = planogram ? gondolaRemainingH >= MIN_CELL_CM_H : false;

  // ── Load planogram ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setSelectedKey(null);
    cadApi.getPlanogram(projectId, planogramId)
      .then((p) => {
        setPlanogram(p);
        setCellMap(buildCellMap(p.cells));
        setActivePlanogram(p);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId, planogramId, setActivePlanogram]);

  // ── Auto-save ────────────────────────────────────────────────────────────
  const scheduleSave = (updated: Planogram) => {
    if (!projectId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      cadApi.updatePlanogram(projectId, updated.id, updated).catch(console.error);
    }, 500);
  };

  const applyUpdate = (updated: Planogram) => {
    setPlanogram(updated);
    setCellMap(buildCellMap(updated.cells));
    setActivePlanogram(updated);
    setFuture([]); // every new action clears the redo stack
    scheduleSave(updated);
  };

  const fillCellWithEan = (row: number, col: number, ean: string) => {
    if (!planogram) return;
    const key      = `${row}-${col}`;
    const existing = cellMap.get(key);
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const newCell: PlanogramCell = {
      id: existing?.id ?? crypto.randomUUID(),
      ean, row, col, rotation: 0,
    };
    const newCells = existing
      ? planogram.cells.map((c) => (c.row === row && c.col === col ? newCell : c))
      : [...planogram.cells, newCell];
    applyUpdate({ ...planogram, cells: newCells });
    addRecentlyUsed(ean);
  };

  const clearCell = (row: number, col: number) => {
    if (!planogram) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const newCells = planogram.cells.filter((c) => !(c.row === row && c.col === col));
    applyUpdate({ ...planogram, cells: newCells });
    setSelectedKey(null);
    setSelectedKeys(new Set());
  };

  /** Move a product from src cell to dst cell; swap if dst is occupied. */
  const moveCell = (srcRow: number, srcCol: number, dstRow: number, dstCol: number) => {
    if (!planogram) return;
    if (srcRow === dstRow && srcCol === dstCol) return;
    const srcCell = cellMap.get(`${srcRow}-${srcCol}`);
    if (!srcCell) return;
    const dstCell = cellMap.get(`${dstRow}-${dstCol}`);
    setHistory((prev) => [...prev.slice(-20), planogram]);
    let newCells = planogram.cells.filter(
      (c) => !(c.row === srcRow && c.col === srcCol) && !(c.row === dstRow && c.col === dstCol),
    );
    newCells = [
      ...newCells,
      { ...srcCell, row: dstRow, col: dstCol },
      ...(dstCell ? [{ ...dstCell, row: srcRow, col: srcCol }] : []),
    ];
    applyUpdate({ ...planogram, cells: newCells });
  };

  /** Remove products from all selected cells in a single undo-able transaction. */
  const clearSelectedCells = () => {
    if (!planogram || selectedKeys.size === 0) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const keysToRemove = selectedKeys;
    const newCells = planogram.cells.filter(
      (c) => !keysToRemove.has(`${c.row}-${c.col}`),
    );
    applyUpdate({ ...planogram, cells: newCells });
    setSelectedKey(null);
    setSelectedKeys(new Set());
  };

  /** Remove all products from every cell in the planogram in a single undo-able transaction. */
  const clearAllCells = () => {
    if (!planogram) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    applyUpdate({ ...planogram, cells: [] });
    setSelectedKey(null);
    setSelectedKeys(new Set());
    setClearAllConfirm(false);
  };

  /** Fill all selected cells with a given EAN in a single undo-able transaction. */
  const fillSelectedCells = (ean: string) => {
    if (!planogram || selectedKeys.size === 0) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const keys = [...selectedKeys];
    let newCells = [...planogram.cells];
    for (const key of keys) {
      const [r, c] = key.split('-').map(Number);
      const existing = cellMap.get(key);
      const newCell: PlanogramCell = { id: existing?.id ?? crypto.randomUUID(), ean, row: r, col: c, rotation: 0 };
      if (existing) {
        newCells = newCells.map((cell) => (cell.row === r && cell.col === c ? newCell : cell));
      } else {
        newCells = [...newCells, newCell];
      }
    }
    applyUpdate({ ...planogram, cells: newCells });
    addRecentlyUsed(ean);
  };

  const undo = () => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      // Snapshot current state into the redo stack before restoring
      if (planogram) setFuture((f) => [...f.slice(-20), planogram]);
      setPlanogram(last);
      setCellMap(buildCellMap(last.cells));
      setActivePlanogram(last);
      scheduleSave(last);
      return prev.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture((prev) => {
      if (prev.length === 0) return prev;
      const next = prev[prev.length - 1];
      // Snapshot current state into the undo stack before restoring
      if (planogram) setHistory((h) => [...h.slice(-20), planogram]);
      setPlanogram(next);
      setCellMap(buildCellMap(next.cells));
      setActivePlanogram(next);
      scheduleSave(next);
      return prev.slice(0, -1);
    });
  };

  // ── Row / column management ──────────────────────────────────────────────
  /** Internal implementation: actually inserts the row after optional top-row shrink. */
  const _doAddRow = (shrinkTopRowBy = 0) => {
    if (!planogram) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const curHeights = getEffectiveRowHeights(planogram);
    // If we auto-shrank the top row, update its height
    const baseHeights = shrinkTopRowBy > 0
      ? curHeights.map((h, i) => (i === 0 ? h - shrinkTopRowBy : h))
      : curHeights;
    // Insert after the selected row header (or append at end if none selected).
    const insertAfter = selectedHeaderRow ?? planogram.rows - 1;
    const insertIdx = insertAfter + 1;
    const newHeights = [...baseHeights.slice(0, insertIdx), newRowHeightCm, ...baseHeights.slice(insertIdx)];
    // Shift cells and height overrides at rows >= insertIdx.
    const newCells = planogram.cells.map((c) =>
      c.row >= insertIdx ? { ...c, row: c.row + 1 } : c,
    );
    const oldOverrides = planogram.cellHeightOverrides ?? {};
    const newHeightOverrides: Record<string, number> = {};
    for (const [key, val] of Object.entries(oldOverrides)) {
      const parts = key.split('-').map(Number);
      if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
      const [r, c] = parts;
      newHeightOverrides[r >= insertIdx ? `${r + 1}-${c}` : key] = val;
    }
    const oldWidthOverrides = planogram.cellWidthOverrides ?? {};
    const newWidthOverrides: Record<string, number> = {};
    for (const [key, val] of Object.entries(oldWidthOverrides)) {
      const parts = key.split('-').map(Number);
      if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
      const [r, c] = parts;
      newWidthOverrides[r >= insertIdx ? `${r + 1}-${c}` : key] = val;
    }
    // Shift rowColCounts entries at rows >= insertIdx.
    const oldRowColCounts = planogram.rowColCounts;
    let newRowColCounts: number[] | undefined;
    if (oldRowColCounts) {
      const normalised = Array.from({ length: planogram.rows }, (_, i) => oldRowColCounts[i] ?? planogram.cols);
      newRowColCounts = [
        ...normalised.slice(0, insertIdx),
        planogram.cols,
        ...normalised.slice(insertIdx),
      ];
    }
    applyUpdate({
      ...planogram,
      rows: planogram.rows + 1,
      heightCm: planogram.heightCm + newRowHeightCm - shrinkTopRowBy,
      rowHeightsCm: newHeights,
      cells: newCells,
      cellHeightOverrides: Object.keys(newHeightOverrides).length ? newHeightOverrides : undefined,
      cellWidthOverrides: Object.keys(newWidthOverrides).length ? newWidthOverrides : undefined,
      rowColCounts: newRowColCounts,
    });
    setSelectedHeaderRow(insertIdx);
  };

  const addRow = () => {
    if (!planogram || !canAddRow) return;
    const curHeights = getEffectiveRowHeights(planogram);
    const topRowH = curHeights[0];
    const MIN_TOP_AFTER = 1; // leave at least 1 cm for top row
    // Warn if top row would become very thin after auto-shrink (future: fixed-height model)
    if (topRowH <= newRowHeightCm + MIN_TOP_AFTER) {
      const canAutoFix = topRowH - newRowHeightCm >= MIN_TOP_AFTER;
      setAddRowDialog({ canAutoFix, topRowH, needed: newRowHeightCm });
      return;
    }
    _doAddRow();
  };

  const removeRow = () => {
    if (!planogram || planogram.rows <= 1) return;
    const lastRow = planogram.rows - 1;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const curHeights = getEffectiveRowHeights(planogram);
    const removedH = curHeights[lastRow];
    applyUpdate({
      ...planogram,
      rows: planogram.rows - 1,
      heightCm: planogram.heightCm - removedH,
      rowHeightsCm: curHeights.slice(0, -1),
      cells: planogram.cells.filter((c) => c.row !== lastRow),
      rowColCounts: planogram.rowColCounts?.slice(0, -1),
    });
    if (selectedKey?.startsWith(`${lastRow}-`)) setSelectedKey(null);
  };

  // ── Add a single cell to one row (without affecting other rows) ────────────
  const addCellToRow = (r: number) => {
    if (!planogram || !canAddCol) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const currentRowCols = planogram.rowColCounts?.[r] ?? planogram.cols;
    const newColIdx = currentRowCols; // append after the last existing cell of this row
    const newWidthCm = Math.max(MIN_CELL_CM_W, newColWidthCm);
    // Build updated rowColCounts — initialise all rows to their current effective count
    const newRowColCounts: number[] = Array.from(
      { length: planogram.rows },
      (_, i) => planogram.rowColCounts?.[i] ?? planogram.cols,
    );
    newRowColCounts[r] = currentRowCols + 1;
    // Register a width override for the new extra cell
    const newCellWidthOverrides = { ...(planogram.cellWidthOverrides ?? {}) };
    newCellWidthOverrides[`${r}-${newColIdx}`] = newWidthCm;
    applyUpdate({
      ...planogram,
      rowColCounts: newRowColCounts,
      cellWidthOverrides: newCellWidthOverrides,
    });
    setSelectedHeaderRow(r);
  };

  const addCol = () => {
    if (!planogram || !canAddCol) return;
    // If a row header is selected, add a cell only to that row.
    if (selectedHeaderRow !== null) {
      addCellToRow(selectedHeaderRow);
      return;
    }
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const curWidths = getEffectiveColWidths(planogram);
    // Insert after the selected column header (or append at end if none selected).
    const insertAfter = selectedHeaderCol ?? planogram.cols - 1;
    const insertIdx = insertAfter + 1;
    const newWidths = [...curWidths.slice(0, insertIdx), newColWidthCm, ...curWidths.slice(insertIdx)];
    // Shift cells and width overrides at cols >= insertIdx.
    const newCells = planogram.cells.map((c) =>
      c.col >= insertIdx ? { ...c, col: c.col + 1 } : c,
    );
    const oldWidthOverrides = planogram.cellWidthOverrides ?? {};
    const newWidthOverrides: Record<string, number> = {};
    for (const [key, val] of Object.entries(oldWidthOverrides)) {
      const parts = key.split('-').map(Number);
      if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
      const [r, c] = parts;
      newWidthOverrides[c >= insertIdx ? `${r}-${c + 1}` : key] = val;
    }
    const oldHeightOverrides = planogram.cellHeightOverrides ?? {};
    const newHeightOverrides: Record<string, number> = {};
    for (const [key, val] of Object.entries(oldHeightOverrides)) {
      const parts = key.split('-').map(Number);
      if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
      const [r, c] = parts;
      newHeightOverrides[c >= insertIdx ? `${r}-${c + 1}` : key] = val;
    }
    // Keep rowColCounts in sync: every row gains the new global column.
    const oldRowColCounts = planogram.rowColCounts;
    const newRowColCounts = oldRowColCounts
      ? Array.from({ length: planogram.rows }, (_, i) => (oldRowColCounts[i] ?? planogram.cols) + 1)
      : undefined;
    applyUpdate({
      ...planogram,
      cols: planogram.cols + 1,
      widthCm: planogram.widthCm + newColWidthCm,
      colWidthsCm: newWidths,
      cells: newCells,
      cellWidthOverrides: Object.keys(newWidthOverrides).length ? newWidthOverrides : undefined,
      cellHeightOverrides: Object.keys(newHeightOverrides).length ? newHeightOverrides : undefined,
      rowColCounts: newRowColCounts,
    });
    setSelectedHeaderCol(insertIdx);
  };

  // ── Remove a single cell from one row (counterpart to addCellToRow) ───────────
  /**
   * Removes the last extra cell from row `r`. Only has an effect when that row
   * has more cells than the planogram's base column count (i.e. extra cells were
   * previously added via addCellToRow).
   */
  const removeCellFromRow = (r: number) => {
    if (!planogram) return;
    const currentRowCols = planogram.rowColCounts?.[r] ?? planogram.cols;
    if (currentRowCols <= 1) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const removeColIdx = currentRowCols - 1;
    const newCells = planogram.cells.filter((c) => !(c.row === r && c.col === removeColIdx));
    const newCellWidthOverrides = { ...(planogram.cellWidthOverrides ?? {}) };
    delete newCellWidthOverrides[`${r}-${removeColIdx}`];
    const newRowColCounts: number[] = Array.from(
      { length: planogram.rows },
      (_, i) => planogram.rowColCounts?.[i] ?? planogram.cols,
    );
    newRowColCounts[r] = currentRowCols - 1;
    const normalizedRowColCounts = newRowColCounts.every((c) => c === planogram.cols)
      ? undefined
      : newRowColCounts;
    applyUpdate({
      ...planogram,
      cells: newCells,
      cellWidthOverrides: Object.keys(newCellWidthOverrides).length ? newCellWidthOverrides : undefined,
      rowColCounts: normalizedRowColCounts,
    });
    if (selectedKey === `${r}-${removeColIdx}`) setSelectedKey(null);
  };

  /**
   * Parses a cell override key ("row-col") into [row, col].
   * Returns null if the key is malformed, or if either coordinate is not a
   * non-negative integer (cell coordinates must be >= 0 and whole numbers).
   * Note: Number.isInteger() returns false for NaN and floats, so no separate
   * NaN check is needed.
   */
  const parseOverrideKey = (key: string): [number, number] | null => {
    const parts = key.split('-').map(Number);
    if (
      parts.length !== 2 ||
      !Number.isInteger(parts[0]) || parts[0] < 0 ||
      !Number.isInteger(parts[1]) || parts[1] < 0
    ) return null;
    return [parts[0], parts[1]];
  };

  /**
   * After removing column `removeIdx`, updates `selectedKey` to reflect the
   * new column indices: clears the key if the removed column was selected,
   * or decrements the column index for keys beyond the removed column.
   */
  const updateSelectedKeyAfterColRemoval = (key: string | null, removeIdx: number): string | null => {
    if (!key) return key;
    const parsed = parseOverrideKey(key);
    if (!parsed) return key;
    const [r, c] = parsed;
    if (c === removeIdx) return null;
    if (c > removeIdx) return `${r}-${c - 1}`;
    return key;
  };

  const removeCol = () => {
    if (!planogram || planogram.cols <= 1) return;
    // If a row header is selected, remove the last extra cell from that row only.
    if (selectedHeaderRow !== null) {
      removeCellFromRow(selectedHeaderRow);
      return;
    }
    const removeIdx = selectedHeaderCol ?? planogram.cols - 1;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const curWidths = getEffectiveColWidths(planogram);
    const removedW = curWidths[removeIdx];

    // Remove column at removeIdx from colWidthsCm
    const newWidths = [...curWidths.slice(0, removeIdx), ...curWidths.slice(removeIdx + 1)];

    // Remove cells at removeIdx, shift cells at col > removeIdx down by 1
    const newCells = planogram.cells
      .filter((c) => c.col !== removeIdx)
      .map((c) => (c.col > removeIdx ? { ...c, col: c.col - 1 } : c));

    // Update cellWidthOverrides: drop removed col, shift col > removeIdx
    const oldWidthOverrides = planogram.cellWidthOverrides ?? {};
    const newWidthOverrides: Record<string, number> = {};
    for (const [key, val] of Object.entries(oldWidthOverrides)) {
      const parsed = parseOverrideKey(key);
      if (!parsed) continue;
      const [r, c] = parsed;
      if (c === removeIdx) continue;
      newWidthOverrides[c > removeIdx ? `${r}-${c - 1}` : key] = val;
    }

    // Update cellHeightOverrides: drop removed col, shift col > removeIdx
    const oldHeightOverrides = planogram.cellHeightOverrides ?? {};
    const newHeightOverrides: Record<string, number> = {};
    for (const [key, val] of Object.entries(oldHeightOverrides)) {
      const parsed = parseOverrideKey(key);
      if (!parsed) continue;
      const [r, c] = parsed;
      if (c === removeIdx) continue;
      newHeightOverrides[c > removeIdx ? `${r}-${c - 1}` : key] = val;
    }

    // Update rowColCounts: rows that had more columns than removeIdx lose one
    const oldRowColCounts = planogram.rowColCounts;
    let newRowColCounts: number[] | undefined;
    if (oldRowColCounts) {
      const newCols = planogram.cols - 1;
      const updated = Array.from({ length: planogram.rows }, (_, r) => {
        const effective = oldRowColCounts[r] ?? planogram.cols;
        return effective > removeIdx ? effective - 1 : effective;
      });
      newRowColCounts = updated.every((c) => c === newCols) ? undefined : updated;
    }

    applyUpdate({
      ...planogram,
      cols: planogram.cols - 1,
      widthCm: planogram.widthCm - removedW,
      colWidthsCm: newWidths,
      cells: newCells,
      cellWidthOverrides: Object.keys(newWidthOverrides).length ? newWidthOverrides : undefined,
      cellHeightOverrides: Object.keys(newHeightOverrides).length ? newHeightOverrides : undefined,
      rowColCounts: newRowColCounts,
    });

    // Update header selection
    if (selectedHeaderCol === removeIdx) {
      setSelectedHeaderCol(null);
    } else if (selectedHeaderCol !== null && selectedHeaderCol > removeIdx) {
      setSelectedHeaderCol(selectedHeaderCol - 1);
    }

    // Update cell selection if it pointed to the removed or shifted column
    setSelectedKey((prev) => updateSelectedKeyAfterColRemoval(prev, removeIdx));
  };

  // ── Image upload ─────────────────────────────────────────────────────────
  const handleImageUpload = async (ean: string, file: File) => {
    if (!projectId) return;
    setUploadingEan(ean);
    try {
      const result = await cadApi.uploadProductImage(projectId, ean, file);
      // Refresh catalog with updated imageUrl
      const updatedProducts = products.map(p =>
        p.ean === ean ? { ...p, imageUrl: result.imageUrl } : p
      );
      setProducts(updatedProducts);
    } catch (err) {
      console.error('Image upload failed:', err);
    } finally {
      setUploadingEan(null);
    }
  };

  // ── Column / row resize via drag (fixed total — redistributes between neighbours) ──
  const startColResize = (e: React.MouseEvent, colIdx: number) => {
    if (!planogram || colIdx + 1 >= planogram.cols) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidths = getEffectiveColWidths(planogram);
    const capturedPlanogram = planogram;
    const w0 = startWidths[colIdx];
    const w1 = startWidths[colIdx + 1];
    let finalWidths = [...startWidths];
    setIsResizing('col');

    const onMove = (ev: MouseEvent) => {
      const deltaCm = (ev.clientX - startX) / (CELL_WIDTH_SCALE * zoom);
      // Clamp so neither column goes below the minimum size
      const clamped = Math.max(-(w0 - MIN_CELL_CM_W), Math.min(w1 - MIN_CELL_CM_W, deltaCm));
      const newW0 = w0 + clamped;
      const newW1 = w1 - clamped;
      finalWidths = startWidths.map((w, i) => i === colIdx ? newW0 : i === colIdx + 1 ? newW1 : w);
      setLocalColWidths(finalWidths);
      setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${newW0.toFixed(1)} / ${newW1.toFixed(1)} cm` });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalColWidths(null);
      setResizeTooltip(null);
      // Total planogram width stays fixed — only colWidthsCm changes
      applyUpdate({ ...capturedPlanogram, colWidthsCm: finalWidths });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startRowResize = (e: React.MouseEvent, rowIdx: number) => {
    if (!planogram || rowIdx + 1 >= planogram.rows) return;
    e.preventDefault();
    const startY = e.clientY;
    const startHeights = getEffectiveRowHeights(planogram);
    const capturedPlanogram = planogram;
    const h0 = startHeights[rowIdx];
    const h1 = startHeights[rowIdx + 1];
    let finalHeights = [...startHeights];
    setIsResizing('row');

    const onMove = (ev: MouseEvent) => {
      const deltaCm = (ev.clientY - startY) / (CELL_HEIGHT_SCALE * zoom);
      // Clamp so neither row goes below the minimum size
      const clamped = Math.max(-(h0 - MIN_CELL_CM_H), Math.min(h1 - MIN_CELL_CM_H, deltaCm));
      const newH0 = h0 + clamped;
      const newH1 = h1 - clamped;
      finalHeights = startHeights.map((h, i) => i === rowIdx ? newH0 : i === rowIdx + 1 ? newH1 : h);
      setLocalRowHeights(finalHeights);
      setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${newH0.toFixed(1)} / ${newH1.toFixed(1)} cm` });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalRowHeights(null);
      setResizeTooltip(null);
      // Total planogram height stays fixed — only rowHeightsCm changes
      applyUpdate({ ...capturedPlanogram, rowHeightsCm: finalHeights });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Per-cell resize: only the segment belonging to this cell changes ─────
  // Width helpers used by cell drag handlers (checked before any live-preview state).
  const getCellStartWidthCm = (p: Planogram, row: number, col: number): number => {
    const key = `${row}-${col}`;
    // Extra cells (col >= p.cols) have no colWidthsCm entry; fall back to average cell width.
    // Guard against p.cols === 0 (degenerate planogram) to avoid division by zero.
    return p.cellWidthOverrides?.[key] ?? getEffectiveColWidths(p)[col] ?? Math.max(MIN_CELL_CM_W, p.cols > 0 ? p.widthCm / p.cols : MIN_CELL_CM_W);
  };
  const getCellStartHeightCm = (p: Planogram, row: number, col: number): number => {
    const key = `${row}-${col}`;
    return p.cellHeightOverrides?.[key] ?? getEffectiveRowHeights(p)[row];
  };

  // Dragging right edge: cell grows, right neighbour shrinks (this row only).
  const startCellRightResize = (e: React.MouseEvent, row: number, col: number) => {
    // Use the row's effective column count so extra-cell rows (rowColCounts) work correctly.
    const capturedRowColCount = planogram?.rowColCounts?.[row] ?? planogram?.cols ?? 0;
    if (!planogram || col + 1 >= capturedRowColCount) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const key0 = `${row}-${col}`;
    const key1 = `${row}-${col + 1}`;
    const startW0 = getCellStartWidthCm(planogram, row, col);
    const startW1 = getCellStartWidthCm(planogram, row, col + 1);
    const capturedPlanogram = planogram;
    let finalW0 = startW0;
    let finalW1 = startW1;
    setIsResizing('col');

    // Gondola width cap: only applies when the selected cell grows (enlargement).
    const gondolaMaxW = furniture?.dimensions.width ?? Infinity;
    let otherCellsW = 0;
    for (let c = 0; c < capturedRowColCount; c++) {
      if (c !== col && c !== col + 1) {
        otherCellsW += getCellStartWidthCm(capturedPlanogram, row, c);
      }
    }
    const maxDeltaByGondola = gondolaMaxW - otherCellsW - MIN_CELL_CM_W - startW0;

    // Left edge of the selected cell in cm (for snap computation of its right edge).
    let leftOffsetCm = 0;
    for (let c = 0; c < col; c++) leftOffsetCm += getCellStartWidthCm(capturedPlanogram, row, c);

    const colBoundaries = getColBoundariesCm(capturedPlanogram);

    const onMove = (ev: MouseEvent) => {
      const thresholdCm = SNAP_THRESHOLD_PX / (CELL_WIDTH_SCALE * zoom);
      const rawDeltaCm = (ev.clientX - startX) / (CELL_WIDTH_SCALE * zoom);

      // Snap the right edge of the selected cell to a global column boundary.
      const rawRightEdgeCm = leftOffsetCm + startW0 + rawDeltaCm;
      const { snapped: snappedRightEdge, idx: snapIdx } = snapCmToBoundary(rawRightEdgeCm, colBoundaries, thresholdCm);
      const effectiveDelta = snappedRightEdge - leftOffsetCm - startW0;

      setActiveSnapBoundary(snapIdx >= 0 ? snapIdx : null);

      if (effectiveDelta >= 0) {
        // Enlargement: selected cell grows to the right, right neighbour shrinks.
        const clamped = Math.max(0, Math.min(Math.min(startW1 - MIN_CELL_CM_W, maxDeltaByGondola), effectiveDelta));
        finalW0 = startW0 + clamped;
        finalW1 = startW1 - clamped;
        setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${finalW0.toFixed(1)} / ${finalW1.toFixed(1)} cm` });
      } else {
        // Reduction: selected cell shrinks, right neighbour stays unchanged.
        const clamped = Math.max(-(startW0 - MIN_CELL_CM_W), effectiveDelta);
        finalW0 = startW0 + clamped;
        finalW1 = startW1;
        setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${finalW0.toFixed(1)} cm` });
      }

      setLocalCellWidthOverrides({ ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellWidthOverrides(null);
      setResizeTooltip(null);
      setActiveSnapBoundary(null);
      applyUpdate({ ...capturedPlanogram, cellWidthOverrides: { ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 } });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Dragging left edge: enlargement grows the selected cell and shrinks the left neighbour;
  // reduction shrinks only the selected cell without moving the left neighbour.
  const startCellLeftResize = (e: React.MouseEvent, row: number, col: number) => {
    if (!planogram || col <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const key0 = `${row}-${col - 1}`;  // left neighbour
    const key1 = `${row}-${col}`;       // selected cell
    const startW0 = getCellStartWidthCm(planogram, row, col - 1);
    const startW1 = getCellStartWidthCm(planogram, row, col);
    const capturedPlanogram = planogram;
    let finalW0 = startW0;
    let finalW1 = startW1;
    setIsResizing('col');

    // Gondola cap only applies to enlargement (selected cell growing left into the gondola).
    const gondolaMaxW = furniture?.dimensions.width ?? Infinity;
    const capturedRowColCount = capturedPlanogram.rowColCounts?.[row] ?? capturedPlanogram.cols;
    let otherCellsW = 0;
    for (let c = 0; c < capturedRowColCount; c++) {
      if (c !== col - 1 && c !== col) {
        otherCellsW += getCellStartWidthCm(capturedPlanogram, row, c);
      }
    }
    // Most-negative delta allowed before the selected cell would exceed the gondola.
    const minClampedByGondola = startW1 + otherCellsW + MIN_CELL_CM_W - gondolaMaxW;

    // Position of the left edge of the selected cell (= border between col-1 and col) in cm.
    let leftEdgeCm = 0;
    for (let c = 0; c < col; c++) leftEdgeCm += getCellStartWidthCm(capturedPlanogram, row, c);

    const colBoundaries = getColBoundariesCm(capturedPlanogram);

    const onMove = (ev: MouseEvent) => {
      const thresholdCm = SNAP_THRESHOLD_PX / (CELL_WIDTH_SCALE * zoom);
      const rawDeltaCm = (ev.clientX - startX) / (CELL_WIDTH_SCALE * zoom);

      // Snap the left edge (border between col-1 and col) to a global column boundary.
      const rawBorderCm = leftEdgeCm + rawDeltaCm;
      const { snapped: snappedBorder, idx: snapIdx } = snapCmToBoundary(rawBorderCm, colBoundaries, thresholdCm);
      const effectiveDelta = snappedBorder - leftEdgeCm;

      setActiveSnapBoundary(snapIdx >= 0 ? snapIdx : null);

      if (effectiveDelta <= 0) {
        // Enlargement: selected cell grows to the left, left neighbour shrinks.
        const clamped = Math.max(
          Math.max(-(startW0 - MIN_CELL_CM_W), minClampedByGondola),
          Math.min(0, effectiveDelta),
        );
        finalW0 = startW0 + clamped;
        finalW1 = startW1 - clamped;
        setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${finalW0.toFixed(1)} / ${finalW1.toFixed(1)} cm` });
      } else {
        // Reduction: selected cell shrinks, left neighbour stays unchanged.
        const clamped = Math.min(startW1 - MIN_CELL_CM_W, effectiveDelta);
        finalW0 = startW0;
        finalW1 = startW1 - clamped;
        setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${finalW1.toFixed(1)} cm` });
      }

      setLocalCellWidthOverrides({ ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellWidthOverrides(null);
      setResizeTooltip(null);
      setActiveSnapBoundary(null);
      applyUpdate({ ...capturedPlanogram, cellWidthOverrides: { ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 } });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Dragging bottom edge: cell grows, bottom neighbour shrinks (this column only).
  const startCellBottomResize = (e: React.MouseEvent, row: number, col: number) => {
    if (!planogram || row + 1 >= planogram.rows) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const key0 = `${row}-${col}`;
    const key1 = `${row + 1}-${col}`;
    const startH0 = getCellStartHeightCm(planogram, row, col);
    const startH1 = getCellStartHeightCm(planogram, row + 1, col);
    const capturedPlanogram = planogram;
    let finalH0 = startH0;
    let finalH1 = startH1;
    setIsResizing('row');

    // Top edge of the selected cell in cm (for snap computation of its bottom edge).
    let topOffsetCm = 0;
    for (let r = 0; r < row; r++) topOffsetCm += getCellStartHeightCm(capturedPlanogram, r, col);
    const rowBoundaries = getRowBoundariesCm(capturedPlanogram);

    const onMove = (ev: MouseEvent) => {
      const thresholdCm = SNAP_THRESHOLD_PX / (CELL_HEIGHT_SCALE * zoom);
      const rawDeltaCm = (ev.clientY - startY) / (CELL_HEIGHT_SCALE * zoom);

      // Snap the bottom edge of the selected cell to a global row boundary.
      const rawBottomEdgeCm = topOffsetCm + startH0 + rawDeltaCm;
      const { snapped: snappedBottomEdge, idx: snapRowIdx } = snapCmToBoundary(rawBottomEdgeCm, rowBoundaries, thresholdCm);
      const effectiveDelta = snappedBottomEdge - topOffsetCm - startH0;

      setActiveRowSnapBoundary(snapRowIdx >= 0 ? snapRowIdx : null);

      const clamped = Math.max(-(startH0 - MIN_CELL_CM_H), Math.min(startH1 - MIN_CELL_CM_H, effectiveDelta));
      finalH0 = startH0 + clamped;
      finalH1 = startH1 - clamped;
      setLocalCellHeightOverrides({ ...(capturedPlanogram.cellHeightOverrides ?? {}), [key0]: finalH0, [key1]: finalH1 });
      setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${finalH0.toFixed(1)} / ${finalH1.toFixed(1)} cm` });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellHeightOverrides(null);
      setResizeTooltip(null);
      setActiveRowSnapBoundary(null);
      applyUpdate({ ...capturedPlanogram, cellHeightOverrides: { ...(capturedPlanogram.cellHeightOverrides ?? {}), [key0]: finalH0, [key1]: finalH1 } });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Dragging top edge: cell grows, top neighbour shrinks (this column only).
  const startCellTopResize = (e: React.MouseEvent, row: number, col: number) => {
    if (!planogram || row <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const key0 = `${row - 1}-${col}`;
    const key1 = `${row}-${col}`;
    const startH0 = getCellStartHeightCm(planogram, row - 1, col);
    const startH1 = getCellStartHeightCm(planogram, row, col);
    const capturedPlanogram = planogram;
    let finalH0 = startH0;
    let finalH1 = startH1;
    setIsResizing('row');

    // Position of the top edge of the selected cell (= border between row-1 and row) in cm.
    let topEdgeCm = 0;
    for (let r = 0; r < row; r++) topEdgeCm += getCellStartHeightCm(capturedPlanogram, r, col);
    const rowBoundaries = getRowBoundariesCm(capturedPlanogram);

    const onMove = (ev: MouseEvent) => {
      const thresholdCm = SNAP_THRESHOLD_PX / (CELL_HEIGHT_SCALE * zoom);
      const rawDeltaCm = (ev.clientY - startY) / (CELL_HEIGHT_SCALE * zoom);

      // Snap the top border (between row-1 and row) to a global row boundary.
      const rawBorderCm = topEdgeCm + rawDeltaCm;
      const { snapped: snappedBorder, idx: snapRowIdx } = snapCmToBoundary(rawBorderCm, rowBoundaries, thresholdCm);
      const effectiveDelta = snappedBorder - topEdgeCm;

      setActiveRowSnapBoundary(snapRowIdx >= 0 ? snapRowIdx : null);

      // Dragging up (negative delta) shrinks the top neighbour, grows current
      const clamped = Math.max(-(startH0 - MIN_CELL_CM_H), Math.min(startH1 - MIN_CELL_CM_H, effectiveDelta));
      finalH0 = startH0 + clamped;
      finalH1 = startH1 - clamped;
      setLocalCellHeightOverrides({ ...(capturedPlanogram.cellHeightOverrides ?? {}), [key0]: finalH0, [key1]: finalH1 });
      setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${finalH0.toFixed(1)} / ${finalH1.toFixed(1)} cm` });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellHeightOverrides(null);
      setResizeTooltip(null);
      setActiveRowSnapBoundary(null);
      applyUpdate({ ...capturedPlanogram, cellHeightOverrides: { ...(capturedPlanogram.cellHeightOverrides ?? {}), [key0]: finalH0, [key1]: finalH1 } });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };


  // ── Prevent text selection during resize ────────────────────────────────
  useEffect(() => {
    if (isResizing) {
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  const keyHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if (
      ((e.ctrlKey || e.metaKey) && e.key === 'y') ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Z')
    ) {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedKeys.size > 1) {
        clearSelectedCells();
      } else if (selectedKey) {
        const [r, c] = selectedKey.split('-').map(Number);
        clearCell(r, c);
      }
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandlerRef.current?.(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Cell click ───────────────────────────────────────────────────────────
  const handleCellClick = (row: number, col: number, e: React.MouseEvent) => {
    // Clicking a cell clears any header selection
    setSelectedHeaderCol(null);
    setSelectedHeaderRow(null);
    const key  = `${row}-${col}`;

    // Ctrl+click: toggle cell in/out of multi-selection
    if (e.ctrlKey || e.metaKey) {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
      setSelectedKey(key);
      setLastSelectedKey(key);
      return;
    }

    // Shift+click: range select from lastSelectedKey to this key
    if (e.shiftKey && lastSelectedKey && planogram) {
      const [r0, c0] = lastSelectedKey.split('-').map(Number);
      const rowMin = Math.min(r0, row); const rowMax = Math.max(r0, row);
      const colMin = Math.min(c0, col); const colMax = Math.max(c0, col);
      const rangeKeys = new Set<string>();
      for (let r = rowMin; r <= rowMax; r++) {
        for (let c = colMin; c <= colMax; c++) rangeKeys.add(`${r}-${c}`);
      }
      setSelectedKeys(rangeKeys);
      setSelectedKey(key);
      return;
    }

    // Plain click: clear multi-selection, handle single select/place
    setSelectedKeys(new Set());
    setLastSelectedKey(key);
    const cell = cellMap.get(key);
    if (!cell && selectedEan) {
      fillCellWithEan(row, col, selectedEan);
      return;
    }
    setSelectedKey(key === selectedKey ? null : key);
  };

  // ── Header click (select entire column / row) ────────────────────────────
  const handleColHeaderClick = (c: number) => {
    setSelectedKey(null);
    setSelectedHeaderRow(null);
    setSelectedHeaderCol(prev => (prev === c ? null : c));
  };

  const handleRowHeaderClick = (r: number) => {
    setSelectedKey(null);
    setSelectedHeaderCol(null);
    setSelectedHeaderRow(prev => (prev === r ? null : r));
  };

  const handleDrop = (e: React.DragEvent, row: number, col: number) => {
    e.preventDefault();
    setDragOver(null);
    setInternalDragOver(null);
    // Internal cell-to-cell drag takes priority
    const src = internalDragSrcRef.current;
    if (src) {
      internalDragSrcRef.current = null;
      moveCell(src.row, src.col, row, col);
      return;
    }
    // Catalogue drag: EAN in dataTransfer
    const ean = e.dataTransfer.getData('text/plain').trim();
    if (ean) fillCellWithEan(row, col, ean);
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-gray-900">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!planogram) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-gray-900">
        <p className="text-gray-500 text-sm">Failed to load planogram</p>
      </div>
    );
  }

  const rows = planogram.rows;
  const cols = planogram.cols;
  // Per-column and per-row cm sizes, using local drag state when resizing
  const effectiveColWidths = localColWidths ?? getEffectiveColWidths(planogram);
  const effectiveRowHeights = localRowHeights ?? getEffectiveRowHeights(planogram);
  // Per-column and per-row pixel sizes, proportional to physical dimensions and scaled by zoom
  const colWidthsPx = effectiveColWidths.map(w => Math.max(CELL_MIN_PX, Math.round(w * CELL_WIDTH_SCALE * zoom)));
  const rowHeightsPx = effectiveRowHeights.map(h => Math.max(CELL_MIN_PX, Math.round(h * CELL_HEIGHT_SCALE * zoom)));

  // ── Per-cell effective sizes (override takes precedence over column/row default) ──
  const getCellWidthCm = (row: number, col: number): number => {
    const key = `${row}-${col}`;
    if (localCellWidthOverrides?.[key] != null) return localCellWidthOverrides[key];
    if (planogram.cellWidthOverrides?.[key] != null) return planogram.cellWidthOverrides[key];
    // Extra cells (col >= cols) have no global colWidthsCm entry; fall back to default cell width.
    return effectiveColWidths[col] ?? Math.max(MIN_CELL_CM_W, physCellW);
  };
  const getCellWidthPx = (row: number, col: number): number =>
    Math.max(CELL_MIN_PX, Math.round(getCellWidthCm(row, col) * CELL_WIDTH_SCALE * zoom));

  const getCellHeightCm = (row: number, col: number): number => {
    const key = `${row}-${col}`;
    if (localCellHeightOverrides?.[key] != null) return localCellHeightOverrides[key];
    if (planogram.cellHeightOverrides?.[key] != null) return planogram.cellHeightOverrides[key];
    return effectiveRowHeights[row];
  };
  const getCellHeightPx = (row: number, col: number): number =>
    Math.max(CELL_MIN_PX, Math.round(getCellHeightCm(row, col) * CELL_HEIGHT_SCALE * zoom));

  // Per-row effective column count (may exceed global cols when extra cells were added to a row).
  const getRowColCount = (r: number): number => planogram.rowColCounts?.[r] ?? cols;

  // Row container height = max of all cells' heights in that row (cells may differ due to per-cell overrides)
  const rowContainerHeightsPx = Array.from({ length: rows }, (_, r) => {
    let maxH = rowHeightsPx[r];
    for (let c = 0; c < getRowColCount(r); c++) maxH = Math.max(maxH, getCellHeightPx(r, c));
    return maxH;
  });

  // Derived row/col of the currently selected cell, used to highlight adjacent resize handles
  const [selectedRow, selectedCol] = selectedKey
    ? selectedKey.split('-').map(Number) as [number, number]
    : [null, null] as [null, null];

  // ── Grey extension: extra gondola space beyond current planogram dimensions ──
  // Use the same remaining-space formula as canAddCol/canAddRow (includes OVERFLOW_TOLERANCE_CM)
  const extraGondolaWidthCm  = furniture ? Math.max(0, gondolaRemainingW)  : 0;
  const extraGondolaHeightCm = furniture ? Math.max(0, gondolaRemainingH) : 0;
  const greyExtWidthPx  = Math.round(extraGondolaWidthCm  * CELL_WIDTH_SCALE  * zoom);
  const greyExtHeightPx = Math.round(extraGondolaHeightCm * CELL_HEIGHT_SCALE * zoom);

  // ── Crush detection (list of all cells where product exceeds cell dimensions) ──
  const crushedCells: { key: string; row: number; col: number; prod: CADProduct }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < getRowColCount(r); c++) {
      const key = `${r}-${c}`;
      const cell = cellMap.get(key);
      if (!cell) continue;
      const prod = productByEan.get(cell.ean);
      if (!prod) continue;
      const cellCmW = getCellWidthCm(r, c);
      const cellCmH = getCellHeightCm(r, c);
      if (prod.widthCm > cellCmW + OVERFLOW_TOLERANCE_CM || prod.heightCm > cellCmH + OVERFLOW_TOLERANCE_CM) {
        crushedCells.push({ key, row: r, col: c, prod });
      }
    }
  }

  // ── Row fill ratios (cm used / planogram widthCm per row) ────────────────
  const rowFillCm = Array.from({ length: rows }, (_, r) => {
    let total = 0;
    for (let c = 0; c < getRowColCount(r); c++) total += getCellWidthCm(r, c);
    return total;
  });

  // ── Navigate to a crushed cell ───────────────────────────────────────────
  const scrollToCrushed = (idx: number) => {
    if (crushedCells.length === 0) return;
    const target = crushedCells[idx % crushedCells.length];
    setSelectedKey(target.key);
    setSelectedKeys(new Set());
    // Use data attribute to scroll to the cell
    setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-cell-key="${target.key}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, 0);
  };

  const handleCrushBadgeClick = () => {
    if (crushedCells.length === 0) return;
    const nextIdx = (crushNavIdx) % crushedCells.length;
    scrollToCrushed(nextIdx);
    setCrushNavIdx(nextIdx + 1);
  };

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-200 truncate">{planogram.name}</h2>
          <p className="text-xs text-gray-500">
            {rows} lignes × {cols} colonnes
            &nbsp;·&nbsp;
            {planogram.widthCm.toFixed(1)} × {planogram.heightCm.toFixed(1)} cm
            &nbsp;·&nbsp;
            {planogram.cells.length} / {rows * cols} remplis
            &nbsp;·&nbsp;
            <span className="text-gray-600">{physCellW.toFixed(1)} × {physCellH.toFixed(1)} cm/cellule</span>
          </p>
        </div>

        {/* Hidden file input for image upload */}
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            const ean = pendingUploadEan.current;
            if (file && ean) void handleImageUpload(ean, file);
            e.target.value = '';
            pendingUploadEan.current = null;
          }}
        />

        <div className="flex items-center gap-2 shrink-0">
          {/* Row / column management */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-600 mr-0.5">Lignes</span>
            <button
              onClick={removeRow}
              disabled={rows <= 1}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm transition-colors"
              title="Supprimer dernière ligne"
            >−</button>
            <span className="text-xs text-gray-400 w-5 text-center">{rows}</span>
            <button
              onClick={addRow}
              disabled={!canAddRow}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm transition-colors"
              title={canAddRow ? "Ajouter une ligne" : `Limite atteinte (${furniture?.dimensions.height ?? '?'} cm)`}
            >+</button>
          </div>

          <div className="h-4 w-px bg-gray-700" />

          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-600 mr-0.5">Colonnes</span>
            <button
              onClick={removeCol}
              disabled={cols <= 1}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm transition-colors"
              title={
                selectedHeaderRow !== null
                  ? `Supprimer la dernière cellule de la ligne ${selectedHeaderRow + 1}`
                  : selectedHeaderCol !== null
                  ? `Supprimer la colonne ${selectedHeaderCol + 1}`
                  : 'Supprimer la dernière colonne'
              }
            >−</button>
            <span className="text-xs text-gray-400 w-5 text-center">{cols}</span>
            <button
              onClick={addCol}
              disabled={!canAddCol}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm transition-colors"
              title={
                !canAddCol
                  ? `Limite atteinte (${furniture?.dimensions.width ?? '?'} cm)`
                  : selectedHeaderRow !== null
                  ? `Ajouter une cellule à la ligne ${selectedHeaderRow + 1}`
                  : 'Ajouter une colonne à toutes les lignes'
              }
            >+</button>
          </div>

          <div className="h-4 w-px bg-gray-700" />

          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-sm transition-colors"
              title="Zoom arrière"
            >−</button>
            <span className="text-xs text-gray-500 w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-sm transition-colors"
              title="Zoom avant"
            >+</button>
          </div>

          <div className="h-4 w-px bg-gray-700" />

          {/* Undo / Redo */}
          <button
            onClick={undo}
            disabled={history.length === 0}
            className="px-2 py-1 text-xs rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 transition-colors"
            title="Annuler (Ctrl+Z)"
          >↩ Annuler</button>
          <button
            onClick={redo}
            disabled={future.length === 0}
            className="px-2 py-1 text-xs rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 transition-colors"
            title="Rétablir (Ctrl+Y)"
          >↪ Rétablir</button>

          {/* Crush badge — click to navigate between conflicts */}
          {crushedCells.length > 0 && (
            <button
              onClick={handleCrushBadgeClick}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-800/60 hover:bg-red-700/80 text-red-300 text-xs transition-colors"
              title={`${crushedCells.length} conflit(s) — cliquer pour naviguer`}
            >
              ⚠ {crushedCells.length} conflit{crushedCells.length > 1 ? 's' : ''}
            </button>
          )}

          <div className="h-4 w-px bg-gray-700" />

          {/* Clear all cells */}
          {!clearAllConfirm ? (
            <button
              onClick={() => setClearAllConfirm(true)}
              disabled={planogram.cells.length === 0}
              className="px-2 py-0.5 text-xs rounded hover:bg-red-900/50 text-gray-400 hover:text-red-300 disabled:opacity-30 transition-colors"
              title="Vider tous les blocs gondoles"
            >🗑 Tout vider</button>
          ) : (
            <span className="flex items-center gap-1">
              <span className="text-xs text-red-300">Confirmer ?</span>
              <button
                onClick={clearAllCells}
                className="px-2 py-0.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors"
              >Oui</button>
              <button
                onClick={() => setClearAllConfirm(false)}
                className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
              >Non</button>
            </span>
          )}

          {/* Multi-selection bulk actions */}
          {selectedKeys.size > 1 && (
            <>
              <div className="h-4 w-px bg-gray-700" />
              <button
                onClick={clearSelectedCells}
                className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-red-800/50 text-gray-300 hover:text-red-200 transition-colors"
                title={`Vider les ${selectedKeys.size} cellules sélectionnées`}
              >Vider ({selectedKeys.size})</button>
              {selectedEan && (
                <button
                  onClick={() => fillSelectedCells(selectedEan)}
                  className="px-2 py-0.5 text-xs rounded bg-blue-800/50 hover:bg-blue-700/70 text-blue-200 transition-colors"
                  title={`Appliquer ${selectedEan} à ${selectedKeys.size} cellules`}
                >Appliquer ({selectedKeys.size})</button>
              )}
            </>
          )}

          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-700 text-gray-400 hover:text-white text-base transition-colors"
            title="Fermer"
          >
            ×
          </button>
        </div>
      </div>

      {/* Overflow warning */}
      {isOverflowing && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-900/30 border-b border-red-700/50 text-xs text-red-300 shrink-0">
          <span className="text-base">🔴</span>
          <span>
            Ce planogramme ({planogram.widthCm} × {planogram.heightCm} cm) dépasse les dimensions de la gondole
            ({furniture?.dimensions.width ?? '?'} × {furniture?.dimensions.height ?? '?'} cm).
            Les produits en dehors des limites ne seront pas affichés correctement.
          </span>
        </div>
      )}

      {/* AddRow dialog — shown when top row height check triggers */}
      {addRowDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-800 border border-gray-600 rounded-lg shadow-xl p-5 max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-gray-100 mb-2">Espace insuffisant</h3>
            <p className="text-xs text-gray-300 mb-4">
              {addRowDialog.canAutoFix
                ? `La rangée supérieure fait ${addRowDialog.topRowH.toFixed(1)} cm. Il faut ${addRowDialog.needed.toFixed(1)} cm pour la nouvelle rangée. Réduire automatiquement la rangée du haut ?`
                : `La rangée supérieure fait déjà ${addRowDialog.topRowH.toFixed(1)} cm, trop peu pour absorber une nouvelle rangée (${addRowDialog.needed.toFixed(1)} cm). Supprimez une rangée existante pour libérer de l'espace.`}
            </p>
            <div className="flex gap-2 justify-end">
              {addRowDialog.canAutoFix && (
                <button
                  onClick={() => { setAddRowDialog(null); _doAddRow(addRowDialog.needed); }}
                  className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                >Réduire et ajouter</button>
              )}
              <button
                onClick={() => setAddRowDialog(null)}
                className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
              >Annuler</button>
            </div>
          </div>
        </div>
      )}

      {/* Grid area */}
      <div className="flex-1 overflow-auto p-4">
        {/* Full-screen overlay to hold cursor during resize */}
        {isResizing && (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              cursor: isResizing === 'col' ? 'col-resize' : 'row-resize',
            }}
          />
        )}

        {/* Dimension tooltip during resize */}
        {resizeTooltip && (
          <div
            style={{
              position: 'fixed',
              left: resizeTooltip.x,
              top: resizeTooltip.y,
              zIndex: 10000,
              pointerEvents: 'none',
            }}
            className="bg-gray-950 text-blue-300 text-xs font-mono px-1.5 py-0.5 rounded border border-blue-500/60 shadow-lg whitespace-nowrap"
          >
            {resizeTooltip.text}
          </div>
        )}

        {/* Column numbers — sticky top so they stay visible on vertical scroll */}
        <div
          className="flex mb-1"
          style={{ position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#111827' }}
        >
          {/* Corner spacer (sticky top+left) */}
          <div
            style={{
              width: '24px', flexShrink: 0,
              position: 'sticky', left: 0, zIndex: 20,
              backgroundColor: '#111827',
            }}
          />
          {Array.from({ length: cols }, (_, c) => (
            <Fragment key={c}>
              <div
                className={[
                  'text-center text-xs pb-0.5 flex-none cursor-pointer select-none transition-colors rounded-t',
                  selectedHeaderCol === c
                    ? 'text-blue-400 bg-blue-900/40'
                    : 'text-gray-600 hover:text-gray-300 hover:bg-gray-800/60',
                ].join(' ')}
                style={{ width: `${colWidthsPx[c]}px` }}
                onClick={() => handleColHeaderClick(c)}
                title={`Colonne ${c + 1} — cliquer pour sélectionner`}
              >
                {c + 1}
              </div>
              {c < cols - 1 && (
                <div
                  style={{ width: `${RESIZE_HANDLE_PX}px`, flexShrink: 0, cursor: 'col-resize' }}
                  className={[
                    'transition-colors',
                    activeSnapBoundary === c + 1
                      ? 'bg-yellow-400/80'
                      : 'hover:bg-blue-500/60',
                  ].join(' ')}
                  onMouseDown={(e) => startColResize(e, c)}
                  title="Redimensionner colonne"
                />
              )}
            </Fragment>
          ))}
          {/* Grey extension header */}
          {greyExtWidthPx > 0 && (
            <div
              style={{ width: `${greyExtWidthPx}px`, marginLeft: `${RESIZE_HANDLE_PX}px`, flexShrink: 0 }}
              className="text-center text-xs text-gray-500 pb-0.5 italic"
              title={`${extraGondolaWidthCm.toFixed(0)} cm disponibles sur la gondole`}
            >
              +{extraGondolaWidthCm.toFixed(0)} cm
            </div>
          )}
        </div>

        <div className="flex">
          {/* Row numbers — sticky left so they stay visible on horizontal scroll */}
          <div
            className="flex flex-col"
            style={{ width: '20px', marginRight: '4px', position: 'sticky', left: 0, zIndex: 5, backgroundColor: '#111827' }}
          >
            {Array.from({ length: rows }, (_, r) => {
              const fillCm = rowFillCm[r];
              const fillRatio = planogram.widthCm > 0 ? fillCm / planogram.widthCm : 0;
              const fillColor = fillRatio > 1 ? '#ef4444' : fillRatio > 0.95 ? '#f59e0b' : '#22c55e';
              return (
              <Fragment key={r}>
                <div
                  className={[
                    'text-xs flex flex-col items-center justify-center flex-none cursor-pointer select-none transition-colors rounded-l',
                    selectedHeaderRow === r
                      ? 'text-blue-400 bg-blue-900/40'
                      : 'text-gray-600 hover:text-gray-300 hover:bg-gray-800/60',
                  ].join(' ')}
                  style={{ height: `${rowContainerHeightsPx[r]}px`, width: '20px', position: 'relative', overflow: 'hidden' }}
                  onClick={() => handleRowHeaderClick(r)}
                  title={`Ligne ${r + 1} — ${fillCm.toFixed(1)} cm / ${planogram.widthCm.toFixed(1)} cm (${(fillRatio * 100).toFixed(0)}% utilisé)`}
                >
                  {r + 1}
                  {/* Fill bar */}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      height: '3px',
                      width: `${Math.min(fillRatio * 100, 100)}%`,
                      backgroundColor: fillColor,
                      borderRadius: '0 0 0 3px',
                      transition: 'width 0.2s',
                    }}
                  />
                </div>
                {r < rows - 1 && (
                  <div
                    style={{ height: `${RESIZE_HANDLE_PX}px`, cursor: 'row-resize' }}
                    className={[
                      'transition-colors',
                      activeRowSnapBoundary === r + 1
                        ? 'bg-yellow-400/80'
                        : 'hover:bg-blue-500/60',
                    ].join(' ')}
                    onMouseDown={(e) => startRowResize(e, r)}
                    title="Redimensionner ligne"
                  />
                )}
              </Fragment>
              );
            })}
          </div>

          {/* Main grid */}
          <div className="flex flex-col">
            {Array.from({ length: rows }, (_, row) => (
              <Fragment key={row}>
                {/* Data row */}
                <div className="flex">
                  {Array.from({ length: getRowColCount(row) }, (_, col) => {
                    const key      = `${row}-${col}`;
                    const cell     = cellMap.get(key);
                    const prod     = cell ? productByEan.get(cell.ean) : undefined;
                    const catColor = prod ? getCategoryColor(prod.category) : undefined;
                    const isSelected = selectedKey === key;
                    const isMultiSelected = selectedKeys.has(key);
                    const isInternalDragOver = internalDragOver === key;
                    const isDragOver = dragOver === key;
                    const isUploading = prod && uploadingEan === prod.ean;
                    const isHeaderHighlighted = selectedHeaderCol === col || selectedHeaderRow === row;
                    const cellCmW = getCellWidthCm(row, col);
                    const cellCmH = getCellHeightCm(row, col);
                    const cellPxW = getCellWidthPx(row, col);
                    const cellPxH = getCellHeightPx(row, col);
                    // Whether this gap is between two global (shared) columns — drives resize cursor.
                    const isGlobalColGap = col < cols - 1;

                    // Per-cell overflow: product physical dims exceed this cell's physical dims
                    const prodOverflow = prod
                      ? prod.widthCm  > cellCmW + OVERFLOW_TOLERANCE_CM ||
                        prod.heightCm > cellCmH + OVERFLOW_TOLERANCE_CM
                      : false;

                    // Zoom-aware dimension badge visibility
                    const showDimBadge = zoom >= 1 && prod;

                    return (
                      <Fragment key={col}>
                        <div
                          data-cell-key={key}
                          draggable={!!cell}
                          onClick={(e) => handleCellClick(row, col, e)}
                          onContextMenu={(e) => { e.preventDefault(); if (cell) clearCell(row, col); }}
                          onDragStart={(e) => {
                            if (!cell || !prod) return;
                            internalDragSrcRef.current = { row, col, ean: cell.ean };
                            e.dataTransfer.effectAllowed = 'move';
                            // Remove default drag image to avoid browser ghost
                            const ghost = document.createElement('div');
                            ghost.style.position = 'absolute'; ghost.style.top = '-9999px';
                            document.body.appendChild(ghost);
                            e.dataTransfer.setDragImage(ghost, 0, 0);
                            setTimeout(() => document.body.removeChild(ghost), 0);
                          }}
                          onDragEnd={() => {
                            internalDragSrcRef.current = null;
                            setInternalDragOver(null);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            if (internalDragSrcRef.current) {
                              setInternalDragOver(key);
                              setDragOver(null);
                            } else {
                              setDragOver(key);
                              setInternalDragOver(null);
                            }
                          }}
                          onDragLeave={() => { setDragOver(null); setInternalDragOver(null); }}
                          onDrop={(e) => handleDrop(e, row, col)}
                          className={[
                            'relative flex flex-col items-center justify-center rounded cursor-pointer transition-all overflow-hidden select-none border group flex-none',
                            prodOverflow
                              ? 'border-red-500 border-solid'
                              : isInternalDragOver
                              ? 'border-blue-400 border-dashed bg-blue-900/20'
                              : isDragOver
                              ? 'border-green-400 bg-green-900/20 border-solid'
                              : cell
                              ? 'border-transparent'
                              : 'border-dashed border-gray-700 hover:border-gray-500',
                            isSelected ? 'ring-2 ring-blue-500' : '',
                            isMultiSelected && !isSelected ? 'ring-2 ring-blue-400/70 bg-blue-900/20' : '',
                            isHeaderHighlighted && !isSelected && !isMultiSelected ? 'ring-1 ring-blue-400/60 bg-blue-900/15' : '',
                            prodOverflow ? 'bg-red-900/20' : '',
                            cell ? 'cursor-grab active:cursor-grabbing' : '',
                          ].join(' ')}
                          style={{
                            width:  `${cellPxW}px`,
                            height: `${cellPxH}px`,
                            background: !prodOverflow && cell && catColor ? catColor + '18' : undefined,
                          }}
                          title={prodOverflow && prod
                            ? `⚠ ${prod.name} (${prod.widthCm}×${prod.heightCm} cm) dépasse la cellule (${cellCmW.toFixed(1)}×${cellCmH.toFixed(1)} cm)`
                            : cell ? `${prod?.name ?? cell.ean} — glisser pour déplacer`
                            : undefined}
                        >
                          {cell && prod ? (
                            <>
                              {/* Category stripe or overflow indicator */}
                              <div
                               className="absolute inset-x-0 top-0 h-1 rounded-t"
                               style={{ background: prodOverflow ? '#ef4444' : catColor }}
                              />

                              {/* Thumbnail */}
                              <div className="w-full px-1 pt-1.5 pb-0.5 flex flex-col items-center gap-0.5">
                               <div className="w-full" style={{ height: `${Math.max(28, cellPxH - 32)}px` }}>
                                 {isUploading ? (
                                   <div className="w-full h-full flex items-center justify-center">
                                     <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                                   </div>
                                 ) : (
                                   <ProductThumb product={prod} />
                                 )}
                               </div>
                               <div
                                 className="text-xs font-medium leading-tight truncate w-full text-center"
                                 style={{ color: prodOverflow ? '#f87171' : catColor, fontSize: '10px' }}
                               >
                                 {prod.name.length > 14 ? prod.name.slice(0, 12) + '…' : prod.name}
                               </div>
                               {/* Product dimensions — zoom-aware */}
                               {showDimBadge && (
                                 <div
                                   className="text-center leading-none px-0.5 rounded"
                                   style={{
                                     fontSize: '9px',
                                     color: prodOverflow ? '#f87171' : '#6b7280',
                                     background: prodOverflow ? 'rgba(239,68,68,0.15)' : undefined,
                                   }}
                                 >
                                   {prod.widthCm}×{prod.heightCm} cm
                                   {zoom > 2 && (
                                     <span style={{ color: '#4b5563' }}>
                                       {' '}/ {cellCmW.toFixed(1)} cm
                                     </span>
                                   )}
                                 </div>
                               )}
                              </div>

                              {/* Overflow badge */}
                              {prodOverflow && (
                               <div className="absolute bottom-0.5 left-0.5 text-red-400 leading-none" style={{ fontSize: '9px' }}>
                                 ⚠ débordement
                               </div>
                              )}

                              {/* Hover actions */}
                              <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                               {/* Upload image */}
                               <button
                                 className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-blue-400 bg-gray-900/70 rounded text-xs leading-none"
                                 title="Uploader une vignette"
                                 onClick={(e) => {
                                   e.stopPropagation();
                                   pendingUploadEan.current = prod.ean;
                                   uploadInputRef.current?.click();
                                 }}
                               >
                                 📷
                               </button>
                               {/* Remove */}
                               <button
                                 className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 bg-gray-900/60 rounded text-xs leading-none"
                                 onClick={(e) => { e.stopPropagation(); clearCell(row, col); }}
                                 title="Retirer"
                               >
                                 ×
                               </button>
                              </div>
                            </>
                          ) : cell ? (
                            // Cell with EAN but no catalog match
                            <>
                              <div className="text-xs text-gray-400 font-mono text-center px-1">{cell.ean.slice(-6)}</div>
                              <button
                               className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs"
                               onClick={(e) => { e.stopPropagation(); clearCell(row, col); }}
                              >×</button>
                            </>
                          ) : (
                            // Empty cell
                            <span className="text-gray-700 text-xs opacity-0 group-hover:opacity-100 transition-opacity">+</span>
                          )}

                          {/* Selected-cell resize handles — per-cell only (do not affect other rows/cols) */}
                          {isSelected && col + 1 < getRowColCount(row) && (
                            <div
                              onMouseDown={(e) => startCellRightResize(e, row, col)}
                              style={{
                               position: 'absolute', right: 0, top: 0,
                               width: '6px', height: '100%',
                               cursor: 'col-resize', zIndex: 10,
                               background: 'rgba(59,130,246,0.55)',
                              }}
                              title="Redimensionner ce segment de colonne (cette ligne seulement)"
                            />
                          )}
                          {isSelected && col > 0 && (
                            <div
                              onMouseDown={(e) => startCellLeftResize(e, row, col)}
                              style={{
                               position: 'absolute', left: 0, top: 0,
                               width: '6px', height: '100%',
                               cursor: 'col-resize', zIndex: 10,
                               background: 'rgba(59,130,246,0.55)',
                              }}
                              title="Redimensionner ce segment de colonne (cette ligne seulement)"
                            />
                          )}
                          {isSelected && row + 1 < rows && (
                            <div
                              onMouseDown={(e) => startCellBottomResize(e, row, col)}
                              style={{
                               position: 'absolute', bottom: 0, left: 0,
                               width: '100%', height: '6px',
                               cursor: 'row-resize', zIndex: 10,
                               background: 'rgba(59,130,246,0.55)',
                              }}
                              title="Redimensionner ce segment de ligne (cette colonne seulement)"
                            />
                          )}
                          {isSelected && row > 0 && (
                            <div
                              onMouseDown={(e) => startCellTopResize(e, row, col)}
                              style={{
                               position: 'absolute', top: 0, left: 0,
                               width: '100%', height: '6px',
                               cursor: 'row-resize', zIndex: 10,
                               background: 'rgba(59,130,246,0.55)',
                              }}
                              title="Redimensionner ce segment de ligne (cette colonne seulement)"
                            />
                          )}
                        </div>

                        {/* Column resize handle — only between columns (not after the last one in this row) */}
                        {col < getRowColCount(row) - 1 && (
                          <div
                            style={{ width: `${RESIZE_HANDLE_PX}px`, height: `${cellPxH}px`, cursor: 'col-resize', flexShrink: 0 }}
                            className={[
                              'transition-colors',
                              isGlobalColGap && (selectedCol === col || selectedCol === col + 1)
                               ? 'bg-blue-500/40 hover:bg-blue-400/70'
                               : 'bg-gray-800 hover:bg-blue-500/50',
                            ].join(' ')}
                            onMouseDown={isGlobalColGap ? (e) => startColResize(e, col) : undefined}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                  {/* Grey extension area to the right — extra gondola width not yet used by columns */}
                  {greyExtWidthPx > 0 && (
                    <div
                      style={{
                        width:     `${greyExtWidthPx}px`,
                        height:    `${rowContainerHeightsPx[row]}px`,
                        flexShrink: 0,
                        marginLeft: `${RESIZE_HANDLE_PX}px`,
                      }}
                      className="bg-gray-700/25 border border-dashed border-gray-600/50"
                    />
                  )}
                </div>

                {/* Row resize handle — only between rows (not after the last one) */}
                {row < rows - 1 && (
                  <div
                    style={{ height: `${RESIZE_HANDLE_PX}px`, cursor: 'row-resize' }}
                    className={[
                      'transition-colors',
                      selectedRow === row || selectedRow === row + 1
                        ? 'bg-blue-500/40 hover:bg-blue-400/70'
                        : 'bg-gray-800 hover:bg-blue-500/50',
                    ].join(' ')}
                    onMouseDown={(e) => startRowResize(e, row)}
                  />
                )}
              </Fragment>
            ))}
            {/* Grey extension below — extra gondola height not yet used by rows */}
            {greyExtHeightPx > 0 && (
              <div
                style={{ height: `${greyExtHeightPx}px`, flexShrink: 0, marginTop: `${RESIZE_HANDLE_PX}px` }}
                className="bg-gray-700/25 border border-dashed border-gray-600/50"
              />
            )}
          </div>
        </div>
      </div>

      {/* Bottom hint */}
      <div className="border-t border-gray-800 px-4 py-2 flex items-center gap-3 shrink-0 text-xs text-gray-500">
        {selectedKeys.size > 1 ? (
          <>
            <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
            <span className="text-blue-300">{selectedKeys.size} cellules sélectionnées</span>
            <span className="text-gray-600">· Suppr pour vider · Ctrl+clic pour toggle · Shift+clic pour étendre</span>
          </>
        ) : selectedEan ? (
          <>
            <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
            <span>Sélectionné: <span className="font-mono text-gray-300">{selectedEan}</span></span>
            <span className="text-gray-600">· Cliquer cellule vide pour placer · Glisser depuis catalogue · Ctrl+clic multi-sélection</span>
          </>
        ) : (
          <span>Sélectionnez un produit dans le catalogue · Ctrl+clic multi-sélection · Shift+clic plage · Glisser cellule occupée pour déplacer</span>
        )}
        <div className="flex-1" />
        <span className="text-gray-600">
          Clic droit/× vider · Suppr retirer · Ctrl+Z annuler · Ctrl+Y rétablir · 📷 vignette · ⟺ séparateurs · ◀▶▲▼ segment · 🔴 débordement
        </span>
      </div>
    </div>
  );
}

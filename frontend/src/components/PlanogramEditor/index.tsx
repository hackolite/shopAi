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
  };

  const undo = () => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setPlanogram(last);
      setCellMap(buildCellMap(last.cells));
      setActivePlanogram(last);
      scheduleSave(last);
      return prev.slice(0, -1);
    });
  };

  // ── Row / column management ──────────────────────────────────────────────
  const addRow = () => {
    if (!planogram || !canAddRow) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const curHeights = getEffectiveRowHeights(planogram);
    applyUpdate({
      ...planogram,
      rows: planogram.rows + 1,
      heightCm: planogram.heightCm + newRowHeightCm,
      rowHeightsCm: [...curHeights, newRowHeightCm],
    });
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
    });
    if (selectedKey?.startsWith(`${lastRow}-`)) setSelectedKey(null);
  };

  const addCol = () => {
    if (!planogram || !canAddCol) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const curWidths = getEffectiveColWidths(planogram);
    applyUpdate({
      ...planogram,
      cols: planogram.cols + 1,
      widthCm: planogram.widthCm + newColWidthCm,
      colWidthsCm: [...curWidths, newColWidthCm],
    });
  };

  const removeCol = () => {
    if (!planogram || planogram.cols <= 1) return;
    const lastCol = planogram.cols - 1;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    const curWidths = getEffectiveColWidths(planogram);
    const removedW = curWidths[lastCol];
    applyUpdate({
      ...planogram,
      cols: planogram.cols - 1,
      widthCm: planogram.widthCm - removedW,
      colWidthsCm: curWidths.slice(0, -1),
      cells: planogram.cells.filter((c) => c.col !== lastCol),
    });
    if (selectedKey?.endsWith(`-${lastCol}`)) setSelectedKey(null);
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
    return p.cellWidthOverrides?.[key] ?? getEffectiveColWidths(p)[col];
  };
  const getCellStartHeightCm = (p: Planogram, row: number, col: number): number => {
    const key = `${row}-${col}`;
    return p.cellHeightOverrides?.[key] ?? getEffectiveRowHeights(p)[row];
  };

  // Dragging right edge: cell grows, right neighbour shrinks (this row only).
  const startCellRightResize = (e: React.MouseEvent, row: number, col: number) => {
    if (!planogram || col + 1 >= planogram.cols) return;
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

    const onMove = (ev: MouseEvent) => {
      const deltaCm = (ev.clientX - startX) / (CELL_WIDTH_SCALE * zoom);
      const clamped = Math.max(-(startW0 - MIN_CELL_CM_W), Math.min(startW1 - MIN_CELL_CM_W, deltaCm));
      finalW0 = startW0 + clamped;
      finalW1 = startW1 - clamped;
      setLocalCellWidthOverrides({ ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 });
      setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${finalW0.toFixed(1)} / ${finalW1.toFixed(1)} cm` });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellWidthOverrides(null);
      setResizeTooltip(null);
      applyUpdate({ ...capturedPlanogram, cellWidthOverrides: { ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 } });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Dragging left edge: cell grows, left neighbour shrinks (this row only).
  const startCellLeftResize = (e: React.MouseEvent, row: number, col: number) => {
    if (!planogram || col <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const key0 = `${row}-${col - 1}`;
    const key1 = `${row}-${col}`;
    const startW0 = getCellStartWidthCm(planogram, row, col - 1);
    const startW1 = getCellStartWidthCm(planogram, row, col);
    const capturedPlanogram = planogram;
    let finalW0 = startW0;
    let finalW1 = startW1;
    setIsResizing('col');

    const onMove = (ev: MouseEvent) => {
      // Dragging left (negative delta) shrinks the left neighbour, grows current
      const deltaCm = (ev.clientX - startX) / (CELL_WIDTH_SCALE * zoom);
      const clamped = Math.max(-(startW0 - MIN_CELL_CM_W), Math.min(startW1 - MIN_CELL_CM_W, deltaCm));
      finalW0 = startW0 + clamped;
      finalW1 = startW1 - clamped;
      setLocalCellWidthOverrides({ ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 });
      setResizeTooltip({ x: ev.clientX + RESIZE_TOOLTIP_DX, y: ev.clientY + RESIZE_TOOLTIP_DY, text: `${finalW0.toFixed(1)} / ${finalW1.toFixed(1)} cm` });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellWidthOverrides(null);
      setResizeTooltip(null);
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

    const onMove = (ev: MouseEvent) => {
      const deltaCm = (ev.clientY - startY) / (CELL_HEIGHT_SCALE * zoom);
      const clamped = Math.max(-(startH0 - MIN_CELL_CM_H), Math.min(startH1 - MIN_CELL_CM_H, deltaCm));
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

    const onMove = (ev: MouseEvent) => {
      // Dragging up (negative delta) shrinks the top neighbour, grows current
      const deltaCm = (ev.clientY - startY) / (CELL_HEIGHT_SCALE * zoom);
      const clamped = Math.max(-(startH0 - MIN_CELL_CM_H), Math.min(startH1 - MIN_CELL_CM_H, deltaCm));
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
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedKey) {
      const [r, c] = selectedKey.split('-').map(Number);
      clearCell(r, c);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandlerRef.current?.(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Cell click ───────────────────────────────────────────────────────────
  const handleCellClick = (row: number, col: number) => {
    const key  = `${row}-${col}`;
    const cell = cellMap.get(key);
    if (!cell && selectedEan) {
      fillCellWithEan(row, col, selectedEan);
      return;
    }
    setSelectedKey(key === selectedKey ? null : key);
  };

  const handleDrop = (e: React.DragEvent, row: number, col: number) => {
    e.preventDefault();
    setDragOver(null);
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
    return effectiveColWidths[col];
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

  // Row container height = max of all cells' heights in that row (cells may differ due to per-cell overrides)
  const rowContainerHeightsPx = Array.from({ length: rows }, (_, r) => {
    let maxH = rowHeightsPx[r];
    for (let c = 0; c < cols; c++) maxH = Math.max(maxH, getCellHeightPx(r, c));
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
              title="Supprimer dernière colonne"
            >−</button>
            <span className="text-xs text-gray-400 w-5 text-center">{cols}</span>
            <button
              onClick={addCol}
              disabled={!canAddCol}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm transition-colors"
              title={canAddCol ? "Ajouter une colonne" : `Limite atteinte (${furniture?.dimensions.width ?? '?'} cm)`}
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

          <button
            onClick={undo}
            disabled={history.length === 0}
            className="px-2 py-1 text-xs rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 transition-colors"
            title="Undo (Ctrl+Z)"
          >
            ↩ Undo
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-700 text-gray-400 hover:text-white text-base transition-colors"
            title="Close"
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

        {/* Column numbers */}
        <div className="flex mb-1" style={{ marginLeft: '24px' }}>
          {Array.from({ length: cols }, (_, c) => (
            <Fragment key={c}>
              <div
                className="text-center text-xs text-gray-600 pb-0.5 flex-none"
                style={{ width: `${colWidthsPx[c]}px` }}
              >
                {c + 1}
              </div>
              {c < cols - 1 && <div style={{ width: `${RESIZE_HANDLE_PX}px`, flexShrink: 0 }} />}
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
          {/* Row numbers */}
          <div className="flex flex-col" style={{ width: '20px', marginRight: '4px' }}>
            {Array.from({ length: rows }, (_, r) => (
              <Fragment key={r}>
                <div
                  className="text-xs text-gray-600 flex items-center justify-center flex-none"
                  style={{ height: `${rowContainerHeightsPx[r]}px`, width: '20px' }}
                >
                  {r + 1}
                </div>
                {r < rows - 1 && <div style={{ height: `${RESIZE_HANDLE_PX}px` }} />}
              </Fragment>
            ))}
          </div>

          {/* Main grid */}
          <div className="flex flex-col">
            {Array.from({ length: rows }, (_, row) => (
              <Fragment key={row}>
                {/* Data row */}
                <div className="flex">
                  {Array.from({ length: cols }, (_, col) => {
                    const key      = `${row}-${col}`;
                    const cell     = cellMap.get(key);
                    const prod     = cell ? productByEan.get(cell.ean) : undefined;
                    const catColor = prod ? getCategoryColor(prod.category) : undefined;
                    const isSelected = selectedKey === key;
                    const isDragOver = dragOver === key;
                    const isUploading = prod && uploadingEan === prod.ean;
                    const cellCmW = getCellWidthCm(row, col);
                    const cellCmH = getCellHeightCm(row, col);
                    const cellPxW = getCellWidthPx(row, col);
                    const cellPxH = getCellHeightPx(row, col);

                    // Per-cell overflow: product physical dims exceed this cell's physical dims
                    const prodOverflow = prod
                      ? prod.widthCm  > cellCmW + OVERFLOW_TOLERANCE_CM ||
                        prod.heightCm > cellCmH + OVERFLOW_TOLERANCE_CM
                      : false;

                    return (
                      <Fragment key={col}>
                        <div
                          onClick={() => handleCellClick(row, col)}
                          onContextMenu={(e) => { e.preventDefault(); if (cell) clearCell(row, col); }}
                          onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
                          onDragLeave={() => setDragOver(null)}
                          onDrop={(e) => handleDrop(e, row, col)}
                          className={[
                            'relative flex flex-col items-center justify-center rounded cursor-pointer transition-all overflow-hidden select-none border group flex-none',
                            prodOverflow
                              ? 'border-red-500 border-solid'
                              : cell
                              ? 'border-transparent'
                              : isDragOver
                              ? 'border-blue-400 bg-blue-900/20 border-solid'
                              : 'border-dashed border-gray-700 hover:border-gray-500',
                            isSelected ? 'ring-2 ring-blue-500' : '',
                            prodOverflow ? 'bg-red-900/20' : '',
                          ].join(' ')}
                          style={{
                            width:  `${cellPxW}px`,
                            height: `${cellPxH}px`,
                            background: !prodOverflow && cell && catColor ? catColor + '18' : undefined,
                          }}
                          title={prodOverflow && prod
                            ? `⚠ ${prod.name} (${prod.widthCm}×${prod.heightCm} cm) dépasse la cellule (${cellCmW.toFixed(1)}×${cellCmH.toFixed(1)} cm)`
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
                               {/* Product dimensions */}
                               <div className="text-center leading-none" style={{ fontSize: '9px', color: prodOverflow ? '#f87171' : '#6b7280' }}>
                                 {prod.widthCm}×{prod.heightCm} cm
                               </div>
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
                          {isSelected && col + 1 < cols && (
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

                        {/* Column resize handle — only between columns (not after the last one) */}
                        {col < cols - 1 && (
                          <div
                            style={{ width: `${RESIZE_HANDLE_PX}px`, height: `${cellPxH}px`, cursor: 'col-resize', flexShrink: 0 }}
                            className={[
                              'transition-colors',
                              selectedCol === col || selectedCol === col + 1
                               ? 'bg-blue-500/40 hover:bg-blue-400/70'
                               : 'bg-gray-800 hover:bg-blue-500/50',
                            ].join(' ')}
                            onMouseDown={(e) => startColResize(e, col)}
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
        {selectedEan ? (
          <>
            <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
            <span>Sélectionné: <span className="font-mono text-gray-300">{selectedEan}</span></span>
            <span className="text-gray-600">· Cliquer une cellule vide pour placer · Glisser depuis le catalogue</span>
          </>
        ) : (
          <span>Sélectionnez un produit dans le catalogue, puis cliquez une cellule</span>
        )}
        <div className="flex-1" />
        <span
          className="text-gray-600"
        aria-label="Clic droit ou × pour vider · Suppr. pour retirer · Ctrl+Z annuler · photo pour uploader une vignette · glisser les séparateurs pour redimensionner colonne/ligne entière · sélectionner une cellule puis glisser ses bords (◀▶▲▼) pour redimensionner uniquement ce segment · produit trop grand si débordement"
        >
        Clic droit ou × pour vider · Suppr. pour retirer · Ctrl+Z annuler · 📷 vignette · ⟺ séparateurs (colonne/ligne entière) · cellule sélectionnée : glisser ◀▶▲▼ (segment seulement) · 🔴 débordement
        </span>
      </div>
    </div>
  );
}

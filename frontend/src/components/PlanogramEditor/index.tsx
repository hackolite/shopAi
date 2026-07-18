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

/** Minimum cell size in pixels — prevents zero-size cells at extreme zoom out. */
const CELL_MIN_PX = 4;
/** Padding (px) around the planogram canvas inside the scroll area. */
const CANVAS_PADDING_PX = 28;
/** Width of the left cm ruler / height of the top cm ruler (px). */
const RULER_SIZE_PX = 30;
/** Fallback px/cm scale used before the ResizeObserver reports a container size. */
const FALLBACK_PX_PER_CM = 5;
/** Minimum product block pixel size (width or height) for showing the thumbnail image. */
const MIN_THUMBNAIL_PX = 18;
/** Minimum cell height (px) at which the product name label is shown. */
const MIN_CELL_HEIGHT_FOR_LABEL_PX = 28;
/** Minimum cell height (px) at which the product dimension label is shown. */
const MIN_CELL_HEIGHT_FOR_DIM_PX = 44;
/** Minimum cell width (px) at which the product dimension label is shown. */
const MIN_CELL_WIDTH_FOR_DIM_PX = 30;

/** Minimum/maximum cell physical size (cm) enforced during drag-resize. */
const MIN_CELL_CM_W = 2;
const MIN_CELL_CM_H = 2;
const MAX_CELL_CM_W = 300;
const MAX_CELL_CM_H = 300;
/** Width/height (px) of resize handle strips between columns and rows. */
const RESIZE_HANDLE_PX = 4;
/** Snap threshold (cm): per-cell resize snaps to column/row default within this distance. */
const CELL_SNAP_THRESHOLD_CM = 0.5;
/** Epsilon (cm) used to detect when a per-cell override has returned exactly to its column/row default. */
const OVERRIDE_CLEANUP_EPSILON_CM = 0.001;

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

/** Format a cm dimension for the ruler: blank when < 2 cm, 1 decimal when < 10 cm, integer otherwise. */
function fmtRulerCm(cm: number): string {
  if (cm < 2) return '';
  return cm < 10 ? cm.toFixed(1) : cm.toFixed(0);
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
  /** Zoom multiplier: 1 = fit to view, >1 zoomed in. */
  const [zoom, setZoom] = useState(1);
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
  /** Ref to the scrollable canvas container — observed for size changes. */
  const containerRef = useRef<HTMLDivElement>(null);
  /** Measured pixel size of the scroll container. Updated via ResizeObserver. */
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  /** Current px/cm scale written each render so drag handlers can read it. */
  const pxPerCmRef = useRef(5);

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
  const canAddRow = planogram
    ? !furniture || (planogram.heightCm + physCellH <= furniture.dimensions.height + OVERFLOW_TOLERANCE_CM)
    : false;
  const canAddCol = planogram
    ? !furniture || (planogram.widthCm  + physCellW <= furniture.dimensions.width  + OVERFLOW_TOLERANCE_CM)
    : false;

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

  // ── Measure container for fit-to-view scale ──────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width:  entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

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
      heightCm: planogram.heightCm + physCellH,
      rowHeightsCm: [...curHeights, physCellH],
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
      widthCm: planogram.widthCm + physCellW,
      colWidthsCm: [...curWidths, physCellW],
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

  // ── Column / row resize via drag (free resize — total size updates) ────────
  const startColResize = (e: React.MouseEvent, colIdx: number) => {
    if (!planogram) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidths = getEffectiveColWidths(planogram);
    const capturedPlanogram = planogram;
    const capturedPxPerCm = pxPerCmRef.current;
    let finalWidths = startWidths;
    let didMove = false;
    setIsResizing('col');

    const onMove = (ev: MouseEvent) => {
      didMove = true;
      const deltaPx = ev.clientX - startX;
      const deltaCm = deltaPx / capturedPxPerCm;
      const newW = Math.min(MAX_CELL_CM_W, Math.max(MIN_CELL_CM_W, startWidths[colIdx] + deltaCm));
      finalWidths = startWidths.map((w, i) => (i === colIdx ? newW : w));
      setLocalColWidths(finalWidths);
      setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `${newW.toFixed(1)} cm` });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalColWidths(null);
      setResizeTooltip(null);
      if (!didMove) return;
      setHistory((prev) => [...prev.slice(-20), capturedPlanogram]);
      const newWidthCm = finalWidths.reduce((a, b) => a + b, 0);
      applyUpdate({ ...capturedPlanogram, colWidthsCm: finalWidths, widthCm: newWidthCm });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startRowResize = (e: React.MouseEvent, rowIdx: number) => {
    if (!planogram) return;
    e.preventDefault();
    const startY = e.clientY;
    const startHeights = getEffectiveRowHeights(planogram);
    const capturedPlanogram = planogram;
    const capturedPxPerCm = pxPerCmRef.current;
    let finalHeights = startHeights;
    let didMove = false;
    setIsResizing('row');

    const onMove = (ev: MouseEvent) => {
      didMove = true;
      const deltaPx = ev.clientY - startY;
      const deltaCm = deltaPx / capturedPxPerCm;
      const newH = Math.min(MAX_CELL_CM_H, Math.max(MIN_CELL_CM_H, startHeights[rowIdx] + deltaCm));
      finalHeights = startHeights.map((h, i) => (i === rowIdx ? newH : h));
      setLocalRowHeights(finalHeights);
      setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `${newH.toFixed(1)} cm` });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalRowHeights(null);
      setResizeTooltip(null);
      if (!didMove) return;
      setHistory((prev) => [...prev.slice(-20), capturedPlanogram]);
      const newHeightCm = finalHeights.reduce((a, b) => a + b, 0);
      applyUpdate({ ...capturedPlanogram, rowHeightsCm: finalHeights, heightCm: newHeightCm });
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
    const colWidths = getEffectiveColWidths(capturedPlanogram);
    const defaultDelta = colWidths[col] - startW0;
    const capturedPxPerCm = pxPerCmRef.current;
    let finalW0 = startW0;
    let finalW1 = startW1;
    let didMove = false;
    setIsResizing('col');

    const onMove = (ev: MouseEvent) => {
      didMove = true;
      const deltaCm = (ev.clientX - startX) / capturedPxPerCm;
      const clamped = Math.max(-(startW0 - MIN_CELL_CM_W), Math.min(startW1 - MIN_CELL_CM_W, deltaCm));
      if (Math.abs(clamped - defaultDelta) < CELL_SNAP_THRESHOLD_CM) {
        finalW0 = colWidths[col];
        finalW1 = startW0 + startW1 - finalW0;
        setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `🧲 ${finalW0.toFixed(1)} / ${finalW1.toFixed(1)} cm` });
      } else {
        finalW0 = startW0 + clamped;
        finalW1 = startW1 - clamped;
        setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `${finalW0.toFixed(1)} / ${finalW1.toFixed(1)} cm` });
      }
      setLocalCellWidthOverrides({ ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellWidthOverrides(null);
      setResizeTooltip(null);
      if (!didMove) return;
      setHistory((prev) => [...prev.slice(-20), capturedPlanogram]);
      const newOverrides = { ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 };
      if (Math.abs(finalW0 - colWidths[col]) < OVERRIDE_CLEANUP_EPSILON_CM) delete newOverrides[key0];
      if (Math.abs(finalW1 - colWidths[col + 1]) < OVERRIDE_CLEANUP_EPSILON_CM) delete newOverrides[key1];
      applyUpdate({ ...capturedPlanogram, cellWidthOverrides: newOverrides });
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
    const colWidths = getEffectiveColWidths(capturedPlanogram);
    const defaultDelta = colWidths[col - 1] - startW0;
    const capturedPxPerCm = pxPerCmRef.current;
    let finalW0 = startW0;
    let finalW1 = startW1;
    let didMove = false;
    setIsResizing('col');

    const onMove = (ev: MouseEvent) => {
      didMove = true;
      // Dragging left (negative delta) shrinks the left neighbour, grows current
      const deltaCm = (ev.clientX - startX) / capturedPxPerCm;
      const clamped = Math.max(-(startW0 - MIN_CELL_CM_W), Math.min(startW1 - MIN_CELL_CM_W, deltaCm));
      if (Math.abs(clamped - defaultDelta) < CELL_SNAP_THRESHOLD_CM) {
        finalW0 = colWidths[col - 1];
        finalW1 = startW0 + startW1 - finalW0;
        setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `🧲 ${finalW0.toFixed(1)} / ${finalW1.toFixed(1)} cm` });
      } else {
        finalW0 = startW0 + clamped;
        finalW1 = startW1 - clamped;
        setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `${finalW0.toFixed(1)} / ${finalW1.toFixed(1)} cm` });
      }
      setLocalCellWidthOverrides({ ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellWidthOverrides(null);
      setResizeTooltip(null);
      if (!didMove) return;
      setHistory((prev) => [...prev.slice(-20), capturedPlanogram]);
      const newOverrides = { ...(capturedPlanogram.cellWidthOverrides ?? {}), [key0]: finalW0, [key1]: finalW1 };
      if (Math.abs(finalW0 - colWidths[col - 1]) < OVERRIDE_CLEANUP_EPSILON_CM) delete newOverrides[key0];
      if (Math.abs(finalW1 - colWidths[col]) < OVERRIDE_CLEANUP_EPSILON_CM) delete newOverrides[key1];
      applyUpdate({ ...capturedPlanogram, cellWidthOverrides: newOverrides });
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
    const rowHeights = getEffectiveRowHeights(capturedPlanogram);
    const defaultDelta = rowHeights[row] - startH0;
    const capturedPxPerCm = pxPerCmRef.current;
    let finalH0 = startH0;
    let finalH1 = startH1;
    let didMove = false;
    setIsResizing('row');

    const onMove = (ev: MouseEvent) => {
      didMove = true;
      const deltaCm = (ev.clientY - startY) / capturedPxPerCm;
      const clamped = Math.max(-(startH0 - MIN_CELL_CM_H), Math.min(startH1 - MIN_CELL_CM_H, deltaCm));
      if (Math.abs(clamped - defaultDelta) < CELL_SNAP_THRESHOLD_CM) {
        finalH0 = rowHeights[row];
        finalH1 = startH0 + startH1 - finalH0;
        setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `🧲 ${finalH0.toFixed(1)} / ${finalH1.toFixed(1)} cm` });
      } else {
        finalH0 = startH0 + clamped;
        finalH1 = startH1 - clamped;
        setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `${finalH0.toFixed(1)} / ${finalH1.toFixed(1)} cm` });
      }
      setLocalCellHeightOverrides({ ...(capturedPlanogram.cellHeightOverrides ?? {}), [key0]: finalH0, [key1]: finalH1 });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellHeightOverrides(null);
      setResizeTooltip(null);
      if (!didMove) return;
      setHistory((prev) => [...prev.slice(-20), capturedPlanogram]);
      const newOverrides = { ...(capturedPlanogram.cellHeightOverrides ?? {}), [key0]: finalH0, [key1]: finalH1 };
      if (Math.abs(finalH0 - rowHeights[row]) < OVERRIDE_CLEANUP_EPSILON_CM) delete newOverrides[key0];
      if (Math.abs(finalH1 - rowHeights[row + 1]) < OVERRIDE_CLEANUP_EPSILON_CM) delete newOverrides[key1];
      applyUpdate({ ...capturedPlanogram, cellHeightOverrides: newOverrides });
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
    const rowHeights = getEffectiveRowHeights(capturedPlanogram);
    const defaultDelta = rowHeights[row - 1] - startH0;
    const capturedPxPerCm = pxPerCmRef.current;
    let finalH0 = startH0;
    let finalH1 = startH1;
    let didMove = false;
    setIsResizing('row');

    const onMove = (ev: MouseEvent) => {
      didMove = true;
      // Dragging up (negative delta) shrinks the top neighbour, grows current
      const deltaCm = (ev.clientY - startY) / capturedPxPerCm;
      const clamped = Math.max(-(startH0 - MIN_CELL_CM_H), Math.min(startH1 - MIN_CELL_CM_H, deltaCm));
      if (Math.abs(clamped - defaultDelta) < CELL_SNAP_THRESHOLD_CM) {
        finalH0 = rowHeights[row - 1];
        finalH1 = startH0 + startH1 - finalH0;
        setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `🧲 ${finalH0.toFixed(1)} / ${finalH1.toFixed(1)} cm` });
      } else {
        finalH0 = startH0 + clamped;
        finalH1 = startH1 - clamped;
        setResizeTooltip({ x: ev.clientX + 14, y: ev.clientY - 28, text: `${finalH0.toFixed(1)} / ${finalH1.toFixed(1)} cm` });
      }
      setLocalCellHeightOverrides({ ...(capturedPlanogram.cellHeightOverrides ?? {}), [key0]: finalH0, [key1]: finalH1 });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalCellHeightOverrides(null);
      setResizeTooltip(null);
      if (!didMove) return;
      setHistory((prev) => [...prev.slice(-20), capturedPlanogram]);
      const newOverrides = { ...(capturedPlanogram.cellHeightOverrides ?? {}), [key0]: finalH0, [key1]: finalH1 };
      if (Math.abs(finalH0 - rowHeights[row - 1]) < OVERRIDE_CLEANUP_EPSILON_CM) delete newOverrides[key0];
      if (Math.abs(finalH1 - rowHeights[row]) < OVERRIDE_CLEANUP_EPSILON_CM) delete newOverrides[key1];
      applyUpdate({ ...capturedPlanogram, cellHeightOverrides: newOverrides });
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

  // ── Unified px/cm scale — fit planogram canvas to container at zoom=1 ────────
  const availW = Math.max(1, containerSize.width  - CANVAS_PADDING_PX * 2 - RULER_SIZE_PX - 4);
  const availH = Math.max(1, containerSize.height - CANVAS_PADDING_PX * 2 - RULER_SIZE_PX - 4);
  const basePxPerCm = containerSize.width > 0
    ? Math.max(0.5, Math.min(availW / planogram.widthCm, availH / planogram.heightCm))
    : FALLBACK_PX_PER_CM; // used before the ResizeObserver fires
  const pxPerCm = Math.max(0.5, basePxPerCm * zoom);
  pxPerCmRef.current = pxPerCm;

  // Per-column and per-row cm sizes, using local drag state when resizing
  const effectiveColWidths = localColWidths ?? getEffectiveColWidths(planogram);
  const effectiveRowHeights = localRowHeights ?? getEffectiveRowHeights(planogram);
  // Per-column and per-row pixel sizes — proportional to physical cm, same scale on both axes
  const colWidthsPx = effectiveColWidths.map(w => Math.max(CELL_MIN_PX, Math.round(w * pxPerCm)));
  const rowHeightsPx = effectiveRowHeights.map(h => Math.max(CELL_MIN_PX, Math.round(h * pxPerCm)));

  // ── Per-cell effective sizes (override takes precedence over column/row default) ──
  const getCellWidthCm = (row: number, col: number): number => {
    const key = `${row}-${col}`;
    if (localCellWidthOverrides?.[key] != null) return localCellWidthOverrides[key];
    if (planogram.cellWidthOverrides?.[key] != null) return planogram.cellWidthOverrides[key];
    return effectiveColWidths[col];
  };
  const getCellWidthPx = (row: number, col: number): number =>
    Math.max(CELL_MIN_PX, Math.round(getCellWidthCm(row, col) * pxPerCm));

  const getCellHeightCm = (row: number, col: number): number => {
    const key = `${row}-${col}`;
    if (localCellHeightOverrides?.[key] != null) return localCellHeightOverrides[key];
    if (planogram.cellHeightOverrides?.[key] != null) return planogram.cellHeightOverrides[key];
    return effectiveRowHeights[row];
  };
  const getCellHeightPx = (row: number, col: number): number =>
    Math.max(CELL_MIN_PX, Math.round(getCellHeightCm(row, col) * pxPerCm));

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
            <button
              onClick={() => setZoom(1)}
              className={[
                'px-1.5 py-0.5 text-xs rounded transition-colors',
                zoom === 1
                  ? 'text-blue-400 bg-blue-500/10'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800',
              ].join(' ')}
              title="Ajuster à la vue (zoom 1:1)"
            >Fit</button>
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

      {/* Grid area — scrollable canvas */}
      <div ref={containerRef} className="flex-1 overflow-auto bg-gray-950" style={{ padding: `${CANVAS_PADDING_PX}px` }}>
        {/* Full-screen overlay to lock cursor during resize */}
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

        {/* Ruler + canvas layout */}
        <div className="inline-flex flex-col">

          {/* Top ruler — column widths in cm */}
          <div className="flex" style={{ marginLeft: `${RULER_SIZE_PX + 2}px`, marginBottom: '2px' }}>
            {Array.from({ length: cols }, (_, c) => (
              <Fragment key={c}>
                <div
                  className="text-center flex-none overflow-hidden"
                  style={{ width: `${colWidthsPx[c]}px`, fontSize: '9px', color: '#6b7280', lineHeight: 1.2 }}
                  title={`Colonne ${c + 1}: ${effectiveColWidths[c].toFixed(1)} cm`}
                >
                  {fmtRulerCm(effectiveColWidths[c])}
                </div>
                {c < cols - 1 && <div style={{ width: `${RESIZE_HANDLE_PX}px`, flexShrink: 0 }} />}
              </Fragment>
            ))}
            {/* Total width label */}
            <div className="ml-1 text-xs text-gray-700 whitespace-nowrap self-end leading-none" style={{ fontSize: '9px' }}>
              = {planogram.widthCm.toFixed(1)} cm
            </div>
          </div>

          <div className="flex">
            {/* Left ruler — row heights in cm */}
            <div className="flex flex-col" style={{ width: `${RULER_SIZE_PX}px`, marginRight: '2px' }}>
              {Array.from({ length: rows }, (_, r) => (
                <Fragment key={r}>
                  <div
                    className="flex items-center justify-end pr-1 flex-none overflow-hidden"
                    style={{ height: `${rowContainerHeightsPx[r]}px`, width: `${RULER_SIZE_PX}px`, fontSize: '9px', color: '#6b7280' }}
                    title={`Rangée ${r + 1}: ${effectiveRowHeights[r].toFixed(1)} cm`}
                  >
                    {fmtRulerCm(effectiveRowHeights[r])}
                  </div>
                  {r < rows - 1 && <div style={{ height: `${RESIZE_HANDLE_PX}px` }} />}
                </Fragment>
              ))}
              {/* Total height label */}
              <div className="text-right pr-1 text-gray-700 whitespace-nowrap mt-0.5" style={{ fontSize: '9px' }}>
                {planogram.heightCm.toFixed(1)}
              </div>
            </div>

            {/* Planogram canvas — physical face boundary */}
            <div
              className="flex flex-col"
              style={{
                border: '2px solid #374151',
                borderRadius: '2px',
                background: '#111827',
                boxShadow: '0 4px 20px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.03)',
                overflow: 'visible',
              }}
            >
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

                      // Proportional product block dimensions within cell (capped at 100%)
                      const prodBlockWPct = prod ? Math.min(100, (prod.widthCm  / cellCmW) * 100) : 0;
                      const prodBlockHPct = prod ? Math.min(100, (prod.heightCm / cellCmH) * 100) : 0;
                      // Pixel size of the actual product block (for thumbnail visibility check)
                      const prodBlockPxW = prod ? Math.round(prodBlockWPct / 100 * cellPxW) : 0;
                      const prodBlockPxH = prod ? Math.round(prodBlockHPct / 100 * cellPxH) : 0;

                      return (
                        <Fragment key={col}>
                          <div
                            onClick={() => handleCellClick(row, col)}
                            onContextMenu={(e) => { e.preventDefault(); if (cell) clearCell(row, col); }}
                            onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
                            onDragLeave={() => setDragOver(null)}
                            onDrop={(e) => handleDrop(e, row, col)}
                            className={[
                              'relative cursor-pointer select-none group flex-none',
                              isDragOver ? 'bg-blue-900/30' : '',
                              isSelected ? 'ring-2 ring-inset ring-blue-500' : '',
                              prodOverflow ? 'bg-red-900/20' : '',
                            ].join(' ')}
                            style={{
                              width:  `${cellPxW}px`,
                              height: `${cellPxH}px`,
                              borderRight: col < cols - 1 ? '1px solid #1f2937' : 'none',
                              boxSizing: 'border-box',
                              outline: prodOverflow ? '1px solid #ef4444' : undefined,
                            }}
                            title={prodOverflow && prod
                              ? `⚠ ${prod.name} (${prod.widthCm}×${prod.heightCm} cm) dépasse la cellule (${cellCmW.toFixed(1)}×${cellCmH.toFixed(1)} cm)`
                              : prod
                              ? `${prod.name} — ${prod.widthCm}×${prod.heightCm} cm dans ${cellCmW.toFixed(1)}×${cellCmH.toFixed(1)} cm`
                              : `Cellule ${row + 1}-${col + 1} (${cellCmW.toFixed(1)}×${cellCmH.toFixed(1)} cm)`}
                          >
                            {cell && prod ? (
                              <>
                                {/* Product facing: proportional to physical size, gravity to bottom */}
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: 0,
                                    left: '50%',
                                    transform: 'translateX(-50%)',
                                    width:  `${prodBlockWPct}%`,
                                    height: `${prodBlockHPct}%`,
                                    background: prodOverflow ? 'rgba(239,68,68,0.15)' : (catColor ? catColor + '28' : 'rgba(100,100,100,0.2)'),
                                    border:     `1px solid ${prodOverflow ? '#ef4444' : (catColor ? catColor + '70' : '#555')}`,
                                    borderRadius: '2px 2px 0 0',
                                    overflow: 'hidden',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                  }}
                                >
                                  {/* Product image, only shown when block is large enough */}
                                  {prodBlockPxW >= MIN_THUMBNAIL_PX && prodBlockPxH >= MIN_THUMBNAIL_PX && (
                                    isUploading ? (
                                      <div className="w-full h-full flex items-center justify-center">
                                        <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                                      </div>
                                    ) : (
                                      <ProductThumb product={prod} />
                                    )
                                  )}
                                </div>

                                {/* Product label — shown above the block when cell is tall enough */}
                                {cellPxH > MIN_CELL_HEIGHT_FOR_LABEL_PX && (
                                  <div
                                    style={{
                                      position: 'absolute',
                                      top: 2,
                                      left: 2,
                                      right: 2,
                                      fontSize: '9px',
                                      color: prodOverflow ? '#f87171' : catColor,
                                      lineHeight: 1.1,
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                      pointerEvents: 'none',
                                    }}
                                  >
                                    {prod.name.length > 18 ? prod.name.slice(0, 16) + '…' : prod.name}
                                  </div>
                                )}

                                {/* Dimension label — shown when cell is wide/tall enough */}
                                {cellPxH > MIN_CELL_HEIGHT_FOR_DIM_PX && cellPxW > MIN_CELL_WIDTH_FOR_DIM_PX && (
                                  <div
                                    style={{
                                      position: 'absolute',
                                      top: 14,
                                      left: 2,
                                      right: 2,
                                      fontSize: '8px',
                                      color: prodOverflow ? '#f87171' : '#6b7280',
                                      lineHeight: 1,
                                      pointerEvents: 'none',
                                    }}
                                  >
                                    {prod.widthCm}×{prod.heightCm} cm
                                  </div>
                                )}

                                {/* Overflow badge */}
                                {prodOverflow && (
                                  <div className="absolute bottom-1 left-1 text-red-400 leading-none pointer-events-none" style={{ fontSize: '8px' }}>
                                    ⚠
                                  </div>
                                )}

                                {/* Hover action buttons */}
                                <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                                  <button
                                    className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-blue-400 bg-gray-900/80 rounded text-xs leading-none"
                                    title="Uploader une vignette"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      pendingUploadEan.current = prod.ean;
                                      uploadInputRef.current?.click();
                                    }}
                                  >
                                    📷
                                  </button>
                                  <button
                                    className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 bg-gray-900/80 rounded text-xs leading-none"
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
                                <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 font-mono">{cell.ean.slice(-6)}</div>
                                <button
                                  className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs z-10"
                                  onClick={(e) => { e.stopPropagation(); clearCell(row, col); }}
                                >×</button>
                              </>
                            ) : (
                              // Empty cell — show drop hint
                              <div className={[
                                'absolute inset-0 border-dashed border transition-colors',
                                isDragOver
                                  ? 'border-blue-400 bg-blue-900/20'
                                  : 'border-gray-700/60 group-hover:border-gray-500/80',
                              ].join(' ')}>
                                <span className="absolute inset-0 flex items-center justify-center text-gray-700 text-xs opacity-0 group-hover:opacity-100 transition-opacity">+</span>
                              </div>
                            )}

                            {/* Selected-cell per-segment resize handles */}
                            {isSelected && col + 1 < cols && (
                              <div
                                onMouseDown={(e) => startCellRightResize(e, row, col)}
                                style={{
                                  position: 'absolute', right: 0, top: 0,
                                  width: '6px', height: '100%',
                                  cursor: 'col-resize', zIndex: 10,
                                  background: 'rgba(59,130,246,0.55)',
                                }}
                                title="Redimensionner ce segment (cette ligne seulement)"
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
                                title="Redimensionner ce segment (cette ligne seulement)"
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
                                title="Redimensionner ce segment (cette colonne seulement)"
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
                                title="Redimensionner ce segment (cette colonne seulement)"
                              />
                            )}
                          </div>

                          {/* Column resize handle — between columns only */}
                          {col < cols - 1 && (
                            <div
                              style={{ width: `${RESIZE_HANDLE_PX}px`, height: `${cellPxH}px`, cursor: 'col-resize', flexShrink: 0 }}
                              className={[
                                'transition-colors',
                                selectedCol === col || selectedCol === col + 1
                                  ? 'bg-blue-500/40 hover:bg-blue-400/70'
                                  : 'bg-gray-800/80 hover:bg-blue-500/50',
                              ].join(' ')}
                              onMouseDown={(e) => startColResize(e, col)}
                            />
                          )}
                        </Fragment>
                      );
                    })}
                  </div>

                  {/* Shelf board between rows — visual separator + row resize handle */}
                  {row < rows - 1 && (
                    <div
                      style={{ height: `${RESIZE_HANDLE_PX}px`, cursor: 'row-resize' }}
                      className={[
                        'transition-colors',
                        selectedRow === row || selectedRow === row + 1
                          ? 'bg-blue-500/40 hover:bg-blue-400/70'
                          : 'bg-gray-600/70 hover:bg-blue-500/50',
                      ].join(' ')}
                      onMouseDown={(e) => startRowResize(e, row)}
                    />
                  )}
                </Fragment>
              ))}
            </div>{/* end canvas */}
          </div>
        </div>{/* end ruler+canvas */}
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
        <span className="text-gray-600">
          Clic droit / × vider · Suppr. retirer · Ctrl+Z annuler · 📷 vignette · blocs proportionnels aux cm produit · ⟺ séparateurs (col/ligne) · cellule sélect. : ◀▶▲▼ segment · 🔴 débordement
        </span>
      </div>
    </div>
  );
}

// ─── PlanogramEditor v3 ──────────────────────────────────────────────────────
//
// Architecture:
//   • Each shelf rendered as a `position:relative` container → boxes are
//     `position:absolute`, so pixel width = box.width_cm * pxPerCmX exactly.
//     This makes fusion always show the correct summed width with no rounding.
//   • All drag computation lives in a mutable ref (dragRef) rather than in
//     closures, eliminating stale-closure elastic-bounce bugs entirely.
//   • Global mousemove/mouseup listeners are registered ONCE at mount and read
//     from dragRef on every event.
//   • A lightweight `preview` state drives live visual feedback during drag.
//
import { useState, useEffect, useRef, Fragment } from 'react';
import { usePlanogramStore } from '../../store/planogramStore';
import { useCatalogStore } from '../../store/catalogStore';
import { useSceneStore } from '../../store/sceneStore';
import { cadApi } from '../../api/cad';
import { OVERFLOW_TOLERANCE_CM } from '../../types/cad';
import type { CADProduct, Planogram } from '../../types/cad';
import type { Box, BoxKey, Gondola, Separator, Shelf } from '../../types/gondola';
import { makeBoxKey, parseBoxKey } from '../../types/gondola';
import {
  computeBoxes,
  buildBoxMap,
  getShelfByDisplayIndex,
  shelfBoxCount,
  sortedSeps,
  gondolaToLegacyPlanogram,
  legacyCellsToSeparators,
  cmdSetPlacement,
  cmdClearPlacement,
  cmdClearAllPlacements,
  cmdMoveSeparator,
  cmdRemoveSeparator,
  cmdAddShelf,
  cmdRemoveShelf,
  cmdResizeAdjacentShelves,
  cmdFuseBoxes,
  cmdSplitBox,
  cmdClearBoxesByKeys,
  findBox,
  getRowBoxes,
  extendGondolaWidth,
  shrinkGondolaWidth,
  extendGondolaHeight,
  DEFAULT_SHELF_HEIGHT_CM,
  DEFAULT_SEP_SPACING_CM,
  MIN_BOX_CM,
} from '../../engine/gondola';

// ─── Display constants ────────────────────────────────────────────────────────
const BASE_PX_PER_CM_X = 2.2;   // px per cm at zoom=1 (horizontal)
const BASE_PX_PER_CM_Y = 1.4;   // px per cm at zoom=1 (vertical)
const SEP_HANDLE_W = 8;          // px – width of draggable separator handle
const SHELF_RESIZE_H = 6;        // px – height of shelf resize strip
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.2;

const CATEGORY_COLORS: Record<string, string> = {
  'Épicerie':  '#F5C518',
  'Boissons':  '#2196F3',
  'Frais':     '#4CAF50',
  'Hygiène':   '#9C27B0',
  'Bébé':      '#FF9800',
  'Promotion': '#F44336',
};
function catColor(category: string) { return CATEGORY_COLORS[category] ?? '#9E9E9E'; }

// ─── Drag state (stored in a ref, never triggers re-render on its own) ────────
type DragState =
  | {
      type: 'sep';
      gondola: Gondola;
      shelfId: string;
      sepId: string;
      origPos: number;
      leftBound: number;
      rightBound: number;
      startX: number;
      lastPos: number;
    }
  | {
      type: 'shelf';
      gondola: Gondola;
      shelfAboveId: string;
      shelfBelowId: string;
      origHAbove: number;
      origHBelow: number;
      startY: number;
      lastHAbove: number;
      lastHBelow: number;
    };

// ─── Preview state (drives live feedback, minimal re-renders) ─────────────────
interface Preview {
  sepPositions?: Map<string, number>;
  shelfHeights?: Map<string, number>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function DefaultThumb({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
      <rect x="2" y="2" width="36" height="36" rx="3" fill={color + '33'} stroke={color} strokeWidth="1.5" />
      <rect x="8" y="12" width="24" height="3" rx="1.5" fill={color + 'aa'} />
      <rect x="8" y="19" width="18" height="2" rx="1" fill={color + '77'} />
      <rect x="8" y="25" width="14" height="2" rx="1" fill={color + '55'} />
    </svg>
  );
}
function ProductThumb({ product }: { product: CADProduct }) {
  const color = catColor(product.category);
  const [imgErr, setImgErr] = useState(false);
  if (product.imageUrl && !imgErr) {
    return <img src={product.imageUrl} alt={product.name} className="w-full h-full object-contain" onError={() => setImgErr(true)} />;
  }
  return <DefaultThumb color={color} />;
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface PlanogramEditorProps {
  projectId: string | null;
  planogramId: string;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function PlanogramEditor({ projectId, planogramId, onClose }: PlanogramEditorProps) {
  // ── Core gondola state ────────────────────────────────────────────────────
  const [gondola,  setGondola]  = useState<Gondola | null>(null);
  const [boxes,    setBoxes]    = useState<Box[]>([]);
  const [boxMap,   setBoxMap]   = useState<Map<BoxKey, Box>>(new Map());
  const [planogramBase, setPlanogramBase] = useState<
    Omit<Planogram,'rows'|'cols'|'widthCm'|'heightCm'|'cells'|'colWidthsCm'|'rowHeightsCm'|'rowColCounts'|'cellWidthOverrides'|'cellHeightOverrides'|'mergedSpans'> & { gondola?: Gondola }
  | null>(null);

  // ── History ───────────────────────────────────────────────────────────────
  const [history, setHistory] = useState<Gondola[]>([]);
  const [future,  setFuture]  = useState<Gondola[]>([]);

  // ── Selection ─────────────────────────────────────────────────────────────
  const [selectedKey,     setSelectedKey]     = useState<BoxKey | null>(null);
  const [selectedKeys,    setSelectedKeys]    = useState<Set<BoxKey>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<BoxKey | null>(null);
  const [selectedHeaderRow, setSelectedHeaderRow] = useState<number | null>(null);
  const [selectedHeaderCol, setSelectedHeaderCol] = useState<number | null>(null);
  const [selectedSep, setSelectedSep] = useState<{ shelfId: string; sepId: string } | null>(null);

  // ── Drag (product DnD) ────────────────────────────────────────────────────
  const internalDragSrcRef = useRef<{ displayRow: number; boxIndex: number; ean: string } | null>(null);
  const [dragOver,         setDragOver]         = useState<BoxKey | null>(null);
  const [internalDragOver, setInternalDragOver] = useState<BoxKey | null>(null);

  // ── Resize (ref-based, stable) ────────────────────────────────────────────
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<Preview>({});
  const [resizeCursor, setResizeCursor] = useState<'col-resize' | 'row-resize' | null>(null);

  // ── UI ────────────────────────────────────────────────────────────────────
  const [zoom,           setZoom]           = useState(1.5);
  const [loading,        setLoading]        = useState(true);
  const [loadError,      setLoadError]      = useState<string | null>(null);
  const [uploadingEan,   setUploadingEan]   = useState<string | null>(null);
  const [crushNavIdx,    setCrushNavIdx]    = useState(0);
  const [clearAllConfirm, setClearAllConfirm] = useState(false);

  // ── Context menu ──────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number;
    di: number; bi: number;
    box: Box;
  } | null>(null);

  const saveTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadEan = useRef<string | null>(null);

  // Always-current refs used by stable drag event handlers
  const pxPerCmXRef    = useRef(BASE_PX_PER_CM_X * zoom);
  const pxPerCmYRef    = useRef(BASE_PX_PER_CM_Y * zoom);
  const applyGondolaRef = useRef<(g: Gondola) => void>(() => {});
  const pushHistoryRef  = useRef<() => void>(() => {});
  const gondolaRef      = useRef<Gondola | null>(null);

  const { setActivePlanogram } = usePlanogramStore();
  const { products, selectedEan, addRecentlyUsed, setProducts, selectProduct } = useCatalogStore();
  const { scene, updateFurniture } = useSceneStore();
  const productByEan = new Map(products.map(p => [p.ean, p] as const));

  // ── Derived geometry ──────────────────────────────────────────────────────
  const shelfCount  = gondola?.shelves.length ?? 0;
  const maxBoxCount = gondola ? Math.max(...gondola.shelves.map(s => shelfBoxCount(s)), 1) : 0;

  const furniture = gondola
    ? scene?.furniture.find(f => planogramBase && f.id === planogramBase.furnitureId)
    : null;
  const isOverflowing = gondola && furniture
    ? gondola.width_cm  > furniture.dimensions.width  + OVERFLOW_TOLERANCE_CM ||
      gondola.height_cm > furniture.dimensions.height + OVERFLOW_TOLERANCE_CM
    : false;

  // Absorber shelf for the pending add-row operation.
  // When selectedHeaderRow > 0 the shelf physically above it gives up height;
  // otherwise (no selection or top row) the top shelf absorbs.
  const _addRowAbsorberShelf = (() => {
    if (!gondola) return null;
    if (selectedHeaderRow !== null && selectedHeaderRow > 0) {
      return getShelfByDisplayIndex(gondola, selectedHeaderRow - 1) ?? null;
    }
    return gondola.shelves[gondola.shelves.length - 1] ?? null;
  })();

  // New row height = half the absorber shelf height, clamped to [MIN_BOX_CM, DEFAULT_SHELF_HEIGHT_CM].
  // When the absorber shelf is too small to split, extendGondolaHeight will be used instead
  // and the new shelf will get DEFAULT_SHELF_HEIGHT_CM.
  const defaultRowH = _addRowAbsorberShelf
    ? Math.max(MIN_BOX_CM, Math.min(DEFAULT_SHELF_HEIGHT_CM, _addRowAbsorberShelf.height_cm / 2))
    : DEFAULT_SHELF_HEIGHT_CM;

  // Row can always be added: either by splitting the absorber shelf (when tall enough)
  // or by extending the gondola height (and syncing the furniture).
  const canAddRow = gondola !== null;

  // Column add always grows the gondola width; the only limit is a reasonable minimum width.
  const canAddCol = gondola !== null;

  // Column remove is possible when there is more than one column on at least one shelf.
  const canRemoveCol = gondola
    ? gondola.shelves.some(s => s.separators.length >= 3)
    : false;

  // ── px / cm conversion ────────────────────────────────────────────────────
  const pxPerCmX = BASE_PX_PER_CM_X * zoom;
  const pxPerCmY = BASE_PX_PER_CM_Y * zoom;

  // Keep refs current every render
  useEffect(() => {
    pxPerCmXRef.current = pxPerCmX;
    pxPerCmYRef.current = pxPerCmY;
    gondolaRef.current  = gondola;
  });

  // ── Load planogram ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setLoadError(null);
    setSelectedKey(null);
    setSelectedKeys(new Set());
    cadApi.getPlanogram(projectId, planogramId)
      .then(p => {
        const g: Gondola = p.gondola ?? legacyCellsToSeparators(p);
        const bs = computeBoxes(g);
        setGondola(g);
        setBoxes(bs);
        setBoxMap(buildBoxMap(bs));
        const {
          rows: _rows, cols: _cols, widthCm: _widthCm, heightCm: _heightCm,
          cells: _cells, colWidthsCm: _colWidths, rowHeightsCm: _rowHeights,
          rowColCounts: _rowColCounts, cellWidthOverrides: _cellWidthOverrides,
          cellHeightOverrides: _cellHeightOverrides, mergedSpans: _mergedSpans,
          gondola: _gondola, ...base
        } = p;
        setPlanogramBase({ ...base, gondola: g });
        setActivePlanogram(gondolaToLegacyPlanogram(g, { ...base, gondola: g }));
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('[404]')) {
          setLoadError('Ce planogramme est introuvable (404). Il a peut-être été supprimé ou n\'a pas encore été créé.');
        } else {
          setLoadError('Erreur lors du chargement du planogramme. Veuillez réessayer.');
        }
        console.error(err);
      })
      .finally(() => setLoading(false));
  }, [projectId, planogramId, setActivePlanogram]);

  // ── Auto-save ─────────────────────────────────────────────────────────────
  const scheduleSave = (lp: Planogram) => {
    if (!projectId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      cadApi.updatePlanogram(projectId, lp.id, lp).catch(console.error);
    }, 500);
  };

  // ── Apply gondola (core update) ───────────────────────────────────────────
  const applyGondola = (g: Gondola) => {
    const bs = computeBoxes(g);
    setGondola(g);
    setBoxes(bs);
    setBoxMap(buildBoxMap(bs));
    setFuture([]);
    if (planogramBase) {
      const lp = gondolaToLegacyPlanogram(g, { ...planogramBase, gondola: g });
      setActivePlanogram(lp);
      scheduleSave(lp);
    }
  };
  // Keep ref current
  useEffect(() => { applyGondolaRef.current = applyGondola; });

  const pushHistory = () => {
    if (gondola) setHistory(prev => [...prev.slice(-20), gondola]);
  };
  useEffect(() => { pushHistoryRef.current = pushHistory; });

  // ─────────────────────────────────────────────────────────────────────────
  // ── Stable global drag handlers (registered once, read from refs) ────────
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.type === 'sep') {
        const delta  = (e.clientX - drag.startX) / pxPerCmXRef.current;
        const newPos = Math.max(drag.leftBound, Math.min(drag.rightBound, drag.origPos + delta));
        drag.lastPos = newPos;
        setPreview({ sepPositions: new Map([[drag.sepId, newPos]]) });
      } else {
        const delta   = (e.clientY - drag.startY) / pxPerCmYRef.current;
        const clamped = Math.max(-(drag.origHAbove - MIN_BOX_CM), Math.min(drag.origHBelow - MIN_BOX_CM, delta));
        drag.lastHAbove = drag.origHAbove + clamped;
        drag.lastHBelow = drag.origHBelow - clamped;
        setPreview({ shelfHeights: new Map([[drag.shelfAboveId, drag.lastHAbove], [drag.shelfBelowId, drag.lastHBelow]]) });
      }
    };

    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setPreview({});
      setResizeCursor(null);
      document.body.style.userSelect = '';

      if (drag.type === 'sep') {
        if (drag.lastPos !== drag.origPos) {
          pushHistoryRef.current();
          applyGondolaRef.current(
            cmdMoveSeparator(drag.gondola, drag.shelfId, drag.sepId, drag.lastPos)
          );
        }
      } else {
        if (drag.lastHAbove !== drag.origHAbove) {
          pushHistoryRef.current();
          applyGondolaRef.current(
            cmdResizeAdjacentShelves(drag.gondola, drag.shelfAboveId, drag.lastHAbove, drag.shelfBelowId, drag.lastHBelow)
          );
        }
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, []); // ← empty deps: register once; the closures (onMove/onUp) read from refs on every event

  // ── Start sep drag ────────────────────────────────────────────────────────
  const startSepDrag = (e: React.MouseEvent, shelf: Shelf, sep: Separator) => {
    if (!gondola || !sep.movable) return;
    e.preventDefault();
    e.stopPropagation();
    const seps = sortedSeps(shelf);
    const idx  = seps.findIndex(s => s.id === sep.id);
    if (idx <= 0 || idx >= seps.length - 1) return;
    dragRef.current = {
      type:       'sep',
      gondola,
      shelfId:    shelf.id,
      sepId:      sep.id,
      origPos:    sep.position_cm,
      leftBound:  seps[idx - 1].position_cm + MIN_BOX_CM,
      rightBound: seps[idx + 1].position_cm - MIN_BOX_CM,
      startX:     e.clientX,
      lastPos:    sep.position_cm,
    };
    document.body.style.userSelect = 'none';
    setResizeCursor('col-resize');
  };

  // ── Start shelf-height drag ───────────────────────────────────────────────
  const startShelfDrag = (e: React.MouseEvent, displayRow: number) => {
    if (!gondola || displayRow + 1 >= shelfCount) return;
    e.preventDefault();
    const shelfAbove = getShelfByDisplayIndex(gondola, displayRow);
    const shelfBelow = getShelfByDisplayIndex(gondola, displayRow + 1);
    if (!shelfAbove || !shelfBelow) return;
    dragRef.current = {
      type:         'shelf',
      gondola,
      shelfAboveId: shelfAbove.id,
      shelfBelowId: shelfBelow.id,
      origHAbove:   shelfAbove.height_cm,
      origHBelow:   shelfBelow.height_cm,
      startY:       e.clientY,
      lastHAbove:   shelfAbove.height_cm,
      lastHBelow:   shelfBelow.height_cm,
    };
    document.body.style.userSelect = 'none';
    setResizeCursor('row-resize');
  };

  // ── Preview helpers ───────────────────────────────────────────────────────
  /** Returns the current (possibly preview) height of a shelf in pixels. */
  const shelfHeightPx = (shelf: Shelf) =>
    Math.max(24, (preview.shelfHeights?.get(shelf.id) ?? shelf.height_cm) * pxPerCmY);

  /** Returns absolute left/width for a box, accounting for sep preview. */
  const boxRect = (box: Box, shelf: Shelf): { x: number; w: number } => {
    if (preview.sepPositions) {
      const seps = sortedSeps(shelf);
      const lSep = seps.find(s => s.id === box.leftSeparatorId);
      const rSep = seps.find(s => s.id === box.rightSeparatorId);
      const lPos = preview.sepPositions.get(lSep?.id ?? '') ?? lSep?.position_cm ?? box.x_cm;
      const rPos = preview.sepPositions.get(rSep?.id ?? '') ?? rSep?.position_cm ?? (box.x_cm + box.width_cm);
      return { x: lPos * pxPerCmX, w: Math.max(0, rPos - lPos) * pxPerCmX };
    }
    return { x: box.x_cm * pxPerCmX, w: box.width_cm * pxPerCmX };
  };

  // ── Product operations ────────────────────────────────────────────────────
  const fillBox = (di: number, bi: number, ean: string) => {
    if (!gondola) return;
    const box = findBox(boxes, di, bi);
    if (!box) return;
    pushHistory();
    applyGondola(cmdSetPlacement(gondola, box.shelfId, box.leftSeparatorId, box.rightSeparatorId, ean));
    addRecentlyUsed(ean);
    selectProduct(ean);
  };

  const clearBox = (di: number, bi: number) => {
    if (!gondola) return;
    const box = findBox(boxes, di, bi);
    if (!box) return;
    pushHistory();
    applyGondola(cmdClearPlacement(gondola, box.shelfId, box.leftSeparatorId, box.rightSeparatorId));
    setSelectedKey(null); setSelectedKeys(new Set());
  };

  const moveBox = (srcRow: number, srcCol: number, dstRow: number, dstCol: number) => {
    if (!gondola || (srcRow === dstRow && srcCol === dstCol)) return;
    const srcBox = findBox(boxes, srcRow, srcCol);
    if (!srcBox?.placement) return;
    const dstBox = findBox(boxes, dstRow, dstCol);
    pushHistory();
    const ean = srcBox.placement.productId;
    const rot = srcBox.placement.rotation;
    let g = cmdClearPlacement(gondola, srcBox.shelfId, srcBox.leftSeparatorId, srcBox.rightSeparatorId);
    if (dstBox?.placement) {
      g = cmdSetPlacement(g, srcBox.shelfId, srcBox.leftSeparatorId, srcBox.rightSeparatorId,
        dstBox.placement.productId, dstBox.placement.rotation ?? 0);
    }
    g = cmdSetPlacement(g, dstBox!.shelfId, dstBox!.leftSeparatorId, dstBox!.rightSeparatorId, ean, rot ?? 0);
    applyGondola(g);
  };

  const clearSelectedBoxes = () => {
    if (!gondola || selectedKeys.size === 0) return;
    pushHistory();
    applyGondola(cmdClearBoxesByKeys(gondola, boxes, selectedKeys));
    setSelectedKey(null); setSelectedKeys(new Set());
  };

  const fillSelectedBoxes = (ean: string) => {
    if (!gondola || selectedKeys.size === 0) return;
    pushHistory();
    let g = gondola;
    for (const key of selectedKeys) {
      const parsed = parseBoxKey(key);
      if (!parsed) continue;
      const [di, bi] = parsed;
      const box = findBox(boxes, di, bi);
      if (box) g = cmdSetPlacement(g, box.shelfId, box.leftSeparatorId, box.rightSeparatorId, ean);
    }
    applyGondola(g);
    addRecentlyUsed(ean);
  };

  const clearAll = () => {
    if (!gondola) return;
    pushHistory();
    applyGondola(cmdClearAllPlacements(gondola));
    setSelectedKey(null); setSelectedKeys(new Set()); setClearAllConfirm(false);
  };

  // ── Row management ────────────────────────────────────────────────────────
  const _doAddRow = () => {
    if (!gondola) return;
    pushHistory();
    const insertAboveShelfId = selectedHeaderRow !== null
      ? getShelfByDisplayIndex(gondola, selectedHeaderRow)?.id : undefined;
    // Attempt to split the absorber shelf (classic behaviour — total height unchanged)
    const g = cmdAddShelf(gondola, defaultRowH, insertAboveShelfId);
    if (g !== gondola) {
      // cmdAddShelf succeeded
      applyGondola(g);
    } else {
      // Absorber shelf too small to split — grow the gondola height and sync the furniture
      const grown = extendGondolaHeight(gondola, defaultRowH, insertAboveShelfId);
      applyGondola(grown);
      syncFurnitureDimension(undefined, grown.height_cm);
    }
    setSelectedHeaderRow(selectedHeaderRow !== null ? selectedHeaderRow : 0);
  };

  const addRow = () => {
    if (!gondola) return;
    _doAddRow();
  };

  const removeRow = () => {
    if (!gondola || shelfCount <= 1) return;
    const shelf = getShelfByDisplayIndex(gondola, selectedHeaderRow ?? 0);
    if (!shelf) return;
    pushHistory();
    applyGondola(cmdRemoveShelf(gondola, shelf.id));
    if (selectedHeaderRow !== null) setSelectedHeaderRow(Math.min(selectedHeaderRow, shelfCount - 2));
  };

  // ── Column (separator) management ────────────────────────────────────────

  /** After a gondola dimension change, update the linked furniture in the scene store and persist to the API. */
  const syncFurnitureDimension = (newWidthCm?: number, newHeightCm?: number) => {
    if (!planogramBase || !scene) return;
    if (newWidthCm === undefined && newHeightCm === undefined) return;
    const fur = scene.furniture.find(f => f.id === planogramBase.furnitureId);
    if (!fur) return;
    const face = planogramBase.face;
    let updatedDims = { ...fur.dimensions };
    if (newWidthCm !== undefined) {
      if (face === 'front' || face === 'back') {
        updatedDims = { ...updatedDims, width: newWidthCm };
      } else if (face === 'left' || face === 'right') {
        updatedDims = { ...updatedDims, depth: newWidthCm };
      } else {
        // top/bottom: treat as width
        updatedDims = { ...updatedDims, width: newWidthCm };
      }
    }
    if (newHeightCm !== undefined) {
      updatedDims = { ...updatedDims, height: newHeightCm };
    }
    const updated = { ...fur, dimensions: updatedDims };
    updateFurniture(updated);
    if (projectId) cadApi.updateFurniture(projectId, fur.id, updated).catch(console.error);
  };

  const addCol = () => {
    if (!gondola || !canAddCol) return;
    pushHistory();
    // Grow the gondola width by DEFAULT_SEP_SPACING_CM on all shelves.
    const newWidthCm = gondola.width_cm + DEFAULT_SEP_SPACING_CM;
    const g = extendGondolaWidth(gondola, newWidthCm);
    applyGondola(g);
    syncFurnitureDimension(newWidthCm);
  };

  const removeCol = () => {
    if (!gondola || !canRemoveCol) return;
    pushHistory();
    const shelfId = selectedHeaderRow !== null
      ? getShelfByDisplayIndex(gondola, selectedHeaderRow)?.id
      : undefined;
    const g = shrinkGondolaWidth(gondola, shelfId);
    if (g === gondola) return; // nothing changed
    applyGondola(g);
    syncFurnitureDimension(g.width_cm);
  };

  // ── Fuse / split ──────────────────────────────────────────────────────────
  const fuseSelectedBoxes = () => {
    if (!gondola || selectedKeys.size < 2) return;
    const parsed = [...selectedKeys].map(k => parseBoxKey(k)).filter((p): p is [number, number] => p !== null);
    const rowSet = new Set(parsed.map(([r]) => r));
    if (rowSet.size !== 1) return;
    const di = parsed[0][0];
    const shelf = getShelfByDisplayIndex(gondola, di);
    if (!shelf) return;
    const sortedCols = parsed.map(([, c]) => c).sort((a, b) => a - b);
    for (let i = 1; i < sortedCols.length; i++) if (sortedCols[i] !== sortedCols[i - 1] + 1) return;
    const rowBoxes = getRowBoxes(boxes, di);
    const leftBox  = rowBoxes[sortedCols[0]];
    const rightBox = rowBoxes[sortedCols[sortedCols.length - 1]];
    if (!leftBox || !rightBox) return;
    pushHistory();
    applyGondola(cmdFuseBoxes(gondola, shelf.id, leftBox.leftSeparatorId, rightBox.rightSeparatorId));
    setSelectedKey(null); setSelectedKeys(new Set());
  };

  const splitSelectedBox = () => {
    if (!gondola || !selectedKey) return;
    const parsed = parseBoxKey(selectedKey);
    if (!parsed) return;
    const [di, bi] = parsed;
    const box = findBox(boxes, di, bi);
    if (!box) return;
    const shelf = getShelfByDisplayIndex(gondola, di);
    if (!shelf) return;
    pushHistory();
    applyGondola(cmdSplitBox(gondola, shelf.id, box.leftSeparatorId, box.rightSeparatorId, box.x_cm + box.width_cm / 2));
    setSelectedKey(null); setSelectedKeys(new Set());
  };

  const deleteBox = (di: number, bi: number) => {
    if (!gondola) return;
    const box = findBox(boxes, di, bi);
    if (!box || box.placement) return;
    const shelf = getShelfByDisplayIndex(gondola, di);
    if (!shelf) return;
    const rowBoxes = getRowBoxes(boxes, di);
    if (rowBoxes.length <= 1) return;
    const seps = sortedSeps(shelf);
    const isLast = bi === rowBoxes.length - 1;
    const sepToRemove = isLast
      ? seps.find(s => s.id === box.leftSeparatorId)
      : seps.find(s => s.id === box.rightSeparatorId);
    if (!sepToRemove || !sepToRemove.movable) return;
    pushHistory();
    applyGondola(cmdRemoveSeparator(gondola, shelf.id, sepToRemove.id));
    if (selectedKey === makeBoxKey(di, bi)) { setSelectedKey(null); setSelectedKeys(new Set()); }
  };

  // ── Context menu merge/split ──────────────────────────────────────────────
  const fuseWithNeighbor = (di: number, bi: number, direction: 'left' | 'right') => {
    if (!gondola) return;
    const rowBoxes = getRowBoxes(boxes, di);
    const box = rowBoxes[bi];
    const neighbor = direction === 'right' ? rowBoxes[bi + 1] : rowBoxes[bi - 1];
    if (!box || !neighbor) return;
    const shelf = getShelfByDisplayIndex(gondola, di);
    if (!shelf) return;
    const leftBox  = direction === 'right' ? box : neighbor;
    const rightBox = direction === 'right' ? neighbor : box;
    pushHistory();
    applyGondola(cmdFuseBoxes(gondola, shelf.id, leftBox.leftSeparatorId, rightBox.rightSeparatorId));
    setSelectedKey(null); setSelectedKeys(new Set());
    setCtxMenu(null);
  };

  const splitBox = (di: number, bi: number) => {
    if (!gondola) return;
    const box = findBox(boxes, di, bi);
    if (!box) return;
    const shelf = getShelfByDisplayIndex(gondola, di);
    if (!shelf) return;
    pushHistory();
    applyGondola(cmdSplitBox(gondola, shelf.id, box.leftSeparatorId, box.rightSeparatorId, box.x_cm + box.width_cm / 2));
    setSelectedKey(null); setSelectedKeys(new Set());
    setCtxMenu(null);
  };

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  const undo = () => {
    setSelectedSep(null);
    setHistory(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (gondola) setFuture(f => [...f.slice(-20), gondola]);
      const bs = computeBoxes(last);
      setGondola(last); setBoxes(bs); setBoxMap(buildBoxMap(bs));
      if (planogramBase) {
        const lp = gondolaToLegacyPlanogram(last, { ...planogramBase, gondola: last });
        setActivePlanogram(lp); scheduleSave(lp);
      }
      return prev.slice(0, -1);
    });
  };
  const redo = () => {
    setSelectedSep(null);
    setFuture(prev => {
      if (prev.length === 0) return prev;
      const next = prev[prev.length - 1];
      if (gondola) setHistory(h => [...h.slice(-20), gondola]);
      const bs = computeBoxes(next);
      setGondola(next); setBoxes(bs); setBoxMap(buildBoxMap(bs));
      if (planogramBase) {
        const lp = gondolaToLegacyPlanogram(next, { ...planogramBase, gondola: next });
        setActivePlanogram(lp); scheduleSave(lp);
      }
      return prev.slice(0, -1);
    });
  };

  // ── Image upload ──────────────────────────────────────────────────────────
  const handleImageUpload = async (ean: string, file: File) => {
    if (!projectId) return;
    setUploadingEan(ean);
    try {
      const res = await cadApi.uploadProductImage(projectId, ean, file);
      setProducts(products.map(p => p.ean === ean ? { ...p, imageUrl: res.imageUrl } : p));
    } catch (err) { console.error(err); }
    finally { setUploadingEan(null); }
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { setCtxMenu(null); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (((e.ctrlKey || e.metaKey) && e.key === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')) {
      e.preventDefault(); redo(); return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedSep) {
        const shelf = gondola?.shelves.find(s => s.id === selectedSep.shelfId);
        const sep   = shelf?.separators.find(s => s.id === selectedSep.sepId);
        if (sep?.movable) {
          e.preventDefault();
          pushHistory();
          applyGondola(cmdRemoveSeparator(gondola!, shelf!.id, sep.id));
          setSelectedSep(null);
        }
        return;
      }
      if (selectedKeys.size > 1) clearSelectedBoxes();
      else if (selectedKey) {
        const parsed = parseBoxKey(selectedKey);
        if (parsed) clearBox(parsed[0], parsed[1]);
      }
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ── Box click ─────────────────────────────────────────────────────────────
  const handleBoxClick = (di: number, bi: number, e: React.MouseEvent) => {
    setSelectedHeaderCol(null); setSelectedHeaderRow(null); setSelectedSep(null);
    const key = makeBoxKey(di, bi);
    if (e.ctrlKey || e.metaKey) {
      setSelectedKeys(prev => {
        const n = new Set(prev);
        // Seed the multi-selection with the previously single-selected cell so that
        // a simple "click A then Ctrl+click B" produces {A, B} and enables Fusionner.
        if (selectedKey && !n.has(selectedKey)) n.add(selectedKey);
        if (n.has(key)) { n.delete(key); } else { n.add(key); }
        return n;
      });
      setSelectedKey(key); setLastSelectedKey(key);
      return;
    }
    if (e.shiftKey && lastSelectedKey && gondola) {
      const [r0, c0] = parseBoxKey(lastSelectedKey) ?? [di, bi];
      const rMin = Math.min(r0, di); const rMax = Math.max(r0, di);
      const cMin = Math.min(c0, bi); const cMax = Math.max(c0, bi);
      const range = new Set<string>();
      for (let r = rMin; r <= rMax; r++)
        for (let c = cMin; c <= cMax; c++) range.add(makeBoxKey(r, c));
      setSelectedKeys(range); setSelectedKey(key);
      return;
    }
    setSelectedKeys(new Set());
    setLastSelectedKey(key);
    const box = boxMap.get(key);
    if (selectedEan) { fillBox(di, bi, selectedEan); return; }
    setSelectedKey(key === selectedKey ? null : key);
  };

  const handleDrop = (e: React.DragEvent, di: number, bi: number) => {
    e.preventDefault(); setDragOver(null); setInternalDragOver(null);
    const src = internalDragSrcRef.current;
    if (src) { internalDragSrcRef.current = null; moveBox(src.displayRow, src.boxIndex, di, bi); return; }
    const ean = e.dataTransfer.getData('text/plain').trim();
    if (ean) fillBox(di, bi, ean);
  };

  // ── Computed for render ───────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 w-full h-full bg-gray-900">
        <p className="text-red-400 text-sm text-center max-w-xs">{loadError}</p>
        <button
          className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded"
          onClick={onClose}
        >
          Fermer
        </button>
      </div>
    );
  }

  if (loading || !gondola) {
    return loading
      ? (<div className="flex items-center justify-center w-full h-full bg-gray-900"><div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>)
      : (<div className="flex items-center justify-center w-full h-full bg-gray-900"><p className="text-gray-500 text-sm">Chargement échoué</p></div>);
  }

  const gondolaWidthPx = gondola.width_cm * pxPerCmX;

  const crushedBoxes: { key: BoxKey; di: number; bi: number; prod: CADProduct }[] = [];
  for (const box of boxes) {
    if (!box.placement) continue;
    const prod = productByEan.get(box.placement.productId);
    if (!prod) continue;
    if (prod.widthCm > box.width_cm + OVERFLOW_TOLERANCE_CM || prod.heightCm > box.height_cm + OVERFLOW_TOLERANCE_CM)
      crushedBoxes.push({ key: makeBoxKey(box.shelfDisplayIndex, box.boxIndex), di: box.shelfDisplayIndex, bi: box.boxIndex, prod });
  }

  const canFuse = (() => {
    if (selectedKeys.size < 2) return false;
    const parsed = [...selectedKeys].map(k => parseBoxKey(k)).filter((p): p is [number, number] => p !== null);
    if (new Set(parsed.map(([r]) => r)).size !== 1) return false;
    const cols = parsed.map(([, c]) => c).sort((a, b) => a - b);
    for (let i = 1; i < cols.length; i++) if (cols[i] !== cols[i - 1] + 1) return false;
    return true;
  })();

  const canSplit = (() => {
    if (!selectedKey || selectedKeys.size > 1) return false;
    const parsed = parseBoxKey(selectedKey);
    if (!parsed) return false;
    const box = findBox(boxes, parsed[0], parsed[1]);
    return !!box && box.width_cm > 2 * MIN_BOX_CM;
  })();

  const canDeleteBox = (() => {
    if (!selectedKey || selectedKeys.size > 1) return false;
    const parsed = parseBoxKey(selectedKey);
    if (!parsed) return false;
    const [di, bi] = parsed;
    const box = findBox(boxes, di, bi);
    if (!box || box.placement) return false;
    return getRowBoxes(boxes, di).length > 1;
  })();

  const rowFillCm = Array.from({ length: shelfCount }, (_, di) =>
    getRowBoxes(boxes, di).reduce((s, b) => s + b.width_cm, 0));

  const scrollToCrushed = (idx: number) => {
    if (!crushedBoxes.length) return;
    const t = crushedBoxes[idx % crushedBoxes.length];
    setSelectedKey(t.key); setSelectedKeys(new Set());
    setTimeout(() => document.querySelector<HTMLElement>(`[data-box-key="${t.key}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }), 0);
  };

  const [selDi, selBi] = selectedKey ? (parseBoxKey(selectedKey) ?? [null, null]) : [null, null];

  // ─────────────────────────────────────────────────────────────────────────
  // ── Render ────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-gray-900" style={{ cursor: resizeCursor ?? undefined }}>

      {/* ── Resize overlay (blocks pointer events during drag) ── */}
      {resizeCursor && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, cursor: resizeCursor }} />
      )}

      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 shrink-0 flex-wrap">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-200 truncate">{planogramBase?.name ?? planogramId}</h2>
          <p className="text-xs text-gray-500">
            {shelfCount} ligne{shelfCount !== 1 ? 's' : ''}
            &nbsp;·&nbsp;{gondola.width_cm.toFixed(1)} × {gondola.height_cm.toFixed(1)} cm
            &nbsp;·&nbsp;{gondola.productPlacements.length} produit{gondola.productPlacements.length !== 1 ? 's' : ''}
          </p>
        </div>

        <input ref={uploadInputRef} type="file" accept="image/*" className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]; const ean = pendingUploadEan.current;
            if (file && ean) void handleImageUpload(ean, file);
            e.target.value = ''; pendingUploadEan.current = null;
          }} />

        {/* Rows */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-600">Lignes</span>
          <button onClick={removeRow} disabled={shelfCount <= 1} title="Supprimer une ligne"
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm">−</button>
          <span className="text-xs text-gray-400 w-5 text-center">{shelfCount}</span>
          <button onClick={addRow} disabled={!canAddRow} title={canAddRow ? 'Ajouter une ligne' : 'Limite atteinte'}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm">+</button>
        </div>
        <div className="h-4 w-px bg-gray-700" />
        {/* Cols */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-600">Colonnes</span>
          <button onClick={removeCol} disabled={!canRemoveCol} title="Retirer une colonne"
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm">−</button>
          <span className="text-xs text-gray-400 w-5 text-center">{maxBoxCount}</span>
          <button onClick={addCol} disabled={!canAddCol} title={canAddCol ? 'Ajouter une colonne' : 'Limite atteinte'}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm">+</button>
        </div>
        <div className="h-4 w-px bg-gray-700" />
        {/* Zoom */}
        <div className="flex items-center gap-1">
          <button onClick={() => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-sm">−</button>
          <span className="text-xs text-gray-500 w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-sm">+</button>
        </div>
        <div className="h-4 w-px bg-gray-700" />
        {/* Undo/Redo */}
        <button onClick={undo} disabled={history.length === 0}
          className="px-2 py-1 text-xs rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30">↩ Annuler</button>
        <button onClick={redo} disabled={future.length === 0}
          className="px-2 py-1 text-xs rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30">↪ Rétablir</button>
        {/* Crush badge */}
        {crushedBoxes.length > 0 && (
          <button onClick={() => { scrollToCrushed(crushNavIdx); setCrushNavIdx(i => i + 1); }}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-800/60 hover:bg-red-700/80 text-red-300 text-xs">
            ⚠ {crushedBoxes.length} conflit{crushedBoxes.length > 1 ? 's' : ''}
          </button>
        )}
        <div className="h-4 w-px bg-gray-700" />
        {/* Clear all */}
        {!clearAllConfirm
          ? <button onClick={() => setClearAllConfirm(true)} disabled={gondola.productPlacements.length === 0}
              className="px-2 py-0.5 text-xs rounded hover:bg-red-900/50 text-gray-400 hover:text-red-300 disabled:opacity-30">🗑 Tout vider</button>
          : <span className="flex items-center gap-1">
              <span className="text-xs text-red-300">Confirmer ?</span>
              <button onClick={clearAll} className="px-2 py-0.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white">Oui</button>
              <button onClick={() => setClearAllConfirm(false)} className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200">Non</button>
            </span>
        }
        {/* Multi-select actions */}
        {selectedKeys.size > 1 && (<>
          <div className="h-4 w-px bg-gray-700" />
          <button onClick={clearSelectedBoxes} className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-red-800/50 text-gray-300">Vider ({selectedKeys.size})</button>
          {selectedEan && <button onClick={() => fillSelectedBoxes(selectedEan)} className="px-2 py-0.5 text-xs rounded bg-blue-800/50 hover:bg-blue-700/70 text-blue-200">Appliquer ({selectedKeys.size})</button>}
          {canFuse && <button onClick={fuseSelectedBoxes} className="px-2 py-0.5 text-xs rounded bg-violet-800/50 hover:bg-violet-700/70 text-violet-200">⊞ Fusionner</button>}
        </>)}
        {/* Single-box actions */}
        {(canSplit || canDeleteBox) && selectedKeys.size <= 1 && (<>
          <div className="h-4 w-px bg-gray-700" />
          {canSplit && <button onClick={splitSelectedBox} className="px-2 py-0.5 text-xs rounded bg-violet-800/50 hover:bg-violet-700/70 text-violet-200">⊟ Diviser</button>}
          {canDeleteBox && <button onClick={() => { if (selDi !== null && selBi !== null) deleteBox(selDi, selBi); }}
            className="px-2 py-0.5 text-xs rounded bg-red-800/40 hover:bg-red-700/60 text-red-300">🗑 Suppr. boîte</button>}
        </>)}
        {/* Separator selected */}
        {selectedSep && (() => {
          const shelf = gondola.shelves.find(s => s.id === selectedSep.shelfId);
          const sep = shelf?.separators.find(s => s.id === selectedSep.sepId);
          if (!sep?.movable) return null;
          return (<>
            <div className="h-4 w-px bg-gray-700" />
            <span className="text-xs text-orange-300">Séparateur</span>
            <button onClick={() => { pushHistory(); applyGondola(cmdRemoveSeparator(gondola, shelf!.id, sep.id)); setSelectedSep(null); }}
              className="px-2 py-0.5 text-xs rounded bg-orange-800/50 hover:bg-orange-700/70 text-orange-200">🗑 Supprimer</button>
          </>);
        })()}
        <button onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-700 text-gray-400 hover:text-white text-base ml-auto">×</button>
      </div>

      {/* Overflow warning */}
      {isOverflowing && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-red-900/30 border-b border-red-700/50 text-xs text-red-300 shrink-0">
          🔴 Ce planogramme ({gondola.width_cm}×{gondola.height_cm} cm) dépasse la gondole ({furniture?.dimensions.width ?? '?'}×{furniture?.dimensions.height ?? '?'} cm).
        </div>
      )}

      {/* ── Grid ── */}
      <div className="flex-1 overflow-auto p-4">
        <div className="flex gap-1">

          {/* Row-number sidebar */}
          <div className="flex flex-col gap-0 shrink-0" style={{ width: 24 }}>
            {Array.from({ length: shelfCount }, (_, di) => {
              const shelf = getShelfByDisplayIndex(gondola, di)!;
              const hp    = shelfHeightPx(shelf);
              const fill  = rowFillCm[di] / gondola.width_cm;
              const fillClr = fill > 1 ? '#ef4444' : fill > 0.95 ? '#f59e0b' : '#22c55e';
              return (
                <Fragment key={di}>
                  <div
                    className={['flex flex-col items-center justify-center cursor-pointer select-none rounded-l text-xs relative overflow-hidden',
                      selectedHeaderRow === di ? 'bg-blue-900/40 text-blue-400' : 'text-gray-600 hover:bg-gray-800/60 hover:text-gray-300'].join(' ')}
                    style={{ height: hp, width: 24, flexShrink: 0 }}
                    onClick={() => {
                      setSelectedKey(null);
                      setSelectedHeaderCol(null);
                      setSelectedSep(null);
                      setSelectedHeaderRow(p => p === di ? null : di);
                    }}
                    title={`Ligne ${di + 1} — ${rowFillCm[di].toFixed(1)} / ${gondola.width_cm.toFixed(1)} cm`}
                  >
                    {di + 1}
                    <div style={{ position: 'absolute', bottom: 0, left: 0, height: 3, width: `${Math.min(fill, 1) * 100}%`, background: fillClr, borderRadius: '0 0 0 3px', transition: 'width .2s' }} />
                  </div>
                  {di < shelfCount - 1 && (
                    <div style={{ height: SHELF_RESIZE_H, width: 24, flexShrink: 0, cursor: 'row-resize' }}
                      className="bg-gray-800 hover:bg-blue-500/50 transition-colors"
                      onMouseDown={e => startShelfDrag(e, di)} />
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Shelf rows */}
          <div className="flex flex-col gap-0">
            {Array.from({ length: shelfCount }, (_, di) => {
              const shelf    = getShelfByDisplayIndex(gondola, di)!;
              const rowBoxes = getRowBoxes(boxes, di);
              const hp       = shelfHeightPx(shelf);
              const internalSeps = sortedSeps(shelf).slice(1, -1); // exclude boundary seps

              return (
                <Fragment key={shelf.id}>
                  {/* ── Shelf container (position:relative) ── */}
                  <div
                    style={{ position: 'relative', width: gondolaWidthPx, height: hp, flexShrink: 0 }}
                    className="border border-gray-700/50"
                  >
                    {/* ── Boxes (absolutely positioned) ── */}
                    {rowBoxes.map(box => {
                      const bi    = box.boxIndex;
                      const key   = makeBoxKey(di, bi);
                      const rect  = boxRect(box, shelf);
                      const prod  = box.placement ? productByEan.get(box.placement.productId) : undefined;
                      const cc    = prod ? catColor(prod.category) : undefined;
                      const isSel = selectedKey === key;
                      const isMul = selectedKeys.has(key);
                      const isDO  = dragOver === key;
                      const isIDO = internalDragOver === key;
                      const isHL  = selectedHeaderRow === di || selectedHeaderCol === bi;
                      const overflow = prod
                        ? prod.widthCm > box.width_cm + OVERFLOW_TOLERANCE_CM || prod.heightCm > box.height_cm + OVERFLOW_TOLERANCE_CM
                        : false;

                      return (
                        <div
                          key={bi}
                          data-box-key={key}
                          draggable={!!box.placement}
                          onClick={e => handleBoxClick(di, bi, e)}
                          onContextMenu={e => {
                            e.preventDefault();
                            setCtxMenu({ x: e.clientX, y: e.clientY, di, bi, box });
                          }}
                          onDragStart={e => {
                            if (!box.placement || !prod) return;
                            internalDragSrcRef.current = { displayRow: di, boxIndex: bi, ean: box.placement.productId };
                            e.dataTransfer.effectAllowed = 'move';
                            const ghost = document.createElement('div');
                            ghost.style.cssText = 'position:absolute;top:-9999px';
                            document.body.appendChild(ghost);
                            e.dataTransfer.setDragImage(ghost, 0, 0);
                            setTimeout(() => document.body.removeChild(ghost), 0);
                          }}
                          onDragEnd={() => { internalDragSrcRef.current = null; setInternalDragOver(null); }}
                          onDragOver={e => {
                            e.preventDefault();
                            if (internalDragSrcRef.current) { setInternalDragOver(key); setDragOver(null); }
                            else { setDragOver(key); setInternalDragOver(null); }
                          }}
                          onDragLeave={() => { setDragOver(null); setInternalDragOver(null); }}
                          onDrop={e => handleDrop(e, di, bi)}
                          className={[
                            'absolute top-0 overflow-hidden select-none group',
                            overflow           ? 'border border-red-500 bg-red-900/20'
                              : isIDO          ? 'border border-dashed border-blue-400 bg-blue-900/20'
                              : isDO           ? 'border border-green-400 bg-green-900/20'
                              : box.placement  ? 'border-transparent'
                              : 'border border-dashed border-gray-700 hover:border-gray-500',
                            isSel ? 'ring-2 ring-blue-500 ring-inset z-10' : '',
                            isMul && !isSel ? 'ring-2 ring-blue-400/70 ring-inset bg-blue-900/20 z-10' : '',
                            isHL && !isSel && !isMul ? 'ring-1 ring-blue-400/60 ring-inset bg-blue-900/15' : '',
                            box.placement ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                          ].join(' ')}
                          style={{
                            left:       rect.x,
                            width:      Math.max(2, rect.w),
                            height:     hp,
                            background: !overflow && box.placement && cc ? cc + '18' : undefined,
                          }}
                          title={overflow && prod
                            ? `⚠ ${prod.name} (${prod.widthCm}×${prod.heightCm} cm) > boîte (${box.width_cm.toFixed(1)}×${box.height_cm.toFixed(1)} cm)`
                            : box.placement ? `${prod?.name ?? box.placement.productId} — glisser pour déplacer` : undefined}
                        >
                          {box.placement && prod ? (
                            <>
                              <div className="absolute inset-x-0 top-0 h-1 rounded-t" style={{ background: overflow ? '#ef4444' : cc }} />
                              <div className="w-full px-1 pt-1.5 pb-0.5 flex flex-col items-center gap-0.5">
                                <div className="w-full" style={{ height: Math.max(24, hp - 32) }}>
                                  {uploadingEan === prod.ean
                                    ? <div className="w-full h-full flex items-center justify-center"><div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"/></div>
                                    : <ProductThumb product={prod} />}
                                </div>
                                <div className="text-xs font-medium truncate w-full text-center"
                                  style={{ color: overflow ? '#f87171' : cc, fontSize: 10 }}>
                                  {prod.name.length > 14 ? prod.name.slice(0, 12) + '…' : prod.name}
                                </div>
                                {zoom >= 1.2 && (
                                  <div className="text-center leading-none" style={{ fontSize: 9, color: overflow ? '#f87171' : '#6b7280' }}>
                                    {prod.widthCm}×{prod.heightCm} cm
                                  </div>
                                )}
                              </div>
                              {overflow && <div className="absolute bottom-0.5 left-0.5 text-red-400 leading-none" style={{ fontSize: 9 }}>⚠ débordement</div>}
                              <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                                <button className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-blue-400 bg-gray-900/70 rounded text-xs"
                                  title="Uploader une vignette"
                                  onClick={e => { e.stopPropagation(); pendingUploadEan.current = prod.ean; uploadInputRef.current?.click(); }}>📷</button>
                                <button className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 bg-gray-900/60 rounded text-xs"
                                  onClick={e => { e.stopPropagation(); clearBox(di, bi); }} title="Retirer">×</button>
                              </div>
                            </>
                          ) : box.placement ? (
                            <>
                              <div className="text-xs text-gray-400 font-mono text-center px-1">{box.placement.productId.slice(-6)}</div>
                              <button className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs z-20"
                                onClick={e => { e.stopPropagation(); clearBox(di, bi); }}>×</button>
                            </>
                          ) : (
                            <>
                              <span className="text-gray-600 text-sm font-bold select-none leading-none">+</span>
                              {zoom >= 1.5 && (
                                <span className="absolute bottom-0.5 left-0.5 text-gray-600 leading-none select-none" style={{ fontSize: 8 }}>
                                  {box.width_cm.toFixed(1)} cm
                                </span>
                              )}
                              {rowBoxes.length > 1 && (
                                <button className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 bg-gray-900/60 rounded text-xs leading-none opacity-0 group-hover:opacity-100 z-20"
                                  onClick={e => { e.stopPropagation(); deleteBox(di, bi); }}
                                  title="Supprimer cette boîte">×</button>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}

                    {/* ── Separator handles (absolutely positioned, over boxes) ── */}
                    {internalSeps.map(sep => {
                      const posX    = (preview.sepPositions?.get(sep.id) ?? sep.position_cm) * pxPerCmX;
                      const isSepSel = selectedSep?.sepId === sep.id && selectedSep?.shelfId === shelf.id;
                      return (
                        <div
                          key={sep.id}
                          style={{
                            position: 'absolute',
                            left:   posX - SEP_HANDLE_W / 2,
                            top:    0,
                            width:  SEP_HANDLE_W,
                            height: hp,
                            cursor: 'col-resize',
                            zIndex: 15,
                          }}
                          className={['transition-colors', isSepSel ? 'bg-orange-500/70' : 'bg-blue-500/20 hover:bg-blue-500/60'].join(' ')}
                          onMouseDown={e => startSepDrag(e, shelf, sep)}
                          onClick={e => {
                            e.stopPropagation();
                            if (!sep.movable) return;
                            setSelectedSep(prev =>
                              prev?.sepId === sep.id && prev.shelfId === shelf.id ? null : { shelfId: shelf.id, sepId: sep.id }
                            );
                            setSelectedKey(null); setSelectedKeys(new Set());
                            setSelectedHeaderRow(null); setSelectedHeaderCol(null);
                          }}
                          title="Glisser pour déplacer · Cliquer pour sélectionner"
                        />
                      );
                    })}
                  </div>

                  {/* ── Shelf resize handle ── */}
                  {di < shelfCount - 1 && (
                    <div
                      style={{ height: SHELF_RESIZE_H, width: gondolaWidthPx, flexShrink: 0, cursor: 'row-resize' }}
                      className="bg-gray-800 hover:bg-blue-500/50 transition-colors"
                      onMouseDown={e => startShelfDrag(e, di)}
                      title="Glisser pour redimensionner"
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Status bar ── */}
      <div className="border-t border-gray-800 px-4 py-1.5 flex items-center gap-3 shrink-0 text-xs text-gray-500">
        {selectedKeys.size > 1 ? (
          <>
            <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
            <span className="text-blue-300">{selectedKeys.size} boîtes sélectionnées</span>
            <span className="text-gray-600">· Suppr vider · {canFuse ? '⊞ Fusionner dispo' : 'lignes différentes = pas de fusion'}</span>
          </>
        ) : selectedEan ? (
          <>
            <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
            <span>Sélectionné : <span className="font-mono text-gray-300">{selectedEan}</span></span>
            <span className="text-gray-600">· Cliquer boîte vide pour placer · Glisser depuis catalogue</span>
          </>
        ) : (
          <span>Sélectionner un produit dans le catalogue · Ctrl+clic multi · Shift+clic plage · Glisser pour déplacer · ⊞ Fusionner · ⊟ Diviser</span>
        )}
        <div className="flex-1" />
        <span className="text-gray-600">Clic droit pour options · Suppr retirer · Ctrl+Z annuler · glisser séparateur pour redimensionner</span>
      </div>

      {/* ── Context menu ── */}
      {ctxMenu && (() => {
        const { x, y, di, bi, box } = ctxMenu;
        const rowBoxes = gondola ? getRowBoxes(boxes, di) : [];
        const hasLeft  = bi > 0;
        const hasRight = bi < rowBoxes.length - 1;
        const canCtxSplit = box.width_cm > 2 * MIN_BOX_CM;
        const canCtxFuseLeft  = hasLeft;
        const canCtxFuseRight = hasRight;
        return (
          <>
            {/* Backdrop to close on outside click */}
            <div
              className="fixed inset-0 z-40"
              onMouseDown={() => setCtxMenu(null)}
            />
            <div
              className="fixed z-50 bg-gray-800 border border-gray-600 rounded shadow-xl py-1 min-w-[180px] text-sm"
              style={{ left: x, top: y }}
              onMouseDown={e => e.stopPropagation()}
            >
              {canCtxFuseLeft && (
                <button
                  className="w-full text-left px-3 py-1.5 text-violet-300 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => fuseWithNeighbor(di, bi, 'left')}
                >
                  ⊞ <span>Fusionner avec la cellule gauche</span>
                </button>
              )}
              {canCtxFuseRight && (
                <button
                  className="w-full text-left px-3 py-1.5 text-violet-300 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => fuseWithNeighbor(di, bi, 'right')}
                >
                  ⊞ <span>Fusionner avec la cellule droite</span>
                </button>
              )}
              {(canCtxFuseLeft || canCtxFuseRight) && canCtxSplit && (
                <div className="border-t border-gray-700 my-1" />
              )}
              {canCtxSplit && (
                <button
                  className="w-full text-left px-3 py-1.5 text-violet-300 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => splitBox(di, bi)}
                >
                  ⊟ <span>Diviser en deux</span>
                </button>
              )}
              {box.placement && (
                <>
                  {(canCtxFuseLeft || canCtxFuseRight || canCtxSplit) && (
                    <div className="border-t border-gray-700 my-1" />
                  )}
                  <button
                    className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-gray-700 flex items-center gap-2"
                    onClick={() => { clearBox(di, bi); setCtxMenu(null); }}
                  >
                    ✕ <span>Retirer le produit</span>
                  </button>
                </>
              )}
              {!canCtxFuseLeft && !canCtxFuseRight && !canCtxSplit && !box.placement && (
                <div className="px-3 py-1.5 text-gray-500 text-xs">Aucune action disponible</div>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}

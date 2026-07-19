// ─── PlanogramEditor — refonte moteur séparateurs (§2-§7) ─────────────────────
//
// Source de vérité interne : Gondola (séparateurs).
// Les boxes sont calculées dynamiquement via computeBoxes().
// L'API REST et la vue 3D consomment la couche d'adaptation §6 (gondolaToLegacyPlanogram).
//
import { useState, useEffect, useRef, Fragment } from 'react';
import { usePlanogramStore } from '../../store/planogramStore';
import { useCatalogStore } from '../../store/catalogStore';
import { useSceneStore } from '../../store/sceneStore';
import { cadApi } from '../../api/cad';
import { OVERFLOW_TOLERANCE_CM } from '../../types/cad';
import type { CADProduct, Planogram } from '../../types/cad';
import type { Box, BoxKey, Gondola } from '../../types/gondola';
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
  cmdInsertSeparator,
  cmdRemoveSeparator,
  cmdAddShelf,
  cmdRemoveShelf,
  cmdResizeAdjacentShelves,
  cmdFuseBoxes,
  cmdSplitBox,
  cmdClearBoxesByKeys,
  findBox,
  getRowBoxes,
  snapToShelfBelow,
  DEFAULT_SHELF_HEIGHT_CM,
  DEFAULT_SEP_SPACING_CM,
  MIN_BOX_CM,
} from '../../engine/gondola';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  'Épicerie':  '#F5C518',
  'Boissons':  '#2196F3',
  'Frais':     '#4CAF50',
  'Hygiène':   '#9C27B0',
  'Bébé':      '#FF9800',
  'Promotion': '#F44336',
};

const CELL_MIN_PX     = 48;
const CELL_WIDTH_SCALE  = 1.2;
const CELL_HEIGHT_SCALE = 0.6;
const RESIZE_HANDLE_PX = 4;
const RESIZE_TOOLTIP_DX = 14;
const RESIZE_TOOLTIP_DY = -28;
const SNAP_THRESHOLD_PX = 12;
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 4;
const ZOOM_STEP = 0.25;

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? '#9E9E9E';
}

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

// ─── Props ─────────────────────────────────────────────────────────────────────
interface PlanogramEditorProps {
  projectId: string | null;
  planogramId: string;
  onClose: () => void;
}

// ─── Component ─────────────────────────────────────────────────────────────────
export default function PlanogramEditor({ projectId, planogramId, onClose }: PlanogramEditorProps) {
  // Core gondola state
  const [gondola,  setGondola]  = useState<Gondola | null>(null);
  const [boxes,    setBoxes]    = useState<Box[]>([]);
  const [boxMap,   setBoxMap]   = useState<Map<BoxKey, Box>>(new Map());
  // Planogram base (non-geometry fields for legacy adapter)
  const [planogramBase, setPlanogramBase] = useState<Omit<Planogram, 'rows'|'cols'|'widthCm'|'heightCm'|'cells'|'colWidthsCm'|'rowHeightsCm'|'rowColCounts'|'cellWidthOverrides'|'cellHeightOverrides'|'mergedSpans'> & { gondola?: Gondola } | null>(null);

  // Undo / redo
  const [history, setHistory] = useState<Gondola[]>([]);
  const [future,  setFuture]  = useState<Gondola[]>([]);

  // Selection
  const [selectedKey,     setSelectedKey]     = useState<BoxKey | null>(null);
  const [selectedKeys,    setSelectedKeys]    = useState<Set<BoxKey>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<BoxKey | null>(null);

  // Header row/col selection
  const [selectedHeaderRow, setSelectedHeaderRow] = useState<number | null>(null);
  const [selectedHeaderCol, setSelectedHeaderCol] = useState<number | null>(null);

  // Drag
  const internalDragSrcRef = useRef<{ displayRow: number; boxIndex: number; ean: string } | null>(null);
  const [dragOver,         setDragOver]         = useState<BoxKey | null>(null);
  const [internalDragOver, setInternalDragOver] = useState<BoxKey | null>(null);

  // Resize state
  const [isResizing,        setIsResizing]        = useState<'sep' | 'shelf' | null>(null);
  const [localSepPositions, setLocalSepPositions] = useState<Map<string, number> | null>(null);
  const [localShelfHeights, setLocalShelfHeights] = useState<Map<string, number> | null>(null);
  const [resizeTooltip,     setResizeTooltip]     = useState<{ x: number; y: number; text: string } | null>(null);
  const [activeSnapIdx,     setActiveSnapIdx]     = useState<number | null>(null);

  // UI
  const [zoom,           setZoom]           = useState(1.5);
  const [loading,        setLoading]        = useState(true);
  const [uploadingEan,   setUploadingEan]   = useState<string | null>(null);
  const [crushNavIdx,    setCrushNavIdx]    = useState(0);
  const [addRowDialog,   setAddRowDialog]   = useState<{ canAutoFix: boolean; topRowH: number; needed: number } | null>(null);
  const [clearAllConfirm, setClearAllConfirm] = useState(false);

  const saveTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadInputRef  = useRef<HTMLInputElement>(null);
  const pendingUploadEan = useRef<string | null>(null);

  const { setActivePlanogram } = usePlanogramStore();
  const { products, selectedEan, addRecentlyUsed, setProducts } = useCatalogStore();
  const { scene } = useSceneStore();

  const productByEan = new Map(products.map((p) => [p.ean, p] as const));

  // ── Derived gondola metrics ─────────────────────────────────────────────────
  const shelfCount = gondola?.shelves.length ?? 0;
  const maxBoxCount = gondola
    ? Math.max(...gondola.shelves.map((s) => shelfBoxCount(s)), 1)
    : 0;

  // ── Overflow detection (against 3D furniture bounds) ───────────────────────
  const furniture = gondola
    ? scene?.furniture.find(f => planogramBase && f.id === planogramBase.furnitureId)
    : null;

  const isOverflowing = gondola && furniture
    ? gondola.width_cm > furniture.dimensions.width  + OVERFLOW_TOLERANCE_CM ||
      gondola.height_cm > furniture.dimensions.height + OVERFLOW_TOLERANCE_CM
    : false;

  const gondolaRemainingW: number = (gondola && furniture)
    ? furniture.dimensions.width  + OVERFLOW_TOLERANCE_CM - gondola.width_cm
    : Infinity;
  const gondolaRemainingH: number = (gondola && furniture)
    ? furniture.dimensions.height + OVERFLOW_TOLERANCE_CM - gondola.height_cm
    : Infinity;

  const defaultRowH = gondola ? Math.max(MIN_BOX_CM, Math.min(DEFAULT_SHELF_HEIGHT_CM, gondolaRemainingH)) : 0;
  const canAddRow = gondola ? gondolaRemainingH >= MIN_BOX_CM : false;
  const canAddCol = gondola ? gondolaRemainingW >= MIN_BOX_CM : false;

  // ── Load planogram on mount ──────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setSelectedKey(null);
    setSelectedKeys(new Set());
    cadApi.getPlanogram(projectId, planogramId)
      .then((p) => {
        // Use embedded gondola if present, else migrate from legacy cells
        const g: Gondola = p.gondola ?? legacyCellsToSeparators(p);
        const bs = computeBoxes(g);
        setGondola(g);
        setBoxes(bs);
        setBoxMap(buildBoxMap(bs));
        // Store the non-geometry planogram fields
        const { rows: _r, cols: _c, widthCm: _w, heightCm: _h, cells: _cells,
                colWidthsCm: _cw, rowHeightsCm: _rh, rowColCounts: _rc,
                cellWidthOverrides: _wo, cellHeightOverrides: _ho, mergedSpans: _ms,
                gondola: _go, ...base } = p;
        setPlanogramBase({ ...base, gondola: g });
        setActivePlanogram(gondolaToLegacyPlanogram(g, { ...base, gondola: g }));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId, planogramId, setActivePlanogram]);

  // ── Auto-save ────────────────────────────────────────────────────────────────
  const scheduleSave = (legacyPlanogram: Planogram) => {
    if (!projectId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      cadApi.updatePlanogram(projectId, legacyPlanogram.id, legacyPlanogram).catch(console.error);
    }, 500);
  };

  // ── Core: apply a new gondola state ─────────────────────────────────────────
  const applyGondola = (g: Gondola) => {
    const bs = computeBoxes(g);
    const bm = buildBoxMap(bs);
    setGondola(g);
    setBoxes(bs);
    setBoxMap(bm);
    setFuture([]);
    if (planogramBase) {
      const legacyPlanogram = gondolaToLegacyPlanogram(g, { ...planogramBase, gondola: g });
      setActivePlanogram(legacyPlanogram);
      scheduleSave(legacyPlanogram);
    }
  };

  const pushHistory = () => {
    if (gondola) setHistory(prev => [...prev.slice(-20), gondola]);
  };

  // ── Product placement operations ──────────────────────────────────────────────
  const fillBox = (displayRow: number, boxIndex: number, ean: string) => {
    if (!gondola) return;
    const box = findBox(boxes, displayRow, boxIndex);
    if (!box) return;
    pushHistory();
    applyGondola(cmdSetPlacement(gondola, box.shelfId, box.leftSeparatorId, box.rightSeparatorId, ean));
    addRecentlyUsed(ean);
  };

  const clearBox = (displayRow: number, boxIndex: number) => {
    if (!gondola) return;
    const box = findBox(boxes, displayRow, boxIndex);
    if (!box) return;
    pushHistory();
    applyGondola(cmdClearPlacement(gondola, box.shelfId, box.leftSeparatorId, box.rightSeparatorId));
    setSelectedKey(null);
    setSelectedKeys(new Set());
  };

  const moveBox = (srcRow: number, srcCol: number, dstRow: number, dstCol: number) => {
    if (!gondola) return;
    if (srcRow === dstRow && srcCol === dstCol) return;
    const srcBox = findBox(boxes, srcRow, srcCol);
    if (!srcBox?.placement) return;
    const dstBox = findBox(boxes, dstRow, dstCol);
    pushHistory();
    const ean      = srcBox.placement.productId;
    const rotation = srcBox.placement.rotation;
    let g = cmdClearPlacement(gondola, srcBox.shelfId, srcBox.leftSeparatorId, srcBox.rightSeparatorId);
    // Swap: if dst has a product, move it to src position
    if (dstBox?.placement) {
      g = cmdSetPlacement(g, srcBox.shelfId, srcBox.leftSeparatorId, srcBox.rightSeparatorId,
        dstBox.placement.productId, dstBox.placement.rotation ?? 0);
    }
    g = cmdSetPlacement(g, dstBox!.shelfId, dstBox!.leftSeparatorId, dstBox!.rightSeparatorId,
      ean, rotation ?? 0);
    applyGondola(g);
  };

  const clearSelectedBoxes = () => {
    if (!gondola || selectedKeys.size === 0) return;
    pushHistory();
    applyGondola(cmdClearBoxesByKeys(gondola, boxes, selectedKeys));
    setSelectedKey(null);
    setSelectedKeys(new Set());
  };

  const clearAll = () => {
    if (!gondola) return;
    pushHistory();
    applyGondola(cmdClearAllPlacements(gondola));
    setSelectedKey(null);
    setSelectedKeys(new Set());
    setClearAllConfirm(false);
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

  // ── Shelf management ──────────────────────────────────────────────────────────
  const _doAddRow = (shrinkTopRowBy = 0) => {
    if (!gondola) return;
    pushHistory();
    // If a row header is selected, insert above that row
    const insertAboveShelfId = selectedHeaderRow !== null
      ? getShelfByDisplayIndex(gondola, selectedHeaderRow)?.id
      : undefined;
    const topShelf = gondola.shelves[gondola.shelves.length - 1];
    if (shrinkTopRowBy > 0 && topShelf.height_cm - shrinkTopRowBy < MIN_BOX_CM) return;
    applyGondola(cmdAddShelf(gondola, defaultRowH, insertAboveShelfId));
    setSelectedHeaderRow(selectedHeaderRow !== null ? selectedHeaderRow : 0);
  };

  const addRow = () => {
    if (!gondola || !canAddRow) return;
    const topShelf = gondola.shelves[gondola.shelves.length - 1];
    const topRowH = topShelf.height_cm;
    const MIN_TOP_AFTER = 1;
    if (topRowH <= defaultRowH + MIN_TOP_AFTER) {
      const canAutoFix = topRowH - defaultRowH >= MIN_TOP_AFTER;
      setAddRowDialog({ canAutoFix, topRowH, needed: defaultRowH });
      return;
    }
    _doAddRow();
  };

  const removeRow = () => {
    if (!gondola || shelfCount <= 1) return;
    const di = selectedHeaderRow ?? 0; // default to top row
    const shelf = getShelfByDisplayIndex(gondola, di);
    if (!shelf) return;
    pushHistory();
    applyGondola(cmdRemoveShelf(gondola, shelf.id));
    if (selectedHeaderRow !== null) {
      setSelectedHeaderRow(Math.min(selectedHeaderRow, shelfCount - 2));
    }
  };

  // ── Separator (column) management ─────────────────────────────────────────────
  const addSeparatorToShelf = (displayRow: number) => {
    if (!gondola) return;
    const shelf = getShelfByDisplayIndex(gondola, displayRow);
    if (!shelf) return;
    const seps = sortedSeps(shelf);
    const lastInternal = seps[seps.length - 2]; // second-to-last
    const rightBound   = seps[seps.length - 1].position_cm;
    const newPos = lastInternal
      ? Math.max(lastInternal.position_cm + MIN_BOX_CM, rightBound - DEFAULT_SEP_SPACING_CM)
      : rightBound / 2;
    if (newPos <= MIN_BOX_CM || newPos >= rightBound - MIN_BOX_CM) return;
    pushHistory();
    applyGondola(cmdInsertSeparator(gondola, shelf.id, newPos));
  };

  const addCol = () => {
    if (!gondola || !canAddCol) return;
    if (selectedHeaderRow !== null) {
      addSeparatorToShelf(selectedHeaderRow);
      return;
    }
    // Add to all shelves
    pushHistory();
    let g = gondola;
    for (let di = 0; di < shelfCount; di++) {
      const shelf = getShelfByDisplayIndex(g, di);
      if (!shelf) continue;
      const seps = sortedSeps(shelf);
      const rightBound = seps[seps.length - 1].position_cm;
      const lastInternal = seps[seps.length - 2];
      const newPos = lastInternal
        ? Math.max(lastInternal.position_cm + MIN_BOX_CM, rightBound - DEFAULT_SEP_SPACING_CM)
        : rightBound / 2;
      if (newPos > MIN_BOX_CM && newPos < rightBound - MIN_BOX_CM) {
        g = cmdInsertSeparator(g, shelf.id, newPos);
      }
    }
    applyGondola(g);
  };

  const removeSeparatorFromShelf = (displayRow: number) => {
    if (!gondola) return;
    const shelf = getShelfByDisplayIndex(gondola, displayRow);
    if (!shelf) return;
    const seps = sortedSeps(shelf);
    if (seps.length <= 2) return; // only boundaries remain — nothing to remove
    const lastInternal = seps[seps.length - 2]; // rightmost internal sep
    pushHistory();
    applyGondola(cmdRemoveSeparator(gondola, shelf.id, lastInternal.id));
  };

  const removeCol = () => {
    if (!gondola) return;
    if (selectedHeaderRow !== null) {
      removeSeparatorFromShelf(selectedHeaderRow);
      return;
    }
    // Remove last internal separator from all shelves
    pushHistory();
    let g = gondola;
    for (let di = 0; di < shelfCount; di++) {
      const shelf = getShelfByDisplayIndex(g, di);
      if (!shelf) continue;
      const seps = sortedSeps(shelf);
      if (seps.length <= 2) continue;
      const lastInternal = seps[seps.length - 2];
      g = cmdRemoveSeparator(g, shelf.id, lastInternal.id);
    }
    applyGondola(g);
  };

  // ── Fuse / split ─────────────────────────────────────────────────────────────
  const fuseSelectedBoxes = () => {
    if (!gondola || selectedKeys.size < 2) return;
    const parsed = [...selectedKeys].map(k => parseBoxKey(k)).filter((p): p is [number,number] => p !== null);
    const rowSet = new Set(parsed.map(([r]) => r));
    if (rowSet.size !== 1) return;
    const di = parsed[0][0];
    const shelf = getShelfByDisplayIndex(gondola, di);
    if (!shelf) return;
    const sortedCols = parsed.map(([,c]) => c).sort((a,b) => a-b);
    for (let i = 1; i < sortedCols.length; i++) {
      if (sortedCols[i] !== sortedCols[i-1] + 1) return;
    }
    const rowBoxes = getRowBoxes(boxes, di);
    const leftBox  = rowBoxes[sortedCols[0]];
    const rightBox = rowBoxes[sortedCols[sortedCols.length - 1]];
    if (!leftBox || !rightBox) return;
    pushHistory();
    applyGondola(cmdFuseBoxes(gondola, shelf.id, leftBox.leftSeparatorId, rightBox.rightSeparatorId));
    setSelectedKey(null);
    setSelectedKeys(new Set());
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
    const splitPos = box.x_cm + box.width_cm / 2;
    pushHistory();
    applyGondola(cmdSplitBox(gondola, shelf.id, box.leftSeparatorId, box.rightSeparatorId, splitPos));
    setSelectedKey(null);
    setSelectedKeys(new Set());
  };

  // Delete a box (empty box only): remove the separator to its right, giving width to right neighbour;
  // or if it's the last box, remove the separator to its left.
  const deleteBox = (displayRow: number, boxIndex: number) => {
    if (!gondola) return;
    const box = findBox(boxes, displayRow, boxIndex);
    if (!box || box.placement) return; // only delete empty boxes
    const shelf = getShelfByDisplayIndex(gondola, displayRow);
    if (!shelf) return;
    const rowBoxes = getRowBoxes(boxes, displayRow);
    if (rowBoxes.length <= 1) return; // must keep at least one box
    const seps = sortedSeps(shelf);
    const isLast = boxIndex === rowBoxes.length - 1;
    // Remove the right separator for all but the last box; remove the left separator for the last
    const sepToRemove = isLast
      ? seps.find(s => s.id === box.leftSeparatorId)
      : seps.find(s => s.id === box.rightSeparatorId);
    if (!sepToRemove || !sepToRemove.movable) return;
    pushHistory();
    applyGondola(cmdRemoveSeparator(gondola, shelf.id, sepToRemove.id));
    if (selectedKey === makeBoxKey(displayRow, boxIndex)) {
      setSelectedKey(null);
      setSelectedKeys(new Set());
    }
  };

  // ── Undo / Redo ───────────────────────────────────────────────────────────────
  const undo = () => {
    setHistory(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (gondola) setFuture(f => [...f.slice(-20), gondola]);
      const bs = computeBoxes(last);
      setGondola(last);
      setBoxes(bs);
      setBoxMap(buildBoxMap(bs));
      if (planogramBase) {
        const lp = gondolaToLegacyPlanogram(last, { ...planogramBase, gondola: last });
        setActivePlanogram(lp);
        scheduleSave(lp);
      }
      return prev.slice(0, -1);
    });
  };

  const redo = () => {
    setFuture(prev => {
      if (prev.length === 0) return prev;
      const next = prev[prev.length - 1];
      if (gondola) setHistory(h => [...h.slice(-20), gondola]);
      const bs = computeBoxes(next);
      setGondola(next);
      setBoxes(bs);
      setBoxMap(buildBoxMap(bs));
      if (planogramBase) {
        const lp = gondolaToLegacyPlanogram(next, { ...planogramBase, gondola: next });
        setActivePlanogram(lp);
        scheduleSave(lp);
      }
      return prev.slice(0, -1);
    });
  };

  // ── Image upload ─────────────────────────────────────────────────────────────
  const handleImageUpload = async (ean: string, file: File) => {
    if (!projectId) return;
    setUploadingEan(ean);
    try {
      const result = await cadApi.uploadProductImage(projectId, ean, file);
      const updatedProducts = products.map(p => p.ean === ean ? { ...p, imageUrl: result.imageUrl } : p);
      setProducts(updatedProducts);
    } catch (err) {
      console.error('Image upload failed:', err);
    } finally {
      setUploadingEan(null);
    }
  };

  // ── Separator (column) resize ──────────────────────────────────────────────────
  // Drag the separator between box col and col+1 in a specific display row.
  const startSepResize = (e: React.MouseEvent, displayRow: number, sepBetweenCol: number) => {
    if (!gondola) return;
    const shelf = getShelfByDisplayIndex(gondola, displayRow);
    if (!shelf) return;
    const rowBoxes = getRowBoxes(boxes, displayRow);
    const leftBox  = rowBoxes[sepBetweenCol];
    const rightBox = rowBoxes[sepBetweenCol + 1];
    if (!leftBox || !rightBox) return;

    e.preventDefault();
    const startX = e.clientX;
    const capturedGondola = gondola;
    const seps = sortedSeps(shelf);
    const sepIdx = seps.findIndex(s => s.id === leftBox.rightSeparatorId);
    const sep    = seps[sepIdx];
    if (!sep?.movable) return;

    const origPos = sep.position_cm;
    let finalPos  = origPos;
    setIsResizing('sep');

    // Snap boundaries from shelf below
    const thresholdCm = SNAP_THRESHOLD_PX / (CELL_WIDTH_SCALE * zoom);

    const onMove = (ev: MouseEvent) => {
      const rawDelta = (ev.clientX - startX) / (CELL_WIDTH_SCALE * zoom);
      const rawNewPos = origPos + rawDelta;
      // Snap to shelf below
      const { snapped, idx } = snapToShelfBelow(capturedGondola, displayRow, rawNewPos, thresholdCm);
      finalPos = snapped;
      setActiveSnapIdx(idx >= 0 ? idx : null);
      setLocalSepPositions(new Map([[sep.id, finalPos]]));
      setResizeTooltip({
        x: ev.clientX + RESIZE_TOOLTIP_DX,
        y: ev.clientY + RESIZE_TOOLTIP_DY,
        text: `${leftBox.x_cm.toFixed(1)}…${finalPos.toFixed(1)} / ${finalPos.toFixed(1)}…${rightBox.x_cm + rightBox.width_cm} cm`,
      });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalSepPositions(null);
      setResizeTooltip(null);
      setActiveSnapIdx(null);
      applyGondola(cmdMoveSeparator(capturedGondola, shelf.id, sep.id, finalPos));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Shelf height resize ────────────────────────────────────────────────────────
  // Drag the border between shelf at displayRow and displayRow+1.
  const startShelfResize = (e: React.MouseEvent, displayRow: number) => {
    if (!gondola || displayRow + 1 >= shelfCount) return;
    const shelfAbove = getShelfByDisplayIndex(gondola, displayRow);     // top one
    const shelfBelow = getShelfByDisplayIndex(gondola, displayRow + 1); // bottom one
    if (!shelfAbove || !shelfBelow) return;

    e.preventDefault();
    const startY = e.clientY;
    const h0 = shelfAbove.height_cm;
    const h1 = shelfBelow.height_cm;
    const capturedGondola = gondola;
    let finalH0 = h0;
    let finalH1 = h1;
    setIsResizing('shelf');

    const onMove = (ev: MouseEvent) => {
      const deltaCm = (ev.clientY - startY) / (CELL_HEIGHT_SCALE * zoom);
      const clamped = Math.max(-(h0 - MIN_BOX_CM), Math.min(h1 - MIN_BOX_CM, deltaCm));
      finalH0 = h0 + clamped;
      finalH1 = h1 - clamped;
      setLocalShelfHeights(new Map([[shelfAbove.id, finalH0], [shelfBelow.id, finalH1]]));
      setResizeTooltip({
        x: ev.clientX + RESIZE_TOOLTIP_DX,
        y: ev.clientY + RESIZE_TOOLTIP_DY,
        text: `${finalH0.toFixed(1)} / ${finalH1.toFixed(1)} cm`,
      });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsResizing(null);
      setLocalShelfHeights(null);
      setResizeTooltip(null);
      applyGondola(cmdResizeAdjacentShelves(capturedGondola, shelfAbove.id, finalH0, shelfBelow.id, finalH1));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  const keyHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (
      ((e.ctrlKey || e.metaKey) && e.key === 'y') ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z'))
    ) { e.preventDefault(); redo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedKeys.size > 1) { clearSelectedBoxes(); }
      else if (selectedKey) {
        const parsed = parseBoxKey(selectedKey);
        if (parsed) clearBox(parsed[0], parsed[1]);
      }
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandlerRef.current?.(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Prevent text selection during resize ────────────────────────────────────
  useEffect(() => {
    document.body.style.userSelect = isResizing ? 'none' : '';
    return () => { document.body.style.userSelect = ''; };
  }, [isResizing]);

  // ── Cell click ───────────────────────────────────────────────────────────────
  const handleBoxClick = (di: number, bi: number, e: React.MouseEvent) => {
    setSelectedHeaderCol(null);
    setSelectedHeaderRow(null);
    const key = makeBoxKey(di, bi);

    if (e.ctrlKey || e.metaKey) {
      setSelectedKeys(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
      setSelectedKey(key);
      setLastSelectedKey(key);
      return;
    }

    if (e.shiftKey && lastSelectedKey && gondola) {
      const [r0, c0] = parseBoxKey(lastSelectedKey) ?? [di, bi];
      const rowMin = Math.min(r0, di); const rowMax = Math.max(r0, di);
      const colMin = Math.min(c0, bi); const colMax = Math.max(c0, bi);
      const rangeKeys = new Set<string>();
      for (let r = rowMin; r <= rowMax; r++) {
        for (let c = colMin; c <= colMax; c++) rangeKeys.add(makeBoxKey(r, c));
      }
      setSelectedKeys(rangeKeys);
      setSelectedKey(key);
      return;
    }

    setSelectedKeys(new Set());
    setLastSelectedKey(key);
    const box = boxMap.get(key);
    if (!box?.placement && selectedEan) {
      fillBox(di, bi, selectedEan);
      return;
    }
    setSelectedKey(key === selectedKey ? null : key);
  };

  const handleColHeaderClick = (c: number) => {
    setSelectedKey(null);
    setSelectedHeaderRow(null);
    setSelectedHeaderCol(prev => prev === c ? null : c);
  };
  const handleRowHeaderClick = (r: number) => {
    setSelectedKey(null);
    setSelectedHeaderCol(null);
    setSelectedHeaderRow(prev => prev === r ? null : r);
  };

  const handleDrop = (e: React.DragEvent, di: number, bi: number) => {
    e.preventDefault();
    setDragOver(null);
    setInternalDragOver(null);
    const src = internalDragSrcRef.current;
    if (src) {
      internalDragSrcRef.current = null;
      moveBox(src.displayRow, src.boxIndex, di, bi);
      return;
    }
    const ean = e.dataTransfer.getData('text/plain').trim();
    if (ean) fillBox(di, bi, ean);
  };

  // ── Computed rendering values ─────────────────────────────────────────────────
  if (loading || !gondola) {
    return loading
      ? (<div className="flex items-center justify-center w-full h-full bg-gray-900"><div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>)
      : (<div className="flex items-center justify-center w-full h-full bg-gray-900"><p className="text-gray-500 text-sm">Chargement échoué</p></div>);
  }

  // Per-box pixel sizes (with live preview during drag)
  const getBoxWidthPx = (di: number, bi: number): number => {
    const box = findBox(boxes, di, bi);
    if (!box) return CELL_MIN_PX;
    let wCm = box.width_cm;
    if (localSepPositions) {
      const shelf = getShelfByDisplayIndex(gondola, di);
      if (shelf) {
        const seps = sortedSeps(shelf);
        const leftSepIdx  = seps.findIndex(s => s.id === box.leftSeparatorId);
        const rightSepIdx = seps.findIndex(s => s.id === box.rightSeparatorId);
        const leftPos  = localSepPositions.get(seps[leftSepIdx]?.id  ?? '') ?? seps[leftSepIdx]?.position_cm  ?? box.x_cm;
        const rightPos = localSepPositions.get(seps[rightSepIdx]?.id ?? '') ?? seps[rightSepIdx]?.position_cm ?? (box.x_cm + box.width_cm);
        wCm = rightPos - leftPos;
      }
    }
    return Math.max(CELL_MIN_PX, Math.round(wCm * CELL_WIDTH_SCALE * zoom));
  };

  const getBoxHeightPx = (di: number): number => {
    const shelf = getShelfByDisplayIndex(gondola, di);
    if (!shelf) return CELL_MIN_PX;
    const h = localShelfHeights?.get(shelf.id) ?? shelf.height_cm;
    return Math.max(CELL_MIN_PX, Math.round(h * CELL_HEIGHT_SCALE * zoom));
  };

  const getBoxWidthCm = (di: number, bi: number): number => {
    const box = findBox(boxes, di, bi);
    return box?.width_cm ?? 0;
  };

  const getBoxHeightCm = (di: number): number => {
    const shelf = getShelfByDisplayIndex(gondola, di);
    return shelf?.height_cm ?? 0;
  };

  // Grey extension areas
  const extraGondolaWidthCm  = furniture ? Math.max(0, gondolaRemainingW)  : 0;
  const extraGondolaHeightCm = furniture ? Math.max(0, gondolaRemainingH) : 0;
  const greyExtWidthPx  = Math.round(extraGondolaWidthCm  * CELL_WIDTH_SCALE  * zoom);
  const greyExtHeightPx = Math.round(extraGondolaHeightCm * CELL_HEIGHT_SCALE * zoom);

  // Crush detection
  const crushedBoxes: { key: BoxKey; di: number; bi: number; prod: CADProduct }[] = [];
  for (const box of boxes) {
    if (!box.placement) continue;
    const prod = productByEan.get(box.placement.productId);
    if (!prod) continue;
    if (prod.widthCm > box.width_cm + OVERFLOW_TOLERANCE_CM || prod.heightCm > box.height_cm + OVERFLOW_TOLERANCE_CM) {
      crushedBoxes.push({ key: makeBoxKey(box.shelfDisplayIndex, box.boxIndex), di: box.shelfDisplayIndex, bi: box.boxIndex, prod });
    }
  }

  // Fuse eligibility: multiple boxes, same row, contiguous, no product
  const canFuse = (() => {
    if (selectedKeys.size < 2) return false;
    const parsed = [...selectedKeys].map(k => parseBoxKey(k)).filter((p): p is [number,number] => p !== null);
    const rowSet = new Set(parsed.map(([r]) => r));
    if (rowSet.size !== 1) return false;
    const sortedCols = parsed.map(([,c]) => c).sort((a,b) => a-b);
    for (let i = 1; i < sortedCols.length; i++) {
      if (sortedCols[i] !== sortedCols[i-1] + 1) return false;
    }
    return true;
  })();

  // Split eligibility: single box, no product, width > 2 * MIN_BOX_CM
  const canSplit = (() => {
    if (!selectedKey || selectedKeys.size > 1) return false;
    const parsed = parseBoxKey(selectedKey);
    if (!parsed) return false;
    const box = findBox(boxes, parsed[0], parsed[1]);
    return box !== undefined && !box.placement && box.width_cm > 2 * MIN_BOX_CM;
  })();

  // Delete-box eligibility: single empty box, row has > 1 box
  const canDeleteBox = (() => {
    if (!selectedKey || selectedKeys.size > 1) return false;
    const parsed = parseBoxKey(selectedKey);
    if (!parsed) return false;
    const [di, bi] = parsed;
    const box = findBox(boxes, di, bi);
    if (!box || box.placement) return false;
    return getRowBoxes(boxes, di).length > 1;
  })();

  // Row fill cm
  const rowFillCm = Array.from({ length: shelfCount }, (_, di) => {
    return getRowBoxes(boxes, di).reduce((acc, b) => acc + b.width_cm, 0);
  });

  const scrollToCrushed = (idx: number) => {
    if (crushedBoxes.length === 0) return;
    const target = crushedBoxes[idx % crushedBoxes.length];
    setSelectedKey(target.key);
    setSelectedKeys(new Set());
    setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-box-key="${target.key}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, 0);
  };

  const handleCrushBadgeClick = () => {
    if (crushedBoxes.length === 0) return;
    const nextIdx = crushNavIdx % crushedBoxes.length;
    scrollToCrushed(nextIdx);
    setCrushNavIdx(nextIdx + 1);
  };

  const [selDisplayRow, selBoxIdx] = selectedKey ? (parseBoxKey(selectedKey) ?? [null, null]) : [null, null];

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-200 truncate">
            {planogramBase?.name ?? planogramId}
          </h2>
          <p className="text-xs text-gray-500">
            {shelfCount} ligne{shelfCount !== 1 ? 's' : ''}
            &nbsp;·&nbsp;{gondola.width_cm.toFixed(1)} × {gondola.height_cm.toFixed(1)} cm
            &nbsp;·&nbsp;{gondola.productPlacements.length} produit{gondola.productPlacements.length !== 1 ? 's' : ''}
            &nbsp;·&nbsp;<span className="text-gray-600">moteur séparateurs</span>
          </p>
        </div>

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
          {/* Row management */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-600 mr-0.5">Lignes</span>
            <button onClick={removeRow} disabled={shelfCount <= 1}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm transition-colors"
              title={selectedHeaderRow !== null ? `Supprimer la ligne ${selectedHeaderRow + 1}` : 'Supprimer la ligne supérieure'}
            >−</button>
            <span className="text-xs text-gray-400 w-5 text-center">{shelfCount}</span>
            <button onClick={addRow} disabled={!canAddRow}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm transition-colors"
              title={canAddRow ? 'Ajouter une ligne' : `Limite atteinte (${furniture?.dimensions.height ?? '?'} cm)`}
            >+</button>
          </div>
          <div className="h-4 w-px bg-gray-700" />
          {/* Col management */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-600 mr-0.5">Colonnes</span>
            <button onClick={removeCol} disabled={maxBoxCount <= 1}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm transition-colors"
              title={selectedHeaderRow !== null ? `Retirer la dernière cellule de la ligne ${selectedHeaderRow + 1}` : 'Retirer la dernière colonne (toutes les lignes)'}
            >−</button>
            <span className="text-xs text-gray-400 w-5 text-center">{maxBoxCount}</span>
            <button onClick={addCol} disabled={!canAddCol}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 text-sm transition-colors"
              title={!canAddCol ? `Limite atteinte (${furniture?.dimensions.width ?? '?'} cm)` : selectedHeaderRow !== null ? `Ajouter une cellule à la ligne ${selectedHeaderRow + 1}` : 'Ajouter une colonne (toutes les lignes)'}
            >+</button>
          </div>
          <div className="h-4 w-px bg-gray-700" />
          {/* Zoom */}
          <div className="flex items-center gap-1">
            <button onClick={() => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-sm transition-colors" title="Zoom arrière">−</button>
            <span className="text-xs text-gray-500 w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-sm transition-colors" title="Zoom avant">+</button>
          </div>
          <div className="h-4 w-px bg-gray-700" />
          {/* Undo/Redo */}
          <button onClick={undo} disabled={history.length === 0}
            className="px-2 py-1 text-xs rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 transition-colors" title="Annuler (Ctrl+Z)">↩ Annuler</button>
          <button onClick={redo} disabled={future.length === 0}
            className="px-2 py-1 text-xs rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30 transition-colors" title="Rétablir (Ctrl+Y)">↪ Rétablir</button>
          {/* Crush badge */}
          {crushedBoxes.length > 0 && (
            <button onClick={handleCrushBadgeClick}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-800/60 hover:bg-red-700/80 text-red-300 text-xs transition-colors"
              title={`${crushedBoxes.length} conflit(s) — cliquer pour naviguer`}
            >⚠ {crushedBoxes.length} conflit{crushedBoxes.length > 1 ? 's' : ''}</button>
          )}
          <div className="h-4 w-px bg-gray-700" />
          {/* Clear all */}
          {!clearAllConfirm ? (
            <button onClick={() => setClearAllConfirm(true)} disabled={gondola.productPlacements.length === 0}
              className="px-2 py-0.5 text-xs rounded hover:bg-red-900/50 text-gray-400 hover:text-red-300 disabled:opacity-30 transition-colors" title="Vider tous les produits">🗑 Tout vider</button>
          ) : (
            <span className="flex items-center gap-1">
              <span className="text-xs text-red-300">Confirmer ?</span>
              <button onClick={clearAll} className="px-2 py-0.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors">Oui</button>
              <button onClick={() => setClearAllConfirm(false)} className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors">Non</button>
            </span>
          )}
          {/* Multi-select actions */}
          {selectedKeys.size > 1 && (
            <>
              <div className="h-4 w-px bg-gray-700" />
              <button onClick={clearSelectedBoxes}
                className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-red-800/50 text-gray-300 hover:text-red-200 transition-colors"
                title={`Vider les ${selectedKeys.size} cellules sélectionnées`}
              >Vider ({selectedKeys.size})</button>
              {selectedEan && (
                <button onClick={() => fillSelectedBoxes(selectedEan)}
                  className="px-2 py-0.5 text-xs rounded bg-blue-800/50 hover:bg-blue-700/70 text-blue-200 transition-colors"
                  title={`Appliquer ${selectedEan} à ${selectedKeys.size} cellules`}
                >Appliquer ({selectedKeys.size})</button>
              )}
              {canFuse && (
                <button onClick={fuseSelectedBoxes}
                  className="px-2 py-0.5 text-xs rounded bg-violet-800/50 hover:bg-violet-700/70 text-violet-200 transition-colors"
                  title={`Fusionner les ${selectedKeys.size} boîtes contiguës en une seule`}
                >⊞ Fusionner ({selectedKeys.size})</button>
              )}
            </>
          )}
          {/* Single box actions */}
          {(canSplit || canDeleteBox) && selectedKeys.size <= 1 && (
            <>
              <div className="h-4 w-px bg-gray-700" />
              {canSplit && (
                <button onClick={splitSelectedBox}
                  className="px-2 py-0.5 text-xs rounded bg-violet-800/50 hover:bg-violet-700/70 text-violet-200 transition-colors"
                  title="Diviser cette boîte en deux">⊟ Diviser</button>
              )}
              {canDeleteBox && (
                <button onClick={() => { if (selDisplayRow !== null && selBoxIdx !== null) deleteBox(selDisplayRow, selBoxIdx); }}
                  className="px-2 py-0.5 text-xs rounded bg-red-800/40 hover:bg-red-700/60 text-red-300 transition-colors"
                  title="Supprimer cette boîte (sa largeur est redistribuée)">🗑 Suppr. boîte</button>
              )}
            </>
          )}
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-700 text-gray-400 hover:text-white text-base transition-colors" title="Fermer">×</button>
        </div>
      </div>

      {/* Overflow warning */}
      {isOverflowing && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-900/30 border-b border-red-700/50 text-xs text-red-300 shrink-0">
          <span className="text-base">🔴</span>
          <span>
            Ce planogramme ({gondola.width_cm} × {gondola.height_cm} cm) dépasse les dimensions de la gondole
            ({furniture?.dimensions.width ?? '?'} × {furniture?.dimensions.height ?? '?'} cm).
          </span>
        </div>
      )}

      {/* AddRow dialog */}
      {addRowDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-800 border border-gray-600 rounded-lg shadow-xl p-5 max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-gray-100 mb-2">Espace insuffisant</h3>
            <p className="text-xs text-gray-300 mb-4">
              {addRowDialog.canAutoFix
                ? `La rangée supérieure fait ${addRowDialog.topRowH.toFixed(1)} cm. Il faut ${addRowDialog.needed.toFixed(1)} cm pour la nouvelle rangée. Réduire automatiquement la rangée du haut ?`
                : `La rangée supérieure fait déjà ${addRowDialog.topRowH.toFixed(1)} cm, trop peu pour absorber une nouvelle rangée (${addRowDialog.needed.toFixed(1)} cm).`}
            </p>
            <div className="flex gap-2 justify-end">
              {addRowDialog.canAutoFix && (
                <button onClick={() => { setAddRowDialog(null); _doAddRow(addRowDialog.needed); }}
                  className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors">Réduire et ajouter</button>
              )}
              <button onClick={() => setAddRowDialog(null)}
                className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors">Annuler</button>
            </div>
          </div>
        </div>
      )}

      {/* Grid area */}
      <div className="flex-1 overflow-auto p-4">
        {/* Resize overlay */}
        {isResizing && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, cursor: isResizing === 'sep' ? 'col-resize' : 'row-resize' }} />
        )}
        {/* Tooltip */}
        {resizeTooltip && (
          <div style={{ position: 'fixed', left: resizeTooltip.x, top: resizeTooltip.y, zIndex: 10000, pointerEvents: 'none' }}
            className="bg-gray-950 text-blue-300 text-xs font-mono px-1.5 py-0.5 rounded border border-blue-500/60 shadow-lg whitespace-nowrap">
            {resizeTooltip.text}
          </div>
        )}

        {/* Column header */}
        <div className="flex mb-1" style={{ position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#111827' }}>
          <div style={{ width: '24px', flexShrink: 0, position: 'sticky', left: 0, zIndex: 20, backgroundColor: '#111827' }} />
          {Array.from({ length: maxBoxCount }, (_, c) => (
            <Fragment key={c}>
              {/* Width: derive from top shelf box widths */}
              {(() => {
                const topShelf = getShelfByDisplayIndex(gondola, 0);
                const topBoxes = topShelf ? getRowBoxes(boxes, 0) : [];
                const w = topBoxes[c] ? getBoxWidthPx(0, c) : CELL_MIN_PX;
                return (
                  <div
                    className={['text-center text-xs pb-0.5 flex-none cursor-pointer select-none transition-colors rounded-t',
                      selectedHeaderCol === c ? 'text-blue-400 bg-blue-900/40' : 'text-gray-600 hover:text-gray-300 hover:bg-gray-800/60'].join(' ')}
                    style={{ width: `${w}px` }}
                    onClick={() => handleColHeaderClick(c)}
                    title={`Colonne ${c + 1}`}
                  >{c + 1}</div>
                );
              })()}
              {c < maxBoxCount - 1 && (
                <div style={{ width: `${RESIZE_HANDLE_PX}px`, flexShrink: 0, cursor: 'col-resize' }}
                  className={['transition-colors', activeSnapIdx === c + 1 ? 'bg-yellow-400/80' : 'hover:bg-blue-500/60'].join(' ')}
                />
              )}
            </Fragment>
          ))}
          {greyExtWidthPx > 0 && (
            <div style={{ width: `${greyExtWidthPx}px`, marginLeft: `${RESIZE_HANDLE_PX}px`, flexShrink: 0 }}
              className="text-center text-xs text-gray-500 pb-0.5 italic"
              title={`${extraGondolaWidthCm.toFixed(0)} cm disponibles`}>
              +{extraGondolaWidthCm.toFixed(0)} cm
            </div>
          )}
        </div>

        <div className="flex">
          {/* Row numbers */}
          <div className="flex flex-col" style={{ width: '20px', marginRight: '4px', position: 'sticky', left: 0, zIndex: 5, backgroundColor: '#111827' }}>
            {Array.from({ length: shelfCount }, (_, di) => {
              const fillCm = rowFillCm[di];
              const fillRatio = gondola.width_cm > 0 ? fillCm / gondola.width_cm : 0;
              const fillColor = fillRatio > 1 ? '#ef4444' : fillRatio > 0.95 ? '#f59e0b' : '#22c55e';
              const rowH = getBoxHeightPx(di);
              return (
                <Fragment key={di}>
                  <div
                    className={['text-xs flex flex-col items-center justify-center flex-none cursor-pointer select-none transition-colors rounded-l',
                      selectedHeaderRow === di ? 'text-blue-400 bg-blue-900/40' : 'text-gray-600 hover:text-gray-300 hover:bg-gray-800/60'].join(' ')}
                    style={{ height: `${rowH}px`, width: '20px', position: 'relative', overflow: 'hidden' }}
                    onClick={() => handleRowHeaderClick(di)}
                    title={`Ligne ${di + 1} — ${fillCm.toFixed(1)} / ${gondola.width_cm.toFixed(1)} cm`}
                  >
                    {di + 1}
                    <div style={{ position: 'absolute', bottom: 0, left: 0, height: '3px', width: `${Math.min(fillRatio * 100, 100)}%`, backgroundColor: fillColor, borderRadius: '0 0 0 3px', transition: 'width 0.2s' }} />
                  </div>
                  {di < shelfCount - 1 && (
                    <div style={{ height: `${RESIZE_HANDLE_PX}px`, cursor: 'row-resize' }}
                      className={['transition-colors', (selDisplayRow === di || selDisplayRow === di + 1) ? 'bg-blue-500/40 hover:bg-blue-400/70' : 'bg-gray-800 hover:bg-blue-500/50'].join(' ')}
                      onMouseDown={(e) => startShelfResize(e, di)} title="Redimensionner ligne" />
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Main grid */}
          <div className="flex flex-col">
            {Array.from({ length: shelfCount }, (_, di) => {
              const rowBoxes = getRowBoxes(boxes, di);
              const rowH = getBoxHeightPx(di);
              return (
                <Fragment key={di}>
                  <div className="flex">
                    {rowBoxes.map((box) => {
                      const bi  = box.boxIndex;
                      const key = makeBoxKey(di, bi);
                      const prod = box.placement ? productByEan.get(box.placement.productId) : undefined;
                      const catColor = prod ? getCategoryColor(prod.category) : undefined;
                      const isSelected      = selectedKey === key;
                      const isMultiSelected = selectedKeys.has(key);
                      const isDragOver      = dragOver === key;
                      const isInternalDO    = internalDragOver === key;
                      const isHeaderHL      = selectedHeaderCol === bi || selectedHeaderRow === di;
                      const cellWCm = getBoxWidthCm(di, bi);
                      const cellHCm = getBoxHeightCm(di);
                      const cellWPx = getBoxWidthPx(di, bi);
                      const cellHPx = rowH;
                      const isUploading = prod && uploadingEan === prod.ean;
                      const prodOverflow = prod
                        ? prod.widthCm  > cellWCm + OVERFLOW_TOLERANCE_CM ||
                          prod.heightCm > cellHCm + OVERFLOW_TOLERANCE_CM
                        : false;
                      const showDimBadge = zoom >= 1 && prod;
                      const isLastBox = bi === rowBoxes.length - 1;

                      return (
                        <Fragment key={bi}>
                          <div
                            data-box-key={key}
                            draggable={!!box.placement}
                            onClick={(e) => handleBoxClick(di, bi, e)}
                            onContextMenu={(e) => { e.preventDefault(); if (box.placement) clearBox(di, bi); }}
                            onDragStart={(e) => {
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
                            onDragOver={(e) => {
                              e.preventDefault();
                              if (internalDragSrcRef.current) { setInternalDragOver(key); setDragOver(null); }
                              else { setDragOver(key); setInternalDragOver(null); }
                            }}
                            onDragLeave={() => { setDragOver(null); setInternalDragOver(null); }}
                            onDrop={(e) => handleDrop(e, di, bi)}
                            className={[
                              'relative flex flex-col items-start justify-start rounded cursor-pointer transition-all overflow-hidden select-none border group flex-none',
                              prodOverflow ? 'border-red-500 border-solid'
                                : isInternalDO ? 'border-blue-400 border-dashed bg-blue-900/20'
                                : isDragOver  ? 'border-green-400 bg-green-900/20 border-solid'
                                : box.placement ? 'border-transparent'
                                : 'border-dashed border-gray-700 hover:border-gray-500',
                              isSelected ? 'ring-2 ring-blue-500' : '',
                              isMultiSelected && !isSelected ? 'ring-2 ring-blue-400/70 bg-blue-900/20' : '',
                              isHeaderHL && !isSelected && !isMultiSelected ? 'ring-1 ring-blue-400/60 bg-blue-900/15' : '',
                              prodOverflow ? 'bg-red-900/20' : '',
                              box.placement ? 'cursor-grab active:cursor-grabbing' : '',
                            ].join(' ')}
                            style={{
                              width:  `${cellWPx}px`,
                              height: `${cellHPx}px`,
                              background: !prodOverflow && box.placement && catColor ? catColor + '18' : undefined,
                            }}
                            title={prodOverflow && prod
                              ? `⚠ ${prod.name} (${prod.widthCm}×${prod.heightCm} cm) dépasse (${cellWCm.toFixed(1)}×${cellHCm.toFixed(1)} cm)`
                              : box.placement ? `${prod?.name ?? box.placement.productId} — glisser pour déplacer` : undefined}
                          >
                            {box.placement && prod ? (
                              <>
                                <div className="absolute inset-x-0 top-0 h-1 rounded-t" style={{ background: prodOverflow ? '#ef4444' : catColor }} />
                                <div className="w-full px-1 pt-1.5 pb-0.5 flex flex-col items-center gap-0.5">
                                  <div className="w-full" style={{ height: `${Math.max(28, cellHPx - 32)}px` }}>
                                    {isUploading
                                      ? <div className="w-full h-full flex items-center justify-center"><div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /></div>
                                      : <ProductThumb product={prod} />}
                                  </div>
                                  <div className="text-xs font-medium leading-tight truncate w-full text-center"
                                    style={{ color: prodOverflow ? '#f87171' : catColor, fontSize: '10px' }}>
                                    {prod.name.length > 14 ? prod.name.slice(0, 12) + '…' : prod.name}
                                  </div>
                                  {showDimBadge && (
                                    <div className="text-center leading-none px-0.5 rounded"
                                      style={{ fontSize: '9px', color: prodOverflow ? '#f87171' : '#6b7280', background: prodOverflow ? 'rgba(239,68,68,0.15)' : undefined }}>
                                      {prod.widthCm}×{prod.heightCm} cm
                                      {zoom > 2 && <span style={{ color: '#4b5563' }}> / {cellWCm.toFixed(1)} cm</span>}
                                    </div>
                                  )}
                                </div>
                                {prodOverflow && (
                                  <div className="absolute bottom-0.5 left-0.5 text-red-400 leading-none" style={{ fontSize: '9px' }}>⚠ débordement</div>
                                )}
                                <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-blue-400 bg-gray-900/70 rounded text-xs leading-none"
                                    title="Uploader une vignette"
                                    onClick={(e) => { e.stopPropagation(); pendingUploadEan.current = prod.ean; uploadInputRef.current?.click(); }}
                                  >📷</button>
                                  <button
                                    className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 bg-gray-900/60 rounded text-xs leading-none"
                                    onClick={(e) => { e.stopPropagation(); clearBox(di, bi); }}
                                    title="Retirer"
                                  >×</button>
                                </div>
                              </>
                            ) : box.placement ? (
                              <>
                                <div className="text-xs text-gray-400 font-mono text-center px-1">{box.placement.productId.slice(-6)}</div>
                                <button className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs"
                                  onClick={(e) => { e.stopPropagation(); clearBox(di, bi); }}>×</button>
                              </>
                            ) : (
                              <>
                                <span className="text-gray-600 text-sm font-bold select-none leading-none">+</span>
                                {/* Info: box width */}
                                {zoom >= 1.5 && (
                                  <span className="absolute bottom-0.5 left-0.5 text-gray-600 leading-none select-none" style={{ fontSize: '8px' }}>
                                    {cellWCm.toFixed(1)} cm
                                  </span>
                                )}
                                {/* Delete-box button */}
                                {rowBoxes.length > 1 && (
                                  <button
                                    className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 bg-gray-900/60 rounded text-xs leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                                    onClick={(e) => { e.stopPropagation(); deleteBox(di, bi); }}
                                    title="Supprimer cette boîte (la largeur est redistribuée)"
                                  >×</button>
                                )}
                              </>
                            )}

                            {/* Selected-box separator drag handles */}
                            {isSelected && !isLastBox && (
                              <div
                                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startSepResize(e, di, bi); }}
                                style={{ position: 'absolute', right: 0, top: 0, width: '6px', height: '100%', cursor: 'col-resize', zIndex: 10, background: 'rgba(59,130,246,0.55)' }}
                                title="Déplacer le séparateur (cette ligne seulement)"
                              />
                            )}
                            {isSelected && bi > 0 && (
                              <div
                                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startSepResize(e, di, bi - 1); }}
                                style={{ position: 'absolute', left: 0, top: 0, width: '6px', height: '100%', cursor: 'col-resize', zIndex: 10, background: 'rgba(59,130,246,0.55)' }}
                                title="Déplacer le séparateur gauche (cette ligne seulement)"
                              />
                            )}
                          </div>

                          {/* Separator handle between boxes */}
                          {!isLastBox && (
                            <div
                              style={{ width: `${RESIZE_HANDLE_PX}px`, height: `${cellHPx}px`, cursor: 'col-resize', flexShrink: 0 }}
                              className={['transition-colors',
                                (selBoxIdx === bi || selBoxIdx === bi + 1) && selDisplayRow === di
                                  ? 'bg-blue-500/40 hover:bg-blue-400/70'
                                  : 'bg-gray-800 hover:bg-blue-500/50'].join(' ')}
                              onMouseDown={(e) => startSepResize(e, di, bi)}
                              title="Déplacer le séparateur"
                            />
                          )}
                        </Fragment>
                      );
                    })}

                    {/* Grey extension right */}
                    {greyExtWidthPx > 0 && (
                      <div style={{ width: `${greyExtWidthPx}px`, height: `${rowH}px`, flexShrink: 0, marginLeft: `${RESIZE_HANDLE_PX}px` }}
                        className="bg-gray-700/25 border border-dashed border-gray-600/50" />
                    )}
                  </div>

                  {/* Shelf resize handle */}
                  {di < shelfCount - 1 && (
                    <div
                      style={{ height: `${RESIZE_HANDLE_PX}px`, cursor: 'row-resize' }}
                      className={['transition-colors',
                        selDisplayRow === di || selDisplayRow === di + 1
                          ? 'bg-blue-500/40 hover:bg-blue-400/70'
                          : 'bg-gray-800 hover:bg-blue-500/50'].join(' ')}
                      onMouseDown={(e) => startShelfResize(e, di)}
                    />
                  )}
                </Fragment>
              );
            })}
            {/* Grey extension bottom */}
            {greyExtHeightPx > 0 && (
              <div style={{ height: `${greyExtHeightPx}px`, flexShrink: 0, marginTop: `${RESIZE_HANDLE_PX}px` }}
                className="bg-gray-700/25 border border-dashed border-gray-600/50" />
            )}
          </div>
        </div>
      </div>

      {/* Bottom hint */}
      <div className="border-t border-gray-800 px-4 py-2 flex items-center gap-3 shrink-0 text-xs text-gray-500">
        {selectedKeys.size > 1 ? (
          <>
            <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
            <span className="text-blue-300">{selectedKeys.size} boîtes sélectionnées</span>
            <span className="text-gray-600">· Suppr vider · Ctrl+clic toggle · Shift+clic étendre{canFuse ? ' · ⊞ Fusionner disponible' : ''}</span>
          </>
        ) : selectedEan ? (
          <>
            <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
            <span>Sélectionné: <span className="font-mono text-gray-300">{selectedEan}</span></span>
            <span className="text-gray-600">· Cliquer boîte vide pour placer · Glisser depuis catalogue</span>
          </>
        ) : (
          <span>Sélectionner un produit · Ctrl+clic multi-sélection · Shift+clic plage · Glisser pour déplacer · ⊞ Fusionner · ⊟ Diviser</span>
        )}
        <div className="flex-1" />
        <span className="text-gray-600">Clic droit/× vider · Suppr retirer · Ctrl+Z annuler · 🔴 débordement · moteur séparateurs v2</span>
      </div>
    </div>
  );
}

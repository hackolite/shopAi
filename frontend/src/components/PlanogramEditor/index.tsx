import { useState, useEffect, useRef } from 'react';
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
const CELL_MAX_PX     = 120;
/** Width scale: multiply physical cm-per-col by this to get pixel width. */
const CELL_WIDTH_SCALE  = 1.2;
/** Height scale: multiply physical cm-per-row by this to get pixel height. */
const CELL_HEIGHT_SCALE = 0.6;

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
    if (!planogram) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    applyUpdate({ ...planogram, rows: planogram.rows + 1, heightCm: planogram.heightCm + physCellH });
  };

  const removeRow = () => {
    if (!planogram || planogram.rows <= 1) return;
    const lastRow = planogram.rows - 1;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    applyUpdate({
      ...planogram,
      rows: planogram.rows - 1,
      heightCm: planogram.heightCm - physCellH,
      cells: planogram.cells.filter((c) => c.row !== lastRow),
    });
    if (selectedKey?.startsWith(`${lastRow}-`)) setSelectedKey(null);
  };

  const addCol = () => {
    if (!planogram) return;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    applyUpdate({ ...planogram, cols: planogram.cols + 1, widthCm: planogram.widthCm + physCellW });
  };

  const removeCol = () => {
    if (!planogram || planogram.cols <= 1) return;
    const lastCol = planogram.cols - 1;
    setHistory((prev) => [...prev.slice(-20), planogram]);
    applyUpdate({
      ...planogram,
      cols: planogram.cols - 1,
      widthCm: planogram.widthCm - physCellW,
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
  // Cell pixel size proportional to physical dimensions, scaled by zoom
  const cellW = Math.max(CELL_MIN_PX, Math.min(CELL_MAX_PX * ZOOM_MAX, Math.round(physCellW * CELL_WIDTH_SCALE  * zoom)));
  const cellH = Math.max(CELL_MIN_PX, Math.min(CELL_MAX_PX * ZOOM_MAX, Math.round(physCellH * CELL_HEIGHT_SCALE * zoom)));

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
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-sm transition-colors"
              title="Ajouter une ligne"
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
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 text-sm transition-colors"
              title="Ajouter une colonne"
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
        {/* Column numbers */}
        <div
          className="grid mb-1"
          style={{ gridTemplateColumns: `repeat(${cols}, ${cellW}px)`, gap: '2px', marginLeft: '24px' }}
        >
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="text-center text-xs text-gray-600 pb-0.5">{c + 1}</div>
          ))}
        </div>

        <div className="flex gap-1">
          {/* Row numbers */}
          <div className="flex flex-col gap-0.5">
            {Array.from({ length: rows }, (_, r) => (
              <div
                key={r}
                className="text-xs text-gray-600 w-5 flex items-center justify-center"
                style={{ height: `${cellH}px` }}
              >
                {r + 1}
              </div>
            ))}
          </div>

          {/* Main grid */}
          <div
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${cols}, ${cellW}px)`,
              gridTemplateRows:    `repeat(${rows}, ${cellH}px)`,
              gap: '2px',
            }}
          >
            {Array.from({ length: rows }, (_, row) =>
              Array.from({ length: cols }, (_, col) => {
                const key      = `${row}-${col}`;
                const cell     = cellMap.get(key);
                const prod     = cell ? productByEan.get(cell.ean) : undefined;
                const catColor = prod ? getCategoryColor(prod.category) : undefined;
                const isSelected = selectedKey === key;
                const isDragOver = dragOver === key;
                const isUploading = prod && uploadingEan === prod.ean;

                // Per-cell overflow: product physical dims exceed cell physical dims
                const prodOverflow = prod
                  ? prod.widthCm  > physCellW + OVERFLOW_TOLERANCE_CM ||
                    prod.heightCm > physCellH + OVERFLOW_TOLERANCE_CM
                  : false;

                return (
                  <div
                    key={key}
                    onClick={() => handleCellClick(row, col)}
                    onContextMenu={(e) => { e.preventDefault(); if (cell) clearCell(row, col); }}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => handleDrop(e, row, col)}
                    className={[
                      'relative flex flex-col items-center justify-center rounded cursor-pointer transition-all overflow-hidden select-none border group',
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
                    style={{ background: !prodOverflow && cell && catColor ? catColor + '18' : undefined }}
                    title={prodOverflow && prod
                      ? `⚠ ${prod.name} (${prod.widthCm}×${prod.heightCm} cm) dépasse la cellule (${physCellW.toFixed(1)}×${physCellH.toFixed(1)} cm)`
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
                          <div className="w-full" style={{ height: `${Math.max(28, cellH - 32)}px` }}>
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
                  </div>
                );
              }),
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
        <span className="text-gray-600">Clic droit ou × pour vider · Suppr. pour retirer · Ctrl+Z annuler · 📷 vignette · 🔴 produit trop grand</span>
      </div>
    </div>
  );
}

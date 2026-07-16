import { useState, useEffect, useRef } from 'react';
import { usePlanogramStore } from '../../store/planogramStore';
import { useCatalogStore } from '../../store/catalogStore';
import { cadApi } from '../../api/cad';
import type { Planogram, PlanogramCell } from '../../types/cad';

const CATEGORY_COLORS: Record<string, string> = {
  'Épicerie':  '#F5C518',
  'Boissons':  '#2196F3',
  'Frais':     '#4CAF50',
  'Hygiène':   '#9C27B0',
  'Bébé':      '#FF9800',
  'Promotion': '#F44336',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? '#9E9E9E';
}

type CellMap = Map<string, PlanogramCell>;

function buildCellMap(cells: PlanogramCell[]): CellMap {
  const map = new Map<string, PlanogramCell>();
  for (const cell of cells) {
    map.set(`${cell.row}-${cell.col}`, cell);
  }
  return map;
}

interface PlanogramEditorProps {
  projectId: string | null;
  planogramId: string;
  onClose: () => void;
}

export default function PlanogramEditor({
  projectId,
  planogramId,
  onClose,
}: PlanogramEditorProps) {
  const [planogram, setPlanogram] = useState<Planogram | null>(null);
  const [cellMap,   setCellMap]   = useState<CellMap>(new Map());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [history,   setHistory]   = useState<Planogram[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [dragOver,  setDragOver]  = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { setActivePlanogram } = usePlanogramStore();
  const { products, selectedEan, addRecentlyUsed } = useCatalogStore();

  // Build product lookup
  const productByEan = new Map(products.map((p) => [p.ean, p] as const));

  // ── Load planogram ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setSelectedKey(null);
    cadApi
      .getPlanogram(projectId, planogramId)
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

  // ── Mutate helpers ───────────────────────────────────────────────────────
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
      id:       existing?.id ?? crypto.randomUUID(),
      ean,
      row,
      col,
      rotation: 0,
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
    const newCells = planogram.cells.filter(
      (c) => !(c.row === row && c.col === col),
    );
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

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  // Use a ref so the effect never needs to re-subscribe when handlers change.
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

  // ── Cell click handler ───────────────────────────────────────────────────
  const handleCellClick = (row: number, col: number) => {
    const key  = `${row}-${col}`;
    const cell = cellMap.get(key);

    if (!cell && selectedEan) {
      fillCellWithEan(row, col, selectedEan);
      return;
    }
    setSelectedKey(key === selectedKey ? null : key);
  };

  // ── Drag-and-drop ────────────────────────────────────────────────────────
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

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-200 truncate">
            {planogram.name}
          </h2>
          <p className="text-xs text-gray-500">
            {rows} rows × {cols} cols
            &nbsp;·&nbsp;
            {planogram.widthCm} × {planogram.heightCm} cm
            &nbsp;·&nbsp;
            {planogram.cells.length} / {rows * cols} cells filled
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
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

      {/* Grid area */}
      <div className="flex-1 overflow-auto p-4">
        {/* Column numbers */}
        <div
          className="grid mb-1"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(72px, 1fr))`,
            gap: '2px',
            marginLeft: '24px',
          }}
        >
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="text-center text-xs text-gray-600 pb-0.5">
              {c + 1}
            </div>
          ))}
        </div>

        <div className="flex gap-1">
          {/* Row numbers */}
          <div className="flex flex-col gap-0.5">
            {Array.from({ length: rows }, (_, r) => (
              <div
                key={r}
                className="text-xs text-gray-600 w-5 flex items-center justify-center"
                style={{ height: '56px' }}
              >
                {r + 1}
              </div>
            ))}
          </div>

          {/* Main grid */}
          <div
            className="grid flex-1"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(72px, 1fr))`,
              gridTemplateRows:    `repeat(${rows}, 56px)`,
              gap: '2px',
            }}
          >
            {Array.from({ length: rows }, (_, row) =>
              Array.from({ length: cols }, (_, col) => {
                const key  = `${row}-${col}`;
                const cell = cellMap.get(key);
                const prod = cell ? productByEan.get(cell.ean) : undefined;
                const catColor = prod ? getCategoryColor(prod.category) : undefined;
                const isSelected = selectedKey === key;
                const isDragOver = dragOver === key;

                return (
                  <div
                    key={key}
                    onClick={() => handleCellClick(row, col)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (cell) clearCell(row, col);
                    }}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => handleDrop(e, row, col)}
                    className={[
                      'relative flex flex-col items-center justify-center rounded cursor-pointer transition-all text-center overflow-hidden select-none',
                      'border',
                      cell
                        ? 'border-transparent'
                        : isDragOver
                        ? 'border-blue-400 bg-blue-900/20 border-solid'
                        : 'border-dashed border-gray-700 hover:border-gray-500',
                      isSelected ? 'ring-2 ring-blue-500' : '',
                    ].join(' ')}
                    style={{
                      background: cell && catColor
                        ? catColor + '22'
                        : undefined,
                    }}
                  >
                    {cell && prod ? (
                      <>
                        {/* Filled cell */}
                        <div
                          className="absolute inset-x-0 top-0 h-1 rounded-t"
                          style={{ background: catColor }}
                        />
                        <div className="px-1 pt-1.5 pb-0.5 w-full">
                          <div
                            className="text-xs font-medium leading-tight truncate"
                            style={{ color: catColor }}
                          >
                            {prod.name.length > 16
                              ? prod.name.slice(0, 14) + '…'
                              : prod.name}
                          </div>
                          <div className="text-gray-500 text-xs font-mono truncate mt-0.5">
                            {cell.ean.slice(-6)}
                          </div>
                        </div>
                        {/* Delete on hover */}
                        <button
                          className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 opacity-0 hover:opacity-100 bg-gray-900/60 rounded transition-all text-xs leading-none"
                          onClick={(e) => { e.stopPropagation(); clearCell(row, col); }}
                          title="Remove"
                        >
                          ×
                        </button>
                      </>
                    ) : cell ? (
                      // Cell with EAN but no catalog match
                      <>
                        <div className="text-xs text-gray-400 font-mono">
                          {cell.ean.slice(-6)}
                        </div>
                        <button
                          className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center text-gray-500 hover:text-red-400 opacity-0 hover:opacity-100 text-xs leading-none"
                          onClick={(e) => { e.stopPropagation(); clearCell(row, col); }}
                        >
                          ×
                        </button>
                      </>
                    ) : (
                      // Empty cell
                      <span className="text-gray-700 text-xs opacity-0 hover:opacity-100 transition-opacity">
                        +
                      </span>
                    )}
                  </div>
                );
              }),
            )}
          </div>
        </div>
      </div>

      {/* Bottom palette / hint */}
      <div className="border-t border-gray-800 px-4 py-2 flex items-center gap-3 shrink-0 text-xs text-gray-500">
        {selectedEan ? (
          <>
            <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
            <span>
              Selected: <span className="font-mono text-gray-300">{selectedEan}</span>
            </span>
            <span className="text-gray-600">· Click empty cell to place · Drag from catalog</span>
          </>
        ) : (
          <span>Select a product in the catalog, then click a cell to place it</span>
        )}
        <div className="flex-1" />
        <span className="text-gray-600">Right-click or × to clear · Del to remove · Ctrl+Z to undo</span>
      </div>
    </div>
  );
}

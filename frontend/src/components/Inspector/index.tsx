import { useState, useRef, useEffect } from 'react';
import { useSceneStore } from '../../store/sceneStore';
import { usePlanogramStore } from '../../store/planogramStore';
import { useCatalogStore } from '../../store/catalogStore';
import { useZoneStore } from '../../store/zoneStore';
import { cadApi } from '../../api/cad';
import { OVERFLOW_TOLERANCE_CM } from '../../types/cad';
import type { FurnitureInstance, FaceId, Planogram, FloorZone } from '../../types/cad';
import { extendGondolaWidth, extendGondolaHeight, legacyCellsToSeparators, gondolaToLegacyPlanogram } from '../../engine/gondola';

/** Minimum cm growth required before extending a linked planogram to fill new gondola space. */
const DIMENSION_CHANGE_TOLERANCE_CM = 0.5;
/** Default rows when auto-creating a planogram from the Inspector. */
const DEFAULT_PLANOGRAM_ROWS = 3;
/** Default column width in cm when auto-creating a planogram from the Inspector. */
const DEFAULT_COLUMN_WIDTH_CM = 40;

const FACE_LABELS: Record<FaceId, string> = {
  front:  'Face avant',
  back:   'Face arrière',
  left:   'Face gauche',
  right:  'Face droite',
  top:    'Face haute',
  bottom: 'Face basse',
};

interface InspectorProps {
  projectId: string | null;
  onOpenPlanogram: (planogramId: string) => void;
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}

function NumberField({ label, value, onChange, min }: NumberFieldProps) {
  const [localVal, setLocalVal] = useState<string>(String(value));
  const prevValue = useRef(value);
  // Always-current refs so the cleanup effect never captures stale closures.
  const localValRef = useRef(localVal);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  localValRef.current = localVal;

  if (prevValue.current !== value) {
    prevValue.current = value;
    setLocalVal(String(value));
  }

  // Flush any uncommitted typed value when the component unmounts.
  // This handles the case where the parent FurnitureInspector unmounts (key change
  // on furniture selection) before onBlur has a chance to fire — without this guard
  // the user's pending rotation/position/dimension edit is silently discarded and
  // Zustand retains the pre-edit value, causing the 3D scene to revert on return.
  useEffect(() => {
    return () => {
      const n = parseFloat(localValRef.current);
      if (!isNaN(n) && n !== prevValue.current) {
        onChangeRef.current(n);
      }
    };
  }, []); // intentionally empty: only fires on unmount

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-500 w-16 shrink-0">{label}</label>
      <input
        type="number"
        min={min}
        value={localVal}
        onChange={(e) => setLocalVal(e.target.value)}
        onBlur={() => {
          const n = parseFloat(localVal);
          if (!isNaN(n)) onChange(n);
          else setLocalVal(String(value));
        }}
        className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 focus:outline-none focus:border-blue-500 min-w-0"
      />
    </div>
  );
}

interface FurnitureInspectorProps {
  furniture: FurnitureInstance;
  projectId: string | null;
  onOpenPlanogram: (planogramId: string) => void;
}

function FurnitureInspector({ furniture, projectId, onOpenPlanogram }: FurnitureInspectorProps) {
  const { updateFurniture } = useSceneStore();
  const { planograms, planogramDetails, syncPlanogram, setPlanogramDetail, setPlanograms } = usePlanogramStore();
  const { products: catalogProducts } = useCatalogStore();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last value passed to save() that has not yet been persisted to the backend. */
  const pendingSave = useRef<FurnitureInstance | null>(null);
  const [creatingFace, setCreatingFace] = useState<FaceId | null>(null);
  const [mounting, setMounting] = useState(false);

  const save = (updated: FurnitureInstance) => {
    updateFurniture(updated);
    pendingSave.current = updated;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (projectId) {
        cadApi.updateFurniture(projectId, updated.id, updated).catch(console.error);
      }
      pendingSave.current = null;
    }, 500);
  };

  // On unmount, cancel the debounce timer and immediately flush any pending
  // backend save, so a furniture change is never silently lost when the
  // Inspector switches to a different gondola (key change).
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const pending = pendingSave.current;
      if (pending && projectId) {
        cadApi.updateFurniture(projectId, pending.id, pending).catch(console.error);
      }
    };
  // projectId is captured to avoid sending to the wrong project if it changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const setPos = (axis: 0 | 1 | 2, v: number) => {
    const p = [...furniture.position] as [number, number, number];
    p[axis] = v;
    save({ ...furniture, position: p });
  };

  /**
   * Returns the face's allowed width and height (cm) given a set of furniture dimensions.
   * - front/back/top/bottom faces use furniture width for their planogram width.
   * - left/right faces use furniture depth for their planogram width.
   * - top/bottom faces use furniture depth for their planogram height.
   * - All other faces use furniture height for their planogram height.
   */
  const getFaceDims = (
    faceId: string,
    dims: { width: number; depth: number; height: number },
  ): { faceWidth: number; faceHeight: number } => {
    const isLeftRight = faceId === 'left' || faceId === 'right';
    const isTopBottom = faceId === 'top' || faceId === 'bottom';
    return {
      faceWidth: isLeftRight ? dims.depth : dims.width,
      faceHeight: isTopBottom ? dims.depth : dims.height,
    };
  };

  /**
   * Scale a record of cm values by a given factor.
   */
  const scaleRecord = (
    rec: Record<string, number> | undefined,
    factor: number,
  ): Record<string, number> | undefined => {
    if (!rec) return undefined;
    return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v * factor]));
  };

  const setDim = (key: 'width' | 'depth' | 'height', v: number) => {
    const newDims = { ...furniture.dimensions, [key]: v };
    save({ ...furniture, dimensions: newDims });

    // Proportionally scale any linked planogram whose declared dimensions would
    // exceed the new gondola face dimensions.  Only affects planograms where the
    // changed dimension maps to a face width/height that actually shrank.
    if (!projectId) return;
    const faceEntries = Object.entries(furniture.faces) as [string, string | null][];
    for (const [faceId, planogramId] of faceEntries) {
      if (!planogramId) continue;
      const detail = planogramDetails.get(planogramId);
      if (!detail) continue;

      const { faceWidth, faceHeight } = getFaceDims(faceId, newDims);

      let updated = detail;

      if (detail.widthCm > faceWidth) {
        const wScale = faceWidth / detail.widthCm;
        updated = {
          ...updated,
          widthCm: faceWidth,
          ...(detail.colWidthsCm && { colWidthsCm: detail.colWidthsCm.map(w => w * wScale) }),
          cellWidthOverrides: scaleRecord(detail.cellWidthOverrides, wScale),
        };
      }

      if (detail.heightCm > faceHeight) {
        const hScale = faceHeight / detail.heightCm;
        updated = {
          ...updated,
          heightCm: faceHeight,
          ...(detail.rowHeightsCm && { rowHeightsCm: detail.rowHeightsCm.map(h => h * hScale) }),
          cellHeightOverrides: scaleRecord(detail.cellHeightOverrides, hScale),
        };
      }

      if (updated !== detail) {
        // If gondola data is present, scale its geometry to match the new (smaller) face dimensions.
        // The checks mirror the legacy-field scaling above: only clip when the planogram now exceeds
        // the face boundary — we do not scale up when the furniture grows larger.
        if (updated.gondola) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let scaledGondola: any = { ...updated.gondola };

          if (detail.widthCm > faceWidth) {
            const wScale = faceWidth / detail.widthCm;
            scaledGondola = {
              ...scaledGondola,
              width_cm: faceWidth,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              shelves: scaledGondola.shelves?.map((shelf: any) => ({
                ...shelf,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                separators: shelf.separators?.map((sep: any) => ({
                  ...sep,
                  position_cm: sep.position_cm * wScale,
                })),
              })),
            };
          }

          if (detail.heightCm > faceHeight) {
            const hScale = faceHeight / detail.heightCm;
            scaledGondola = {
              ...scaledGondola,
              height_cm: faceHeight,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              shelves: scaledGondola.shelves?.map((shelf: any) => ({
                ...shelf,
                height_cm: shelf.height_cm * hScale,
              })),
            };
          }

          updated = { ...updated, gondola: scaledGondola };
        }
        cadApi.updatePlanogram(projectId, planogramId, updated).catch(console.error);
        syncPlanogram(updated);
      } else if (faceWidth > detail.widthCm + DIMENSION_CHANGE_TOLERANCE_CM) {
        // Furniture grew wider — extend the gondola to fill the new space with empty columns.
        const gondola = detail.gondola ?? legacyCellsToSeparators(detail);
        const extended = extendGondolaWidth(gondola, faceWidth);
        if (extended !== gondola) {
          const extUpdated = gondolaToLegacyPlanogram(extended, { ...detail, gondola: extended });
          cadApi.updatePlanogram(projectId, planogramId, extUpdated).catch(console.error);
          syncPlanogram(extUpdated);
        }
      } else if (faceHeight > detail.heightCm + DIMENSION_CHANGE_TOLERANCE_CM) {
        // Furniture grew deeper (or taller) — extend the gondola height to fill the new space with an empty row.
        const gondola = detail.gondola ?? legacyCellsToSeparators(detail);
        const extraHeight = faceHeight - gondola.height_cm;
        if (extraHeight > DIMENSION_CHANGE_TOLERANCE_CM) {
          const extended = extendGondolaHeight(gondola, extraHeight);
          const extUpdated = gondolaToLegacyPlanogram(extended, { ...detail, gondola: extended });
          cadApi.updatePlanogram(projectId, planogramId, extUpdated).catch(console.error);
          syncPlanogram(extUpdated);
        }
      }
    }
  };

  const setRotY = (v: number) => {
   const snapped = Math.round(v / 90) * 90;
   const r = [...furniture.rotation] as [number, number, number];
   r[1] = snapped;
   save({ ...furniture, rotation: r });
  };

  const faceEntries = Object.entries(furniture.faces) as [FaceId, string | null][];

  /** Update rows or cols of an existing planogram and persist to backend. */
  const handleUpdatePlanogramGrid = (planogramId: string, field: 'rows' | 'cols', value: number) => {
    const detail = planogramDetails.get(planogramId);
    if (!detail || value < 1) return;
    const newRows = field === 'rows' ? value : detail.rows;
    const newCols = field === 'cols' ? value : detail.cols;
    const updated: Planogram = {
      ...detail,
      rows: newRows,
      cols: newCols,
      // Trim cells that fall outside the new grid bounds.
      cells: detail.cells.filter((c) => c.row < newRows && c.col < newCols),
    };
    syncPlanogram(updated);
    if (projectId) cadApi.updatePlanogram(projectId, planogramId, updated).catch(console.error);
  };

  /** Mount the furniture into 3D (irreversible). */
  const handleMount = async () => {
    if (furniture.mounted !== false) return;
    setMounting(true);
    try {
      // For floor_grid: fill the top face planogram randomly with catalog products.
      if (furniture.type === 'floor_grid' && furniture.faces.top && projectId) {
        const planogramId = furniture.faces.top;
        const detail = planogramDetails.get(planogramId);
        if (detail && catalogProducts.length > 0) {
          const total = detail.rows * detail.cols;
          // Build a shuffled list of EANs (repeat catalog cyclically then shuffle)
          const eans = Array.from({ length: total }, (_, i) =>
            catalogProducts[i % catalogProducts.length].ean,
          );
          for (let i = eans.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [eans[i], eans[j]] = [eans[j], eans[i]];
          }
          const cells = Array.from({ length: total }, (_, idx) => ({
            id: crypto.randomUUID(),
            ean: eans[idx],
            row: Math.floor(idx / detail.cols),
            col: idx % detail.cols,
            rotation: 0 as const,
          }));
          const updated = { ...detail, cells };
          syncPlanogram(updated);
          await cadApi.updatePlanogram(projectId, planogramId, updated);
        }
      }
      const updated = { ...furniture, mounted: true };
      save(updated);
    } finally {
      setMounting(false);
    }
  };

  const handleDeleteFace = async (faceId: FaceId, planogramId: string) => {
   if (projectId) {
     try {
       await cadApi.deletePlanogram(projectId, planogramId);
     } catch {}
   }
   const newFaces = { ...furniture.faces, [faceId]: null };
   save({ ...furniture, faces: newFaces });
  };

  /** Create a new empty planogram for a face that currently has none. */
  const handleCreateFace = async (faceId: FaceId) => {
    if (!projectId) return;
    setCreatingFace(faceId);
    try {
      const isLeftRight = faceId === 'left' || faceId === 'right';
      const widthCm = isLeftRight ? furniture.dimensions.depth : furniture.dimensions.width;
      const heightCm = (faceId === 'top' || faceId === 'bottom')
        ? furniture.dimensions.depth
        : furniture.dimensions.height;
      const rows = DEFAULT_PLANOGRAM_ROWS;
      const cols = Math.max(1, Math.floor(widthCm / DEFAULT_COLUMN_WIDTH_CM));

      const planogram: Planogram = {
        id: crypto.randomUUID(),
        name: `${furniture.name} - ${FACE_LABELS[faceId]}`,
        furnitureId: furniture.id,
        face: faceId,
        rows,
        cols,
        widthCm,
        heightCm,
        cells: [],
      };

      const createdPlanogram = await cadApi.createPlanogram(projectId, planogram);
      setPlanogramDetail(createdPlanogram);

      const newFaces = { ...furniture.faces, [faceId]: createdPlanogram.id };
      const updatedFurniture = { ...furniture, faces: newFaces };
      const persistedFurniture = await cadApi.updateFurniture(projectId, furniture.id, updatedFurniture);
      save(persistedFurniture);

      const refreshed = await cadApi.listPlanograms(projectId);
      setPlanograms(refreshed.planograms);

      onOpenPlanogram(createdPlanogram.id);
    } catch (err) {
      console.error('Failed to create planogram for face:', err);
    } finally {
      setCreatingFace(null);
    }
  };

  /** True if the planogram's declared dimensions exceed the furniture face. */
  const isFaceOverflowing = (faceId: FaceId, planogramId: string): boolean => {
    const summary = planograms.find(p => p.id === planogramId);
    if (!summary) return false;
   const allowedWidth =
     faceId === 'left' || faceId === 'right'
       ? furniture.dimensions.depth
       : furniture.dimensions.width;
   const allowedHeight =
     faceId === 'top' || faceId === 'bottom'
       ? furniture.dimensions.depth
       : furniture.dimensions.height;
   return (
     summary.widthCm  > allowedWidth + OVERFLOW_TOLERANCE_CM ||
     summary.heightCm > allowedHeight + OVERFLOW_TOLERANCE_CM
   );
  };

  const anyOverflow = faceEntries.some(([faceId, pid]) => pid && isFaceOverflowing(faceId, pid));

  return (
    <div className="space-y-4">
      {/* Furniture header */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Meuble</span>
          <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 text-xs font-mono">
            {furniture.type}
          </span>
        </div>
        <input
          type="text"
          defaultValue={furniture.name}
          onBlur={(e) => save({ ...furniture, name: e.target.value })}
          className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-200 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Position */}
      <section>
        <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">Position (cm)</h4>
        <div className="space-y-1.5">
          <NumberField label="X" value={furniture.position[0]} onChange={(v) => setPos(0, v)} />
          <NumberField label="Y" value={furniture.position[1]} onChange={(v) => setPos(1, v)} min={0} />
          <NumberField label="Z" value={furniture.position[2]} onChange={(v) => setPos(2, v)} />
        </div>
      </section>

      {/* Dimensions */}
      <section>
        <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">
          Dimensions (cm)
        </h4>
        <div className="space-y-1.5">
          <NumberField label="Largeur"  value={furniture.dimensions.width}  onChange={(v) => setDim('width',  v)} min={1} />
          <NumberField label="Profond." value={furniture.dimensions.depth}  onChange={(v) => setDim('depth',  v)} min={1} />
          <NumberField label="Hauteur"  value={furniture.dimensions.height} onChange={(v) => setDim('height', v)} min={1} />
        </div>
        <p className="mt-1.5 text-xs text-gray-600">
          {(furniture.dimensions.width / 100).toFixed(2)} m ×&nbsp;
          {(furniture.dimensions.depth / 100).toFixed(2)} m ×&nbsp;
          {(furniture.dimensions.height / 100).toFixed(2)} m
        </p>
      </section>

      {/* Rotation */}
      <section>
        <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">Rotation</h4>
        <NumberField label="Y (°)" value={furniture.rotation[1]} onChange={setRotY} />
      </section>

      {/* Overflow banner */}
      {anyOverflow && (
        <div className="flex items-start gap-2 px-2 py-2 rounded bg-red-900/25 border border-red-700/40 text-xs text-red-300">
          <span className="text-base leading-none mt-0.5">🔴</span>
          <span>
            Un ou plusieurs planogrammes dépassent les dimensions de la gondole.
            Agrandissez la gondole ou réduisez le planogramme.
          </span>
        </div>
      )}

      {/* Planograms / Faces */}
      {faceEntries.length > 0 && (
        <section>
          <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">
            Planogrammes
          </h4>
          <div className="space-y-2">
            {faceEntries.map(([faceId, planogramId]) => {
              const overflow = planogramId ? isFaceOverflowing(faceId, planogramId) : false;
              const detail = planogramId ? planogramDetails.get(planogramId) : null;
              return (
                <div key={faceId} className="space-y-1">
                  <div
                    className={[
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-gray-300 transition-colors',
                      overflow
                        ? 'bg-red-900/30 border border-red-700/50'
                        : 'bg-gray-800',
                    ].join(' ')}
                    title={overflow ? '⚠ Le planogramme dépasse les dimensions de la gondole' : undefined}
                  >
                    <span>{overflow ? '🔴' : '🗂️'}</span>
                    <span className="flex-1">{FACE_LABELS[faceId]}</span>
                    {planogramId ? (
                      <>
                        {overflow && <span className="text-red-400 font-semibold">DÉBORD</span>}
                        <button
                          onClick={() => onOpenPlanogram(planogramId)}
                          className="text-blue-400 hover:text-blue-300"
                        >
                          Ouvrir →
                        </button>
                        <button
                          onClick={() => { handleDeleteFace(faceId, planogramId).catch(console.error); }}
                          title="Supprimer le planogramme"
                          className="text-gray-500 hover:text-red-400"
                        >
                          🗑
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => { void handleCreateFace(faceId); }}
                        disabled={creatingFace !== null}
                        title="Créer un planogramme pour cette face"
                        className="text-gray-500 hover:text-green-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {creatingFace === faceId ? '⟳' : '＋'}
                      </button>
                    )}
                  </div>
                  {/* Rows / Cols quick-edit (visible when furniture is à plat or floor_grid type) */}
                  {planogramId && detail && (furniture.mounted === false || furniture.type === 'floor_grid') && (
                    <div className="flex items-center gap-2 px-2 pb-1">
                      <span className="text-xs text-gray-600 w-16 shrink-0">Lignes</span>
                      <input
                        type="number" min={1} max={20}
                        defaultValue={detail.rows}
                        key={`rows-${planogramId}-${detail.rows}`}
                        onBlur={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (!isNaN(v) && v >= 1) handleUpdatePlanogramGrid(planogramId, 'rows', v);
                        }}
                        className="flex-1 px-2 py-0.5 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 focus:outline-none focus:border-blue-500 min-w-0"
                      />
                      <span className="text-xs text-gray-600 shrink-0">Cols</span>
                      <input
                        type="number" min={1} max={50}
                        defaultValue={detail.cols}
                        key={`cols-${planogramId}-${detail.cols}`}
                        onBlur={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (!isNaN(v) && v >= 1) handleUpdatePlanogramGrid(planogramId, 'cols', v);
                        }}
                        className="flex-1 px-2 py-0.5 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 focus:outline-none focus:border-blue-500 min-w-0"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Mount / À plat status */}
      {furniture.mounted === false ? (
        <section className="space-y-2">
          <div className="flex items-center gap-2 px-2 py-2 rounded bg-amber-900/25 border border-amber-700/40 text-xs text-amber-300">
            <span className="text-base leading-none">▭</span>
            <span>Ce meuble est <strong>à plat</strong> — visible dans la scène 3D comme un rectangle au sol.</span>
          </div>
          <button
            onClick={() => { void handleMount(); }}
            disabled={mounting}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors"
          >
            {mounting ? <span className="animate-spin">⟳</span> : <span>🏗</span>}
            Monter en 3D
          </button>
          <p className="text-xs text-gray-600 text-center">Cette action est irréversible.</p>
        </section>
      ) : (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-blue-900/20 border border-blue-700/30 text-xs text-blue-400">
          <span>🏗</span>
          <span>Monté en 3D</span>
        </div>
      )}

      {/* Visibility / Lock */}
      <section className="flex gap-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={furniture.visible}
            onChange={() => save({ ...furniture, visible: !furniture.visible })}
            className="accent-blue-500"
          />
          <span className="text-xs text-gray-400">Visible</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={furniture.locked}
            onChange={() => save({ ...furniture, locked: !furniture.locked })}
            className="accent-blue-500"
          />
          <span className="text-xs text-gray-400">Verrouillé</span>
        </label>
      </section>
    </div>
  );
}

// ─── Supply zone inspector ────────────────────────────────────────────────────
function SupplyZoneInspector({ zone, projectId }: { zone: FloorZone; projectId: string | null }) {
  const { updateZone } = useZoneStore();
  const { scene } = useSceneStore();

  const save = (updated: FloorZone) => {
    updateZone(updated);
    if (projectId && scene) {
      const zones = useZoneStore.getState().zones.map((z) => (z.id === updated.id ? updated : z));
      cadApi.updateStore(projectId, { ...scene.store, zones }).catch(console.error);
    }
  };

  return (
    <div className="space-y-3">
      <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Fournitures</h4>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 w-16 shrink-0">Lignes</label>
          <input
            type="number"
            min={1}
            value={zone.rows ?? 1}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n) && n >= 1) save({ ...zone, rows: n });
            }}
            className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 focus:outline-none focus:border-blue-500 min-w-0"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 w-16 shrink-0">Colonnes</label>
          <input
            type="number"
            min={1}
            value={zone.cols ?? 1}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n) && n >= 1) save({ ...zone, cols: n });
            }}
            className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 focus:outline-none focus:border-blue-500 min-w-0"
          />
        </div>
      </div>
      <div className="space-y-1 pt-1 border-t border-gray-800 text-xs text-gray-400">
        <div className="flex justify-between">
          <span className="text-gray-500">Largeur</span>
          <span>{zone.width} cm</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Profondeur</span>
          <span>{zone.depth} cm</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Cellules</span>
          <span>{(zone.rows ?? 1) * (zone.cols ?? 1)}</span>
        </div>
      </div>
    </div>
  );
}

export default function Inspector({ projectId, onOpenPlanogram }: InspectorProps) {
  const { scene, selectedFurnitureId, selection } = useSceneStore();
  const { activePlanogram, selectedCellIds, planograms, planogramDetails } = usePlanogramStore();
  const { products } = useCatalogStore();
  const { zones, selectedZoneId } = useZoneStore();

  const selectedFurniture = scene?.furniture.find(
    (f) => f.id === selectedFurnitureId,
  ) ?? null;

  const selectedZone = selectedZoneId
    ? (zones.find((z) => z.id === selectedZoneId) ?? null)
    : null;
  const selectedSupplyZone = selectedZone?.type === 'supply' ? selectedZone : null;

  const selectedPlanogram =
    selection.type === 'planogram_cell' && selection.planogramId
      ? (activePlanogram?.id === selection.planogramId
          ? activePlanogram
          : (planogramDetails.get(selection.planogramId) ?? null))
      : activePlanogram;

  const selectedCellIdArr =
    selection.type === 'planogram_cell' && selection.cellIds?.length
      ? selection.cellIds
      : Array.from(selectedCellIds);
  const selectedCell =
    selectedPlanogram && selectedCellIdArr.length === 1
      ? selectedPlanogram.cells.find((c) => c.id === selectedCellIdArr[0]) ?? null
      : null;
  const selectedPlanogramSummary =
    selection.type === 'planogram_cell' && selection.planogramId
      ? (planograms.find((planogram) => planogram.id === selection.planogramId) ?? null)
      : null;
  const selectedEanProduct = selection.type === 'planogram_cell' && selection.ean
    ? (products.find((product) => product.ean === selection.ean) ?? null)
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-800 shrink-0">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Inspector</h3>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {selectedFurniture && (
          <FurnitureInspector
            key={selectedFurniture.id}
            furniture={selectedFurniture}
            projectId={projectId}
            onOpenPlanogram={onOpenPlanogram}
          />
        )}

        {!selectedFurniture && selectedSupplyZone && (
          <SupplyZoneInspector
            key={selectedSupplyZone.id}
            zone={selectedSupplyZone}
            projectId={projectId}
          />
        )}

        {!selectedFurniture && !selectedSupplyZone && (selectedCell || selectedEanProduct) && (
          <div className="space-y-3">
            {selectedCell && (
              <>
                <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Cellule</h4>
                <div className="space-y-1.5 text-xs text-gray-300">
                  <div className="flex justify-between">
                    <span className="text-gray-500">EAN</span>
                    <span className="font-mono">{selectedCell.ean}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Ligne</span>
                    <span>{selectedCell.row + 1}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Colonne</span>
                    <span>{selectedCell.col + 1}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Planogramme</span>
                    <span className="truncate max-w-32">
                      {selectedPlanogram?.name ?? selectedPlanogramSummary?.name ?? '—'}
                    </span>
                  </div>
                </div>
              </>
            )}

            {selectedEanProduct && (
              <div className="space-y-2 pt-2 border-t border-gray-800">
                <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Produit</h4>
                {selectedEanProduct.imageUrl && (
                  <img
                    src={selectedEanProduct.imageUrl}
                    alt={selectedEanProduct.name}
                    className="w-full h-32 object-contain bg-gray-800 rounded border border-gray-700"
                  />
                )}
                <div className="space-y-1.5 text-xs text-gray-300">
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500">Nom</span>
                    <span className="text-right">{selectedEanProduct.name}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500">Marque</span>
                    <span className="text-right">{selectedEanProduct.brand}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500">Catégorie</span>
                    <span className="text-right">{selectedEanProduct.category}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500">Dimensions</span>
                    <span className="text-right">
                      {selectedEanProduct.widthCm} × {selectedEanProduct.depthCm} × {selectedEanProduct.heightCm} cm
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-gray-500">EAN</span>
                    <span className="font-mono text-right">{selectedEanProduct.ean}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {!selectedFurniture && !selectedSupplyZone && !selectedCell && !selectedEanProduct && (
          <div className="space-y-4">
            <p className="text-xs text-gray-600 italic">
              Sélectionnez un meuble ou un produit dans la scène.
            </p>
            {scene && (
              <div className="space-y-2 pt-2 border-t border-gray-800">
                <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Projet</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between text-gray-400">
                    <span>Meubles</span>
                    <span className="text-gray-300">{scene.furniture.length}</span>
                  </div>
                  <div className="flex justify-between text-gray-400">
                    <span>Surface magasin</span>
                    <span className="text-gray-300">
                      {scene.store.dimensions.width / 100}m × {scene.store.dimensions.depth / 100}m
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

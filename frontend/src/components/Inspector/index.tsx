import { useState, useRef } from 'react';
import { useSceneStore } from '../../store/sceneStore';
import { usePlanogramStore } from '../../store/planogramStore';
import { useCatalogStore } from '../../store/catalogStore';
import { cadApi } from '../../api/cad';
import { OVERFLOW_TOLERANCE_CM } from '../../types/cad';
import type { FurnitureInstance, FaceId } from '../../types/cad';

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
  if (prevValue.current !== value) {
    prevValue.current = value;
    setLocalVal(String(value));
  }

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
  const { planograms, planogramDetails, syncPlanogram } = usePlanogramStore();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = (updated: FurnitureInstance) => {
    updateFurniture(updated);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (projectId) {
        cadApi.updateFurniture(projectId, updated.id, updated).catch(console.error);
      }
    }, 500);
  };

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
        // If gondola data is present, scale its geometry to match the new face dimensions.
        // This keeps separator positions and shelf heights in sync with the resized furniture.
        if (updated.gondola) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let g: any = { ...updated.gondola };

          if (detail.widthCm > faceWidth) {
            const wScale = faceWidth / detail.widthCm;
            g = {
              ...g,
              width_cm: faceWidth,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              shelves: g.shelves?.map((shelf: any) => ({
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
            g = {
              ...g,
              height_cm: faceHeight,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              shelves: g.shelves?.map((shelf: any) => ({
                ...shelf,
                height_cm: shelf.height_cm * hScale,
              })),
            };
          }

          updated = { ...updated, gondola: g };
        }
        cadApi.updatePlanogram(projectId, planogramId, updated).catch(console.error);
        syncPlanogram(updated);
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

  const handleDeleteFace = async (faceId: FaceId, planogramId: string) => {
   if (projectId) {
     try {
       await cadApi.deletePlanogram(projectId, planogramId);
     } catch {}
   }
   const newFaces = { ...furniture.faces, [faceId]: null };
   save({ ...furniture, faces: newFaces });
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
          <div className="space-y-1">
            {faceEntries.map(([faceId, planogramId]) => {
              const overflow = planogramId ? isFaceOverflowing(faceId, planogramId) : false;
              return (
                <div
                  key={faceId}
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
                    <span className="text-gray-600">—</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
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

export default function Inspector({ projectId, onOpenPlanogram }: InspectorProps) {
  const { scene, selectedFurnitureId, selection } = useSceneStore();
  const { activePlanogram, selectedCellIds, planograms, planogramDetails } = usePlanogramStore();
  const { products } = useCatalogStore();

  const selectedFurniture = scene?.furniture.find(
    (f) => f.id === selectedFurnitureId,
  ) ?? null;

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

        {!selectedFurniture && (selectedCell || selectedEanProduct) && (
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

        {!selectedFurniture && !selectedCell && !selectedEanProduct && (
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

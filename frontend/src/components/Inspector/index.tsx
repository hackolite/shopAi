import { useState, useRef } from 'react';
import { useSceneStore } from '../../store/sceneStore';
import { usePlanogramStore } from '../../store/planogramStore';
import { cadApi } from '../../api/cad';
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
  const { planograms }      = usePlanogramStore();
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

  const setDim = (key: 'width' | 'depth' | 'height', v: number) => {
    save({ ...furniture, dimensions: { ...furniture.dimensions, [key]: v } });
  };

  const setRotY = (v: number) => {
    const r = [...furniture.rotation] as [number, number, number];
    r[1] = v;
    save({ ...furniture, rotation: r });
  };

  const faceEntries = (Object.entries(furniture.faces) as [FaceId, string | null][])
    .filter(([, pid]) => pid != null && pid !== '');

  /** True if the planogram's declared dimensions exceed the furniture face. */
  const isFaceOverflowing = (planogramId: string): boolean => {
    const summary = planograms.find(p => p.id === planogramId);
    if (!summary) return false;
    return (
      summary.widthCm  > furniture.dimensions.width  + 0.5 ||
      summary.heightCm > furniture.dimensions.height + 0.5
    );
  };

  const anyOverflow = faceEntries.some(([, pid]) => pid && isFaceOverflowing(pid));

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
              const overflow = planogramId ? isFaceOverflowing(planogramId) : false;
              return (
                <button
                  key={faceId}
                  onClick={() => onOpenPlanogram(planogramId!)}
                  className={[
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-gray-300 transition-colors text-left',
                    overflow
                      ? 'bg-red-900/30 border border-red-700/50 hover:bg-red-900/50'
                      : 'bg-gray-800 hover:bg-gray-700',
                  ].join(' ')}
                  title={overflow ? '⚠ Le planogramme dépasse les dimensions de la gondole' : undefined}
                >
                  <span>{overflow ? '🔴' : '🗂️'}</span>
                  <span className="flex-1">{FACE_LABELS[faceId]}</span>
                  {overflow
                    ? <span className="text-red-400 font-semibold">DÉBORD</span>
                    : <span className="text-blue-400">Ouvrir →</span>
                  }
                </button>
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
  const { scene, selectedFurnitureId } = useSceneStore();
  const { activePlanogram, selectedCellIds } = usePlanogramStore();

  const selectedFurniture = scene?.furniture.find(
    (f) => f.id === selectedFurnitureId,
  ) ?? null;

  const selectedCellIdArr = Array.from(selectedCellIds);
  const selectedCell =
    activePlanogram && selectedCellIdArr.length === 1
      ? activePlanogram.cells.find((c) => c.id === selectedCellIdArr[0]) ?? null
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

        {!selectedFurniture && selectedCell && activePlanogram && (
          <div className="space-y-3">
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
                <span className="truncate max-w-32">{activePlanogram.name}</span>
              </div>
            </div>
          </div>
        )}

        {!selectedFurniture && !selectedCell && (
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

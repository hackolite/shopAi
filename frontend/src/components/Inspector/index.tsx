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

  // Sync when prop changes (different selection)
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

  return (
    <div className="space-y-4">
      {/* Furniture header */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">
            Furniture
          </span>
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
        <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">
          Position (cm)
        </h4>
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
          <NumberField label="Width"  value={furniture.dimensions.width}  onChange={(v) => setDim('width',  v)} min={1} />
          <NumberField label="Depth"  value={furniture.dimensions.depth}  onChange={(v) => setDim('depth',  v)} min={1} />
          <NumberField label="Height" value={furniture.dimensions.height} onChange={(v) => setDim('height', v)} min={1} />
        </div>
      </section>

      {/* Rotation */}
      <section>
        <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">
          Rotation
        </h4>
        <NumberField label="Y (°)" value={furniture.rotation[1]} onChange={setRotY} />
      </section>

      {/* Planograms / Faces */}
      {faceEntries.length > 0 && (
        <section>
          <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2">
            Planograms
          </h4>
          <div className="space-y-1">
            {faceEntries.map(([faceId, planogramId]) => (
              <button
                key={faceId}
                onClick={() => onOpenPlanogram(planogramId!)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 transition-colors text-left"
              >
                <span>🗂️</span>
                <span className="flex-1">{FACE_LABELS[faceId]}</span>
                <span className="text-blue-400 text-xs">Open →</span>
              </button>
            ))}
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
          <span className="text-xs text-gray-400">Locked</span>
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
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-800 shrink-0">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Inspector
        </h3>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* Furniture selected */}
        {selectedFurniture && (
          <FurnitureInspector
            key={selectedFurniture.id}
            furniture={selectedFurniture}
            projectId={projectId}
            onOpenPlanogram={onOpenPlanogram}
          />
        )}

        {/* Planogram cell selected */}
        {!selectedFurniture && selectedCell && activePlanogram && (
          <div className="space-y-3">
            <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold">
              Cell
            </h4>
            <div className="space-y-1.5 text-xs text-gray-300">
              <div className="flex justify-between">
                <span className="text-gray-500">EAN</span>
                <span className="font-mono">{selectedCell.ean}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Row</span>
                <span>{selectedCell.row + 1}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Column</span>
                <span>{selectedCell.col + 1}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Planogram</span>
                <span className="truncate max-w-32">{activePlanogram.name}</span>
              </div>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!selectedFurniture && !selectedCell && (
          <div className="space-y-4">
            <p className="text-xs text-gray-600 italic">
              Select a furniture piece or product in the scene.
            </p>

            {/* Project stats */}
            {scene && (
              <div className="space-y-2 pt-2 border-t border-gray-800">
                <h4 className="text-xs text-gray-500 uppercase tracking-wider font-semibold">
                  Project
                </h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between text-gray-400">
                    <span>Furniture</span>
                    <span className="text-gray-300">{scene.furniture.length}</span>
                  </div>
                  <div className="flex justify-between text-gray-400">
                    <span>Store</span>
                    <span className="text-gray-300">
                      {scene.store.widthCm / 100}m × {scene.store.depthCm / 100}m
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

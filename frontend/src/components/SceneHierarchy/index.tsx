import { useState, useEffect } from 'react';
import { useSceneStore } from '../../store/sceneStore';
import { usePlanogramStore } from '../../store/planogramStore';
import { useCatalogStore } from '../../store/catalogStore';
import { cadApi } from '../../api/cad';
import type { FurnitureInstance, FaceId, FurnitureDefinition, Planogram, PlanogramCell } from '../../types/cad';

const FURNITURE_EMOJI: Record<string, string> = {
  gondola_single:    '📦',
  gondola_double:    '📦',
  fridge:            '❄️',
  fridge_horizontal: '❄️',
  register:          '🏧',
  wall:              '🧱',
  floor_grid:        '⬛',
};

// Face display names — centralised here so they can be replaced with a
// translations map (i18n) without touching component logic.
const FACE_LABELS: Record<FaceId, string> = {
  front:  'Face avant',
  back:   'Face arrière',
  left:   'Face gauche',
  right:  'Face droite',
  top:    'Face haute',
  bottom: 'Face basse',
};

/** Default number of shelf rows when auto-creating a planogram. */
const DEFAULT_PLANOGRAM_ROWS = 3;
/** Default planogram column width in cm (used to compute column count from furniture width). */
const DEFAULT_COLUMN_WIDTH_CM = 40;

function getEmoji(type: string): string {
  return FURNITURE_EMOJI[type] ?? '📦';
}

interface SceneHierarchyProps {
  projectId: string | null;
  onOpenPlanogram: (planogramId: string) => void;
}

interface FurnitureRowProps {
  furniture: FurnitureInstance;
  isSelected: boolean;
  onSelect: () => void;
  onOpenPlanogram: (id: string) => void;
  onToggleVisible: () => void;
  onDelete: () => void;
  planogramNames: Map<string, string>;
}

function FurnitureRow({
  furniture,
  isSelected,
  onSelect,
  onOpenPlanogram,
  onToggleVisible,
  onDelete,
  planogramNames,
}: FurnitureRowProps) {
  const [expanded, setExpanded] = useState(false);

  const faceEntries = (Object.entries(furniture.faces) as [FaceId, string | null][])
    .filter(([, pid]) => pid != null && pid !== '');

  const hasChildren = faceEntries.length > 0;

  return (
    <div>
      {/* Furniture row */}
      <div
        className={[
          'flex items-center gap-1 px-2 py-1 text-xs cursor-pointer group rounded transition-colors',
          isSelected
            ? 'bg-blue-600/25 text-blue-300'
            : 'text-gray-300 hover:bg-gray-800',
        ].join(' ')}
        onClick={onSelect}
      >
        {/* Expand toggle */}
        <button
          className="w-4 text-gray-500 hover:text-gray-300 shrink-0"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        >
          {hasChildren ? (expanded ? '▾' : '▸') : ' '}
        </button>

        <span className="shrink-0">{getEmoji(furniture.type)}</span>
        <span className="flex-1 truncate">{furniture.name}</span>

        {/* Mounted / flat indicator */}
        {furniture.mounted === false ? (
          <span className="text-amber-500 shrink-0 text-xs" title="À plat — non monté en 3D">▭</span>
        ) : (
          <span className="text-blue-500 shrink-0 text-xs" title="Monté en 3D">🏗</span>
        )}

        {/* Lock icon */}
        {furniture.locked && (
          <span className="text-gray-500 shrink-0">🔒</span>
        )}

        {/* Visibility toggle */}
        <button
          className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 shrink-0 transition-opacity"
          title="Toggle visibility"
          onClick={(e) => { e.stopPropagation(); onToggleVisible(); }}
        >
          {furniture.visible ? '👁' : '🚫'}
        </button>

        {/* Delete button */}
        {!furniture.locked && (
          <button
            className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 shrink-0 transition-opacity text-xs leading-none px-0.5"
            title="Supprimer le meuble"
            aria-label="Supprimer le meuble"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            🗑
          </button>
        )}
      </div>

      {/* Face sub-rows */}
      {expanded && faceEntries.map(([faceId, planogramId]) => (
        <div
          key={faceId}
          className="flex items-center gap-1 px-2 py-0.5 pl-8 text-xs cursor-pointer text-gray-400 hover:bg-gray-800 rounded transition-colors"
          onClick={() => onOpenPlanogram(planogramId!)}
          title={`Open planogram: ${planogramId}`}
        >
          <span className="shrink-0">🗂️</span>
          <span className="flex-1 truncate">
            {FACE_LABELS[faceId]}
          </span>
          <span className="text-gray-600 truncate max-w-24">
            {planogramNames.get(planogramId!) ?? planogramId}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function SceneHierarchy({ projectId, onOpenPlanogram }: SceneHierarchyProps) {
  const { scene, selectedFurnitureId, selectFurniture, updateFurniture, addFurniture, removeFurniture } =
    useSceneStore();
  const { planograms, setPlanograms, setPlanogramDetail } = usePlanogramStore();
  const catalogProducts = useCatalogStore((s) => s.products);

  const [showAddMenu, setShowAddMenu] = useState(false);
  const [library, setLibrary] = useState<FurnitureDefinition[]>([]);
  const [addLoading, setAddLoading] = useState(false);

  // Pre-build planogram name map
  const planogramNames = new Map<string, string>(
    planograms.map((p) => [p.id, p.name]),
  );

  useEffect(() => {
    cadApi
      .getFurnitureLibrary()
      .then(({ furniture }) => setLibrary(furniture))
      .catch(() => setLibrary([]));
  }, []);

  const handleToggleVisible = (furniture: FurnitureInstance) => {
    const updated = { ...furniture, visible: !furniture.visible };
    updateFurniture(updated);
    if (projectId) {
      cadApi.updateFurniture(projectId, furniture.id, updated).catch(console.error);
    }
  };

  const handleDelete = (furniture: FurnitureInstance) => {
    if (furniture.locked) return;
    removeFurniture(furniture.id);
    if (projectId) {
      cadApi.deleteFurniture(projectId, furniture.id).catch(console.error);
    }
  };

  const handleAddFurniture = async (def: FurnitureDefinition) => {
    if (!projectId || !scene) return;
    setAddLoading(true);
    const newFurniture: FurnitureInstance = {
      id:         crypto.randomUUID(),
      name:       def.name,
      type:       def.type,
      libraryId:  def.id,
      position:   [200, 0, 200],
      rotation:   [0, 0, 0],
      dimensions: { ...def.defaultDimensions },
      materialId: def.defaultMaterial,
      visible:    true,
      locked:     false,
      mounted:    false,
      parentId:   null,
      childIds:   [],
      faces:      {},
    };

    try {
      const created = await cadApi.addFurniture(projectId, newFurniture);

      if ((def.hasFaces ?? []).length > 0) {
        try {
          // Sequential creation avoids a read-modify-write race condition on
          // planograms.json: FastAPI runs sync handlers in a thread pool, so
          // concurrent POST /planograms requests can overwrite each other's file.
          const createdPlanograms: [string, string][] = [];
          for (const faceId of def.hasFaces) {
            // left/right faces span the gondola's depth; all other faces
            // (front, back, top, bottom) span the gondola's width.
            const isLeftRight = faceId === 'left' || faceId === 'right';
            const widthCm = isLeftRight
              ? created.dimensions.depth
              : created.dimensions.width;
            // top/bottom faces have their "height" equal to the gondola's depth
            // (how far back the shelf goes); vertical faces use the gondola height.
            const heightCm = faceId === 'top' || faceId === 'bottom'
              ? created.dimensions.depth
              : created.dimensions.height;
            const rows = DEFAULT_PLANOGRAM_ROWS;
            const cols = Math.max(1, Math.floor(widthCm / DEFAULT_COLUMN_WIDTH_CM));

            const cells: PlanogramCell[] = catalogProducts.length > 0
              ? Array.from({ length: rows * cols }, (_, idx) => ({
                  id: crypto.randomUUID(),
                  ean: catalogProducts[idx % catalogProducts.length].ean,
                  row: Math.floor(idx / cols),
                  col: idx % cols,
                  rotation: 0 as const,
                }))
              : [];

            const planogram: Planogram = {
              id: crypto.randomUUID(),
              name: `${def.name} - ${FACE_LABELS[faceId]}`,
              furnitureId: created.id,
              face: faceId,
              rows,
              cols,
              widthCm,
              heightCm,
              cells,
            };
            const createdPlanogram = await cadApi.createPlanogram(projectId, planogram);
            setPlanogramDetail(createdPlanogram);
            createdPlanograms.push([faceId, createdPlanogram.id]);
          }

          const updatedFurniture = {
            ...created,
            faces: Object.fromEntries(createdPlanograms),
          };
          const persistedFurniture = await cadApi.updateFurniture(projectId, created.id, updatedFurniture);
          addFurniture(persistedFurniture);

          const refreshed = await cadApi.listPlanograms(projectId);
          setPlanograms(refreshed.planograms);
        } catch (err) {
          console.error('Failed to auto-create planograms for furniture:', err);
          addFurniture(created);
        }
      } else {
        addFurniture(created);
      }
    } catch {
      addFurniture(newFurniture);
    } finally {
      setAddLoading(false);
      setShowAddMenu(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center px-3 py-2 border-b border-gray-800 shrink-0">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex-1">
          Scene
        </span>
        <span className="text-xs text-gray-600">
          {scene?.furniture.length ?? 0} items
        </span>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-1">
        {/* Store root */}
        <div className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 font-medium">
          <span>🏪</span>
          <span>{scene?.store.name ?? 'Store'}</span>
        </div>

        {/* Furniture items */}
        {scene?.furniture.map((furniture) => (
          <div key={furniture.id} className="ml-4">
            <FurnitureRow
              furniture={furniture}
              isSelected={selectedFurnitureId === furniture.id}
              onSelect={() => selectFurniture(furniture.id)}
              onOpenPlanogram={onOpenPlanogram}
              onToggleVisible={() => handleToggleVisible(furniture)}
              onDelete={() => handleDelete(furniture)}
              planogramNames={planogramNames}
            />
          </div>
        ))}

        {(!scene || scene.furniture.length === 0) && (
          <p className="px-4 py-3 text-xs text-gray-600 italic">
            No furniture. Add some below.
          </p>
        )}
      </div>

      {/* Add Furniture */}
      <div className="border-t border-gray-800 p-2 shrink-0 relative">
        <button
          className="w-full flex items-center justify-center gap-1 py-1.5 rounded text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 border border-dashed border-gray-700 hover:border-gray-600 transition-colors"
          onClick={() => setShowAddMenu((v) => !v)}
          disabled={!projectId}
        >
          <span>＋</span>
          <span>Add Furniture</span>
          {addLoading && <span className="ml-1 animate-spin">⟳</span>}
        </button>

        {showAddMenu && library.length > 0 && (
          <div className="absolute bottom-full left-2 right-2 mb-1 bg-gray-900 border border-gray-700 rounded shadow-xl z-20 max-h-56 overflow-y-auto">
            {library.map((def) => (
              <button
                key={def.id}
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors flex items-center gap-2"
                onClick={() => { void handleAddFurniture(def); }}
              >
                <span>{getEmoji(def.type)}</span>
                <div>
                  <div>{def.name}</div>
                  <div className="text-gray-500">{def.category}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

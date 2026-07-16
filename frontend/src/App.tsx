import { useState, useEffect } from 'react';
import { cadApi } from './api/cad';
import { useSceneStore } from './store/sceneStore';
import { useCatalogStore } from './store/catalogStore';
import { usePlanogramStore } from './store/planogramStore';
import { useUIStore } from './store/uiStore';
import { SceneEditor } from './three/SceneEditor';
import Toolbar from './components/Toolbar';
import SceneHierarchy from './components/SceneHierarchy';
import CatalogPanel from './components/CatalogPanel';
import Inspector from './components/Inspector';
import PlanogramEditor from './components/PlanogramEditor';
import type { FurnitureInstance } from './types/cad';

const DEFAULT_PROJECT = 'retail_cad';

export default function App() {
  const [projectId]           = useState<string>(DEFAULT_PROJECT);
  const [projectName]         = useState<string>('Retail CAD');
  const [activePlanogramId, setActivePlanogramId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<'hierarchy' | 'catalog'>('hierarchy');

  const { setScene, selectFurniture, addFurniture, scene, selectedFurnitureId, clipboard, setClipboard } = useSceneStore();
  const { setProducts }               = useCatalogStore();
  const { setPlanograms }             = usePlanogramStore();
  const { viewMode, setViewMode }     = useUIStore();

  // ── Boot: load all project data ───────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const [sceneData, catalog, planoData] = await Promise.all([
          cadApi.getScene(projectId),
          cadApi.getCatalog(projectId),
          cadApi.listPlanograms(projectId),
        ]);
        setScene(sceneData);
        setProducts(catalog.products);
        setPlanograms(planoData.planograms);
      } catch (err) {
        console.error('Failed to load project data:', err);
      }
    };
    void load();
  }, [projectId, setScene, setProducts, setPlanograms]);

  // ── Open planogram ────────────────────────────────────────────────────────
  const openPlanogram = (planogramId: string) => {
    setActivePlanogramId(planogramId);
    setViewMode(viewMode === 'split' ? 'split' : 'planogram');
  };

  const closePlanogram = () => {
    setActivePlanogramId(null);
    setViewMode('3d');
  };

  // ── Copy-paste helpers ────────────────────────────────────────────────────
  const copySelected = () => {
    if (!selectedFurnitureId || !scene) return;
    const furniture = scene.furniture.find(f => f.id === selectedFurnitureId);
    if (!furniture) return;
    const planogramIds: Record<string, string> = {};
    for (const [face, pid] of Object.entries(furniture.faces)) {
      if (pid) planogramIds[face] = pid;
    }
    setClipboard({ furniture, planogramIds });
  };

  const pasteClipboard = async () => {
    if (!clipboard) return;
    const { furniture: src } = clipboard;
    const newId = crypto.randomUUID();
    const offset = 150; // 150 cm offset

    // Build new furniture with no face links yet
    const newFurniture: FurnitureInstance = {
      ...src,
      id: newId,
      name: `${src.name} (copie)`,
      position: [src.position[0] + offset, src.position[1], src.position[2] + offset] as [number, number, number],
      faces: Object.fromEntries(Object.keys(src.faces).map(face => [face, null])),
      childIds: [],
      parentId: null,
    };

    try {
      const created = await cadApi.addFurniture(projectId, newFurniture);

      // Clone each associated planogram
      for (const [faceId, planogramId] of Object.entries(clipboard.planogramIds)) {
        try {
          const srcPlanogram = await cadApi.getPlanogram(projectId, planogramId);
          const newPlanogram = {
            ...srcPlanogram,
            id: crypto.randomUUID(),
            name: `${srcPlanogram.name} (copie)`,
            furnitureId: newId,
            cells: srcPlanogram.cells.map(cell => ({ ...cell, id: crypto.randomUUID() })),
          };
          const createdPlanogram = await cadApi.createPlanogram(projectId, newPlanogram);
          (created.faces as Record<string, string | null>)[faceId] = createdPlanogram.id;
        } catch (err) {
          console.error('Failed to clone planogram:', err);
        }
      }

      // Persist face links on the furniture
      await cadApi.updateFurniture(projectId, created.id, created);
      addFurniture(created);
      selectFurniture(created.id);

      // Refresh planogram list
      const planoData = await cadApi.listPlanograms(projectId);
      setPlanograms(planoData.planograms);
    } catch (err) {
      console.error('Paste failed:', err);
    }
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when inside an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        selectFurniture(null);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        copySelected();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        void pasteClipboard();
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFurnitureId, scene, clipboard]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      {/* Top toolbar */}
      <Toolbar projectName={projectName} />

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left panel (260px) ───────────────────────────────────────── */}
        <div className="w-64 shrink-0 border-r border-gray-800 bg-gray-900 flex flex-col overflow-hidden">
          {/* Tab switcher */}
          <div className="flex shrink-0 border-b border-gray-800">
            <button
              className={[
                'flex-1 py-1.5 text-xs font-medium transition-colors',
                leftTab === 'hierarchy'
                  ? 'text-blue-400 border-b-2 border-blue-400'
                  : 'text-gray-500 hover:text-gray-300',
              ].join(' ')}
              onClick={() => setLeftTab('hierarchy')}
            >
              Scene
            </button>
            <button
              className={[
                'flex-1 py-1.5 text-xs font-medium transition-colors',
                leftTab === 'catalog'
                  ? 'text-blue-400 border-b-2 border-blue-400'
                  : 'text-gray-500 hover:text-gray-300',
              ].join(' ')}
              onClick={() => setLeftTab('catalog')}
            >
              Catalog
            </button>
          </div>

          <div className="flex-1 overflow-hidden">
            {leftTab === 'hierarchy' ? (
              <SceneHierarchy
                projectId={projectId}
                onOpenPlanogram={openPlanogram}
              />
            ) : (
              <CatalogPanel projectId={projectId} />
            )}
          </div>
        </div>

        {/* ── Main viewport ──────────────────────────────────────────────── */}
        <main className="flex-1 relative overflow-hidden">
          {viewMode === '3d' && (
            <SceneEditor projectId={projectId} />
          )}

          {viewMode === 'planogram' && (
            activePlanogramId ? (
              <PlanogramEditor
                projectId={projectId}
                planogramId={activePlanogramId}
                onClose={closePlanogram}
              />
            ) : (
              <div className="flex flex-col items-center justify-center w-full h-full gap-3">
                <span className="text-4xl">🗂️</span>
                <p className="text-gray-500 text-sm">
                  Click a planogram face in the Scene panel to open it
                </p>
                <button
                  className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2"
                  onClick={() => setViewMode('3d')}
                >
                  ← Back to 3D view
                </button>
              </div>
            )
          )}

          {viewMode === 'split' && (
            <div className="flex h-full">
              <div className="flex-1 border-r border-gray-800">
                <SceneEditor projectId={projectId} />
              </div>
              <div className="flex-1">
                {activePlanogramId ? (
                  <PlanogramEditor
                    projectId={projectId}
                    planogramId={activePlanogramId}
                    onClose={closePlanogram}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-gray-600 text-sm">
                      Select a planogram face to edit
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {/* ── Right panel (280px) ──────────────────────────────────────── */}
        <aside className="w-72 shrink-0 border-l border-gray-800 bg-gray-900 overflow-y-auto">
          <Inspector
            projectId={projectId}
            onOpenPlanogram={openPlanogram}
          />
        </aside>
      </div>
    </div>
  );
}

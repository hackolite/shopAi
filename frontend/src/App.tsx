import { useState, useEffect, useCallback, useRef } from 'react';
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
import { useZoneStore } from './store/zoneStore';
import type { FurnitureInstance } from './types/cad';

const DEFAULT_PROJECT = 'retail_cad';
/** Offset in cm applied to X and Z when pasting a copied gondola. */
const PASTE_OFFSET_CM = 150;

export default function App() {
  const [projectId, setProjectId]     = useState<string>(DEFAULT_PROJECT);
  const [projectName, setProjectName] = useState<string>('Retail CAD');
  const [projects, setProjects]       = useState<{ id: string; name: string }[]>([]);
  const [activePlanogramId, setActivePlanogramId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<'hierarchy' | 'catalog'>('hierarchy');
  const [saveStatus, setSaveStatus]   = useState<'idle' | 'saving' | 'saved'>('idle');
  const importInputRef = useRef<HTMLInputElement>(null);

  const { setScene, selectFurniture, addFurniture, removeFurniture, scene, selectedFurnitureId, clipboard, setClipboard, undo } = useSceneStore();
  const { setProducts }               = useCatalogStore();
  const { setPlanograms, setPlanogramDetail, planogramDetails, requestOpenPlanogramId, setRequestOpenPlanogramId } = usePlanogramStore();
  const { viewMode, setViewMode, setActiveTool } = useUIStore();
  const { setZones } = useZoneStore();

  // ── Load project list ─────────────────────────────────────────────────────
  const refreshProjectList = useCallback(async () => {
    try {
      const data = await cadApi.listProjects();
      setProjects(data.projects ?? []);
    } catch (err) {
      console.error('Failed to load project list:', err);
    }
  }, []);

  useEffect(() => { void refreshProjectList(); }, [refreshProjectList]);

  // ── Load all data for a project ───────────────────────────────────────────
  const loadProjectData = useCallback(async (id: string) => {
    try {
      const [sceneData, catalog, planoData, meta] = await Promise.all([
        cadApi.getScene(id),
        cadApi.getCatalog(id),
        cadApi.listPlanograms(id),
        cadApi.getProject(id),
      ]);
      setScene(sceneData);
      setProducts(catalog.products);
      setPlanograms(planoData.planograms);
      setZones(sceneData.store.zones ?? []);
      setProjectName(meta.name ?? id);

      await Promise.all(
        planoData.planograms.map(async (summary) => {
          try {
            const detail = await cadApi.getPlanogram(id, summary.id);
            setPlanogramDetail(detail);
          } catch (err) {
            console.warn(`Failed to load planogram detail for ${summary.id}:`, err);
          }
        }),
      );
    } catch (err) {
      console.error('Failed to load project data:', err);
    }
  }, [setScene, setProducts, setPlanograms, setPlanogramDetail, setZones]);

  // ── Boot: load default project ────────────────────────────────────────────
  useEffect(() => {
    void loadProjectData(projectId);
  }, [projectId, loadProjectData]);

  // ── Switch to a project ───────────────────────────────────────────────────
  const switchProject = useCallback((id: string) => {
    setActivePlanogramId(null);
    setProjectId(id);
  }, []);

  // ── New project ───────────────────────────────────────────────────────────
  const newProject = useCallback(async () => {
    const name = window.prompt('Nom du nouveau projet :');
    if (!name?.trim()) return;
    try {
      const created = await cadApi.createProject(name.trim());
      await refreshProjectList();
      switchProject(created.id);
    } catch (err) {
      console.error('Failed to create project:', err);
      alert('Erreur lors de la création du projet.');
    }
  }, [refreshProjectList, switchProject]);

  // ── Save As (duplicate) ───────────────────────────────────────────────────
  const saveAsProject = useCallback(async () => {
    const name = window.prompt('Nom de la copie :', `${projectName} (copie)`);
    if (!name?.trim()) return;
    try {
      const created = await cadApi.duplicateProject(projectId, name.trim());
      await refreshProjectList();
      switchProject(created.id);
    } catch (err) {
      console.error('Failed to duplicate project:', err);
      alert('Erreur lors de la duplication du projet.');
    }
  }, [projectId, projectName, refreshProjectList, switchProject]);

  // ── Manual save (show feedback) ───────────────────────────────────────────
  const saveProject = useCallback(async () => {
    setSaveStatus('saving');
    try {
      // Trigger a no-op settings round-trip to ensure backend is up-to-date
      const settings = await cadApi.getSettings(projectId);
      await cadApi.updateSettings(projectId, settings);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Save failed:', err);
      setSaveStatus('idle');
    }
  }, [projectId]);

  // ── Open planogram ────────────────────────────────────────────────────────
  const openPlanogram = (planogramId: string) => {
    setActivePlanogramId(planogramId);
    setViewMode(viewMode === 'split' ? 'split' : 'planogram');
  };

  // ── React to Ctrl+click open-planogram requests from the 3D overlay ─────────
  useEffect(() => {
    if (!requestOpenPlanogramId) return;
    setRequestOpenPlanogramId(null);
    openPlanogram(requestOpenPlanogramId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestOpenPlanogramId]);

  const closePlanogram = () => {
    setActivePlanogramId(null);
    setViewMode('3d');
  };

  // ── Copy-paste helpers ────────────────────────────────────────────────────
  const copySelected = useCallback(() => {
    if (!selectedFurnitureId || !scene) return;
    const furniture = scene.furniture.find(f => f.id === selectedFurnitureId);
    if (!furniture) return;
    const planogramIds: Record<string, string> = {};
    for (const [face, pid] of Object.entries(furniture.faces)) {
      if (pid) planogramIds[face] = pid;
    }
    setClipboard({ furniture, planogramIds });
  }, [selectedFurnitureId, scene, setClipboard]);

  const pasteClipboard = useCallback(async () => {
    if (!clipboard) return;
    const { furniture: src } = clipboard;
    const newId = crypto.randomUUID();

    const newFurniture: FurnitureInstance = {
      ...src,
      id: newId,
      name: `${src.name} (copie)`,
      position: [src.position[0] + PASTE_OFFSET_CM, src.position[1], src.position[2] + PASTE_OFFSET_CM] as [number, number, number],
      faces: Object.fromEntries(Object.keys(src.faces).map(face => [face, null])),
      childIds: [],
      parentId: null,
    };

    try {
      const created = await cadApi.addFurniture(projectId, newFurniture);

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
          setPlanogramDetail(createdPlanogram);
          (created.faces as Record<string, string | null>)[faceId] = createdPlanogram.id;
        } catch (err) {
          console.error('Failed to clone planogram:', err);
        }
      }

      await cadApi.updateFurniture(projectId, created.id, created);
      addFurniture(created);
      selectFurniture(created.id);

      const planoData = await cadApi.listPlanograms(projectId);
      setPlanograms(planoData.planograms);
    } catch (err) {
      console.error('Paste failed:', err);
    }
  }, [clipboard, projectId, addFurniture, selectFurniture, setPlanograms, setPlanogramDetail]);

  // ── Delete selected furniture ─────────────────────────────────────────────
  const deleteSelected = useCallback(() => {
    if (!selectedFurnitureId) return;
    removeFurniture(selectedFurnitureId);
    cadApi.deleteFurniture(projectId, selectedFurnitureId).catch(console.error);
  }, [selectedFurnitureId, removeFurniture, projectId]);

  // ── Export complete implementation ───────────────────────────────────────
  const exportProject = useCallback(() => {
    if (!scene) return;
    const planogramsArr = Array.from(planogramDetails.values());
    const payload = { scene, planograms: planogramsArr };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${projectName.replace(/\s+/g, '_')}_export.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [scene, planogramDetails, projectName]);

  // ── Import from JSON file ─────────────────────────────────────────────────
  const handleImportFile = useCallback(async (file: File) => {
    let text: string;
    let snapshot: object;
    try {
      text = await file.text();
      snapshot = JSON.parse(text) as object;
    } catch {
      alert('Fichier invalide : ce fichier n\'est pas un JSON valide.');
      return;
    }
    try {
      const defaultName = file.name.replace(/\.[^.]+$/, '').replace(/_export$/, '').replace(/_/g, ' ');
      const name = window.prompt('Nom du projet importé :', defaultName);
      if (!name?.trim()) return;
      const created = await cadApi.importProject(name.trim(), snapshot);
      await refreshProjectList();
      switchProject(created.id);
    } catch (err) {
      console.error('Import failed:', err);
      alert('Erreur lors de l\'importation. Vérifiez que le fichier est un export valide.');
    }
  }, [refreshProjectList, switchProject]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditable = (e.target as HTMLElement)?.isContentEditable;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || isEditable) return;

      // Ctrl/Cmd+Z → undo
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        undo();
        return;
      }

      // Ctrl/Cmd+S → save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void saveProject();
        return;
      }

      if (e.key === 'Escape') {
        selectFurniture(null);
        return;
      }

      // Tool shortcuts (no modifier)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 's' || e.key === 'S') { setActiveTool('select');    return; }
        if (e.key === 'g' || e.key === 'G') { setActiveTool('translate'); return; }
        if (e.key === 'r' || e.key === 'R') { setActiveTool('rotate');    return; }
        if (e.key === 'e' || e.key === 'E') { setActiveTool('scale');     return; }
        if (e.key === 'm' || e.key === 'M') { setActiveTool('measure');   return; }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelected();
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
  }, [selectFurniture, deleteSelected, copySelected, pasteClipboard, setActiveTool, undo, saveProject]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      {/* Hidden import file input */}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleImportFile(file);
          e.target.value = '';
        }}
      />

      {/* Top toolbar */}
      <Toolbar
        projectName={projectName}
        projects={projects}
        saveStatus={saveStatus}
        onNew={newProject}
        onLoad={switchProject}
        onSave={saveProject}
        onSaveAs={saveAsProject}
        onExport={exportProject}
        onImport={() => importInputRef.current?.click()}
      />

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

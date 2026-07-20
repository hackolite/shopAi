import { useState, useEffect, useCallback } from 'react';
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
import NameDialog from './components/NameDialog';
import ExportDialog from './components/ExportDialog';
import ImportDialog from './components/ImportDialog';
import type { ImportFormat } from './components/ImportDialog';
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

  // Dialog states
  const [nameDialog, setNameDialog] = useState<{
    title: string;
    label: string;
    defaultValue?: string;
    confirmLabel?: string;
    onConfirm: (name: string) => void;
  } | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);

  const { setScene, selectFurniture, addFurniture, removeFurniture, scene, selectedFurnitureId, selectedFurnitureIds, clipboard, setClipboard, toggleFurnitureSelection, undo } = useSceneStore();
  const { setProducts }               = useCatalogStore();
  const { setPlanograms, setPlanogramDetail, requestOpenPlanogramId, setRequestOpenPlanogramId } = usePlanogramStore();
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
  const newProject = useCallback(() => {
    setNameDialog({
      title: 'Nouveau projet',
      label: 'Nom du projet',
      defaultValue: '',
      confirmLabel: 'Créer',
      onConfirm: async (name) => {
        setNameDialog(null);
        try {
          const created = await cadApi.createProject(name);
          await refreshProjectList();
          switchProject(created.id);
        } catch (err) {
          console.error('Failed to create project:', err);
          alert('Erreur lors de la création du projet.');
        }
      },
    });
  }, [refreshProjectList, switchProject]);

  // ── Save As (duplicate) ───────────────────────────────────────────────────
  const saveAsProject = useCallback(() => {
    setNameDialog({
      title: 'Enregistrer sous…',
      label: 'Nom du projet',
      defaultValue: `${projectName} (copie)`,
      confirmLabel: 'Enregistrer',
      onConfirm: async (name) => {
        setNameDialog(null);
        try {
          const created = await cadApi.duplicateProject(projectId, name);
          await refreshProjectList();
          switchProject(created.id);
        } catch (err) {
          console.error('Failed to duplicate project:', err);
          alert('Erreur lors de la duplication du projet.');
        }
      },
    });
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
    // Returning to 3D must NOT move the camera: flying to the edited furniture
    // reframes the whole scene and makes untouched furniture (e.g. a gondola the
    // user rotated to face the scene) appear to have turned around, even though
    // its rotation is unchanged. Keep the user's current viewpoint intact.
    setActivePlanogramId(null);
    setViewMode('3d');
  };

  // ── Copy-paste helpers ────────────────────────────────────────────────────
  const copySelected = useCallback(() => {
    if (!scene) return;
    // Collect the set of IDs to copy: multi-selection if available, else single selection.
    const ids = selectedFurnitureIds.size > 0
      ? [...selectedFurnitureIds]
      : selectedFurnitureId ? [selectedFurnitureId] : [];
    if (ids.length === 0) return;
    const items = ids.flatMap(id => {
      const furniture = scene.furniture.find(f => f.id === id);
      if (!furniture) return [];
      const planogramIds: Record<string, string> = {};
      for (const [face, pid] of Object.entries(furniture.faces)) {
        if (pid) planogramIds[face] = pid;
      }
      return [{ furniture, planogramIds }];
    });
    if (items.length > 0) setClipboard({ items });
  }, [selectedFurnitureId, selectedFurnitureIds, scene, setClipboard]);

  const pasteClipboard = useCallback(async () => {
    if (!clipboard || clipboard.items.length === 0) return;

    const lastCreatedId: string[] = [];
    for (const { furniture: src, planogramIds } of clipboard.items) {
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

        for (const [faceId, planogramId] of Object.entries(planogramIds)) {
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
        lastCreatedId.push(created.id);
      } catch (err) {
        console.error('Paste failed:', err);
      }
    }

    // Select all pasted items: single item → single selection, multiple → multi-selection.
    if (lastCreatedId.length === 1) {
      selectFurniture(lastCreatedId[0]);
    } else if (lastCreatedId.length > 1) {
      // Seed multi-selection with all pasted items so the user can immediately
      // move or copy the whole group again.
      selectFurniture(null);
      for (const id of lastCreatedId) toggleFurnitureSelection(id);
    }

    const planoData = await cadApi.listPlanograms(projectId);
    setPlanograms(planoData.planograms);
  }, [clipboard, projectId, addFurniture, selectFurniture, toggleFurnitureSelection, setPlanograms, setPlanogramDetail]);

  // ── Delete selected furniture ─────────────────────────────────────────────
  const deleteSelected = useCallback(() => {
    if (!selectedFurnitureId) return;
    removeFurniture(selectedFurnitureId);
    cadApi.deleteFurniture(projectId, selectedFurnitureId).catch(console.error);
  }, [selectedFurnitureId, removeFurniture, projectId]);

  // ── Export ───────────────────────────────────────────────────────────────
  const exportProject = useCallback(() => {
    setShowExportDialog(true);
  }, []);

  const handleExportConfirm = useCallback(async (_format: 'zip') => {
    setShowExportDialog(false);
    try {
      await cadApi.exportProjectZip(projectId, projectName);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Erreur lors de l\'exportation du projet.');
    }
  }, [projectId, projectName]);

  // ── Import ────────────────────────────────────────────────────────────────
  const handleImportFile = useCallback(async (file: File, name: string, _format: ImportFormat) => {
    setShowImportDialog(false);
    try {
      const created = await cadApi.importProjectZip(name, file);
      await refreshProjectList();
      switchProject(created.id);
    } catch (err) {
      console.error('Import failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      alert(`Erreur lors de l'importation : ${detail}`);
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
      {/* Dialogs */}
      {nameDialog && (
        <NameDialog
          title={nameDialog.title}
          label={nameDialog.label}
          defaultValue={nameDialog.defaultValue}
          confirmLabel={nameDialog.confirmLabel}
          onConfirm={nameDialog.onConfirm}
          onCancel={() => setNameDialog(null)}
        />
      )}
      {showExportDialog && (
        <ExportDialog
          projectName={projectName}
          onConfirm={(fmt) => void handleExportConfirm(fmt)}
          onCancel={() => setShowExportDialog(false)}
        />
      )}
      {showImportDialog && (
        <ImportDialog
          onImport={(file, name, fmt) => void handleImportFile(file, name, fmt)}
          onCancel={() => setShowImportDialog(false)}
        />
      )}

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
        onImport={() => setShowImportDialog(true)}
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

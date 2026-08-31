import { useState, useEffect, useCallback, useRef } from 'react';
import { cadApi } from './api/cad';
import { useSceneStore } from './store/sceneStore';
import { useCatalogStore } from './store/catalogStore';
import { usePlanogramStore } from './store/planogramStore';
import { useUIStore } from './store/uiStore';
import { defaultSimulationConfig, useSimulationStore } from './store/simulationStore';
import { SceneEditor } from './three/SceneEditor';
import Toolbar from './components/Toolbar';
import SceneHierarchy from './components/SceneHierarchy';
import CatalogPanel from './components/CatalogPanel';
import Inspector from './components/Inspector';
import PlanogramEditor from './components/PlanogramEditor';
import NameDialog from './components/NameDialog';
import ExportDialog from './components/ExportDialog';
import ImportDialog from './components/ImportDialog';
import SimulationPanel from './components/SimulationPanel';
import type { ImportFormat } from './components/ImportDialog';
import type { ExportFormat } from './components/ExportDialog';
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
  const [rightTab, setRightTab] = useState<'inspector' | 'simulation'>('simulation');

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
  const { viewMode, setViewMode, setActiveTool, recording } = useUIStore();
  const { setZones, selectedZoneId } = useZoneStore();
  const setSimulationConfig = useSimulationStore((state) => state.setConfig);

  // Tracks the project ID currently being loaded; used to discard stale
  // responses when the user switches projects before a load completes.
  const loadingProjectIdRef = useRef<string | null>(null);
  const selectedWaypointId = useSimulationStore((state) => state.selectedWaypointId);
  const simulationHistoryLength = useSimulationStore((state) => state.history.length);
  const selectSimulationWaypoint = useSimulationStore((state) => state.selectWaypoint);
  const undoSimulation = useSimulationStore((state) => state.undo);

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
    // Register this load as the active one; any earlier in-flight load is now stale.
    loadingProjectIdRef.current = id;

    // Clear previous project's state immediately so stale data never bleeds into
    // the next project's view.
    setScene(null);
    setProducts([]);
    setPlanograms([]);
    setZones([]);

    try {
      const [sceneData, catalog, planoData, meta, settings] = await Promise.all([
        cadApi.getScene(id),
        cadApi.getCatalog(id),
        cadApi.listPlanograms(id),
        cadApi.getProject(id),
        cadApi.getSettings(id),
      ]);
      // Discard results if the user switched to yet another project while we awaited.
      if (loadingProjectIdRef.current !== id) return;
      setScene(sceneData);
      setProducts(catalog.products);
      setPlanograms(planoData.planograms);
      setZones(sceneData.store.zones ?? []);
      setProjectName(meta.name ?? id);
      setSimulationConfig(settings.simulation ?? defaultSimulationConfig());

      await Promise.all(
        planoData.planograms.map(async (summary) => {
          try {
            const detail = await cadApi.getPlanogram(id, summary.id);
            // Guard again — planogram fetches are the longest-running part.
            if (loadingProjectIdRef.current !== id) return;
            setPlanogramDetail(detail);
          } catch (err) {
            console.warn(`Failed to load planogram detail for ${summary.id}:`, err);
          }
        }),
      );
    } catch (err) {
      if (loadingProjectIdRef.current === id) {
        console.error('Failed to load project data:', err);
      }
    }
  }, [setScene, setProducts, setPlanograms, setPlanogramDetail, setZones, setSimulationConfig]);

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

  // ── Delete project ────────────────────────────────────────────────────────
  const deleteProject = useCallback(async (id: string) => {
    const target = projects.find((p) => p.id === id);
    const label = target?.name ?? id;
    if (!window.confirm(`Supprimer définitivement le projet « ${label} » ?`)) return;
    try {
      await cadApi.deleteProject(id);
      const data = await cadApi.listProjects();
      const remaining = data.projects ?? [];
      setProjects(remaining);
      if (id === projectId) {
        const next = remaining.find((p) => p.id === DEFAULT_PROJECT) ?? remaining[0];
        if (next) {
          switchProject(next.id);
        } else {
          // No project left — prompt the user to create a new one.
          newProject();
        }
      }
    } catch (err) {
      console.error('Failed to delete project:', err);
      alert('Erreur lors de la suppression du projet.');
    }
  }, [projects, projectId, switchProject, newProject]);

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
  const openPlanogram = useCallback((planogramId: string) => {
    setActivePlanogramId(planogramId);
    setViewMode(viewMode === 'split' ? 'split' : 'planogram');
  }, [viewMode, setViewMode]);

  // ── React to Ctrl+click open-planogram requests from the 3D overlay ─────────
  useEffect(() => {
    if (!requestOpenPlanogramId) return;
    setRequestOpenPlanogramId(null);
    openPlanogram(requestOpenPlanogramId);
  }, [requestOpenPlanogramId, openPlanogram, setRequestOpenPlanogramId]);

  const closePlanogram = useCallback(() => {
    setActivePlanogramId(null);
    setViewMode('3d');
  }, [setViewMode]);

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

  const handleExportConfirm = useCallback(async (format: ExportFormat) => {
    setShowExportDialog(false);
    try {
      if (format === 'retail-layout') {
        await cadApi.exportRetailLayout(projectId, projectName);
      } else {
        await cadApi.exportProjectZip(projectId, projectName);
      }
    } catch (err) {
      console.error('Export failed:', err);
      alert('Erreur lors de l\'exportation du projet.');
    }
  }, [projectId, projectName]);

  // ── Import ────────────────────────────────────────────────────────────────
  const handleImportFile = useCallback(async (file: File, name: string, format: ImportFormat) => {
    setShowImportDialog(false);
    try {
      let created: { id: string };
      if (format === 'retail-layout') {
        const text = await file.text();
        const layout = JSON.parse(text) as object;
        created = await cadApi.importRetailLayout(name, layout);
      } else {
        created = await cadApi.importProjectZip(name, file);
      }
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
        if (
          simulationHistoryLength > 0 &&
          (selectedWaypointId || (rightTab === 'simulation' && !selectedFurnitureId && !selectedZoneId))
        ) {
          undoSimulation();
        } else {
          undo();
        }
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
        selectSimulationWaypoint(null);
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
  }, [selectFurniture, selectSimulationWaypoint, deleteSelected, copySelected, pasteClipboard, setActiveTool, undo, undoSimulation, selectedWaypointId, selectedFurnitureId, selectedZoneId, simulationHistoryLength, rightTab, saveProject]);

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
        onDelete={(id) => { void deleteProject(id); }}
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
          {/*
            SceneEditor is ALWAYS mounted so the WebGL canvas (and any active
            MediaRecorder stream) persists across view-mode changes.
            In planogram-only mode it is placed behind the PLN panel and hidden
            with opacity:0 + pointer-events:none so the GL context stays alive.
            In split mode it occupies the left half; in 3D mode the full area.
          */}
          <div
            className={
              viewMode === 'split'
                ? 'absolute top-0 left-0 h-full border-r border-gray-800'
                : 'absolute inset-0'
            }
            style={{
              width: viewMode === 'split' ? '50%' : undefined,
              opacity: viewMode === 'planogram' ? 0 : 1,
              pointerEvents: viewMode === 'planogram' ? 'none' : 'auto',
              zIndex: viewMode === 'planogram' ? 0 : 1,
            }}
          >
            <SceneEditor projectId={projectId} />
          </div>

          {/* Planogram panel — shown on top in PLN mode, right half in split mode */}
          {(viewMode === 'planogram' || viewMode === 'split') && (
            <div
              className="absolute top-0 h-full"
              style={{
                left: viewMode === 'split' ? '50%' : 0,
                right: 0,
                zIndex: 2,
              }}
            >
              {activePlanogramId ? (
                <PlanogramEditor
                  projectId={projectId}
                  planogramId={activePlanogramId}
                  onClose={closePlanogram}
                />
              ) : (
                viewMode === 'planogram' ? (
                  <div className="flex flex-col items-center justify-center w-full h-full gap-3 bg-gray-950">
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
                ) : (
                  <div className="flex items-center justify-center h-full bg-gray-950">
                    <p className="text-gray-600 text-sm">
                      Select a planogram face to edit
                    </p>
                  </div>
                )
              )}
            </div>
          )}

          {/* Global "On Air" recording indicator — visible in all view modes */}
          {recording && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-950/90 border border-red-700 text-red-300 text-xs font-semibold select-none">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
                On Air
              </span>
            </div>
          )}
        </main>

        {/* ── Right panel (280px) ──────────────────────────────────────── */}
        <aside className="w-72 shrink-0 border-l border-gray-800 bg-gray-900 flex flex-col overflow-hidden">
          <div className="flex shrink-0 border-b border-gray-800">
            <button
              className={[
                'flex-1 py-2 text-xs font-medium transition-colors',
                rightTab === 'simulation'
                  ? 'border-b-2 border-blue-400 text-blue-400'
                  : 'text-gray-500 hover:text-gray-300',
              ].join(' ')}
              onClick={() => setRightTab('simulation')}
            >
              Simulation
            </button>
            <button
              className={[
                'flex-1 py-2 text-xs font-medium transition-colors',
                rightTab === 'inspector'
                  ? 'border-b-2 border-blue-400 text-blue-400'
                  : 'text-gray-500 hover:text-gray-300',
              ].join(' ')}
              onClick={() => setRightTab('inspector')}
            >
              Inspector
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            {/* SimulationPanel stays mounted on both tabs (hidden via CSS on the
                Inspector tab): it drives the live-simulation tick loop and its
                unmount cleanup stops the backend session, so unmounting it here
                (e.g. to inspect a selected product) froze the simulation and the
                agents could never restart. */}
            <div className={rightTab === 'simulation' ? 'h-full' : 'hidden'}>
              <SimulationPanel projectId={projectId} />
            </div>
            {rightTab === 'inspector' && (
              <Inspector
                projectId={projectId}
                onOpenPlanogram={openPlanogram}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

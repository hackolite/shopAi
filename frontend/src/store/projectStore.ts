import { create } from 'zustand';
import type { ProjectMeta } from '../types/cad';

interface ProjectState {
  projects: ProjectMeta[];
  currentProjectId: string | null;
  /**
   * ID of the project whose data (scene, zones, planograms, simulation config)
   * is currently held by the other stores.  It is `null` while a project is
   * being loaded.  Auto-save effects must compare it against the project they
   * are about to write to, otherwise the previous project's state would be
   * persisted into the newly selected project.
   */
  loadedProjectId: string | null;
  navigationPolygonCount: number | null;
  /**
   * True when the currently loaded project scene contains OSM-derived
   * building zones and should use OSM-only simulation optimisations.
   */
  osmSimulationMode: boolean;
  loading: boolean;
  setProjects: (projects: ProjectMeta[]) => void;
  setCurrentProject: (id: string) => void;
  setLoadedProjectId: (id: string | null) => void;
  setNavigationPolygonCount: (count: number | null) => void;
  setOsmSimulationMode: (enabled: boolean) => void;
  setLoading: (loading: boolean) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  currentProjectId: null,
  loadedProjectId: null,
  navigationPolygonCount: null,
  osmSimulationMode: false,
  loading: false,
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (id) => set({ currentProjectId: id }),
  setLoadedProjectId: (loadedProjectId) => set({ loadedProjectId }),
  setNavigationPolygonCount: (navigationPolygonCount) => set({ navigationPolygonCount }),
  setOsmSimulationMode: (osmSimulationMode) => set({ osmSimulationMode }),
  setLoading: (loading) => set({ loading }),
}));

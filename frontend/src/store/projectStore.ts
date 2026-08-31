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
  loading: boolean;
  setProjects: (projects: ProjectMeta[]) => void;
  setCurrentProject: (id: string) => void;
  setLoadedProjectId: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  currentProjectId: null,
  loadedProjectId: null,
  loading: false,
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (id) => set({ currentProjectId: id }),
  setLoadedProjectId: (loadedProjectId) => set({ loadedProjectId }),
  setLoading: (loading) => set({ loading }),
}));

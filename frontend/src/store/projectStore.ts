import { create } from 'zustand';
import type { ProjectMeta } from '../types/cad';

interface ProjectState {
  projects: ProjectMeta[];
  currentProjectId: string | null;
  loading: boolean;
  setProjects: (projects: ProjectMeta[]) => void;
  setCurrentProject: (id: string) => void;
  setLoading: (loading: boolean) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  currentProjectId: null,
  loading: false,
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (id) => set({ currentProjectId: id }),
  setLoading: (loading) => set({ loading }),
}));

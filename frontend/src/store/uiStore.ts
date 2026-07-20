import { create } from 'zustand';

export type ActivePanel = 'scene' | 'catalog' | 'planogram' | 'materials';
export type ActiveTool = 'select' | 'translate' | 'rotate' | 'scale' | 'measure';
export type ViewMode = '3d' | 'planogram' | 'split';

/** Persisted 3D camera viewpoint (orbit position + look-at target), in world units. */
export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

interface UIState {
  activePanel: ActivePanel;
  activeTool: ActiveTool;
  viewMode: ViewMode;
  sidebarLeft: boolean;
  sidebarRight: boolean;
  /** When set, the 3D view will fly the camera to this furniture's world position. */
  flyToFurnitureId: string | null;
  /** When set together with flyToFurnitureId, the camera will face this specific face. */
  flyToFurnitureFace: string | null;
  /**
   * Last camera viewpoint in the 3D view. Persisted here (outside the Canvas) so that
   * leaving the 3D view for the planogram editor and coming back does NOT reset the
   * camera to its default angle — which made an untouched, user-rotated gondola appear
   * to have turned around ("de dos"). Null until the user first moves the camera.
   */
  cameraPose: CameraPose | null;
  setActivePanel: (panel: ActivePanel) => void;
  setActiveTool: (tool: ActiveTool) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleSidebarLeft: () => void;
  toggleSidebarRight: () => void;
  setFlyToFurnitureId: (id: string | null, face?: string | null) => void;
  setCameraPose: (pose: CameraPose) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activePanel: 'scene',
  activeTool: 'select',
  viewMode: '3d',
  sidebarLeft: true,
  sidebarRight: true,
  flyToFurnitureId: null,
  flyToFurnitureFace: null,
  cameraPose: null,
  setActivePanel: (panel) => set({ activePanel: panel }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleSidebarLeft: () => set((state) => ({ sidebarLeft: !state.sidebarLeft })),
  toggleSidebarRight: () =>
    set((state) => ({ sidebarRight: !state.sidebarRight })),
  setFlyToFurnitureId: (id, face = null) => set({ flyToFurnitureId: id, flyToFurnitureFace: face }),
  setCameraPose: (pose) => set({ cameraPose: pose }),
}));

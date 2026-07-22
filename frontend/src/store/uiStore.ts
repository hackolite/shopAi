import { create } from 'zustand';

export type ActivePanel = 'scene' | 'catalog' | 'planogram' | 'materials';
export type ActiveTool = 'select' | 'translate' | 'rotate' | 'scale' | 'measure';
export type ViewMode = '3d' | 'planogram' | 'split' | 'floor';

interface UIState {
  activePanel: ActivePanel;
  activeTool: ActiveTool;
  viewMode: ViewMode;
  sidebarLeft: boolean;
  sidebarRight: boolean;
  /** When true, the 3D camera is locked into a top-down (bird's eye) view. */
  bevMode: boolean;
  /** When set, the 3D view will fly the camera to this furniture's world position. */
  flyToFurnitureId: string | null;
  /** When set together with flyToFurnitureId, the camera will face this specific face. */
  flyToFurnitureFace: string | null;
  /** Whether a video recording is currently in progress. Shared so other views can show indicator. */
  recording: boolean;
  setActivePanel: (panel: ActivePanel) => void;
  setActiveTool: (tool: ActiveTool) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleSidebarLeft: () => void;
  toggleSidebarRight: () => void;
  setBevMode: (v: boolean) => void;
  setFlyToFurnitureId: (id: string | null, face?: string | null) => void;
  setRecording: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activePanel: 'scene',
  activeTool: 'select',
  viewMode: '3d',
  sidebarLeft: true,
  sidebarRight: true,
  bevMode: false,
  flyToFurnitureId: null,
  flyToFurnitureFace: null,
  recording: false,
  setActivePanel: (panel) => set({ activePanel: panel }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleSidebarLeft: () => set((state) => ({ sidebarLeft: !state.sidebarLeft })),
  toggleSidebarRight: () =>
    set((state) => ({ sidebarRight: !state.sidebarRight })),
  setBevMode: (bevMode) => set({ bevMode }),
  setFlyToFurnitureId: (id, face = null) => set({ flyToFurnitureId: id, flyToFurnitureFace: face }),
  setRecording: (recording) => set({ recording }),
}));

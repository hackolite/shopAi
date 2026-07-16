import { create } from 'zustand';

export type ActivePanel = 'scene' | 'catalog' | 'planogram' | 'materials';
export type ActiveTool = 'select' | 'translate' | 'rotate' | 'scale';
export type ViewMode = '3d' | 'planogram' | 'split';

interface UIState {
  activePanel: ActivePanel;
  activeTool: ActiveTool;
  viewMode: ViewMode;
  sidebarLeft: boolean;
  sidebarRight: boolean;
  setActivePanel: (panel: ActivePanel) => void;
  setActiveTool: (tool: ActiveTool) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleSidebarLeft: () => void;
  toggleSidebarRight: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  activePanel: 'scene',
  activeTool: 'select',
  viewMode: '3d',
  sidebarLeft: true,
  sidebarRight: true,
  setActivePanel: (panel) => set({ activePanel: panel }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleSidebarLeft: () => set((state) => ({ sidebarLeft: !state.sidebarLeft })),
  toggleSidebarRight: () =>
    set((state) => ({ sidebarRight: !state.sidebarRight })),
}));

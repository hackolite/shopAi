import { create } from 'zustand';
import type { FurnitureInstance, Scene, Selection } from '../types/cad';

interface SceneState {
  scene: Scene | null;
  selectedFurnitureId: string | null;
  selection: Selection;
  expandedNodes: Set<string>;
  loading: boolean;
  setScene: (scene: Scene) => void;
  selectFurniture: (id: string | null) => void;
  setSelection: (selection: Selection) => void;
  updateFurniture: (furniture: FurnitureInstance) => void;
  addFurniture: (furniture: FurnitureInstance) => void;
  removeFurniture: (id: string) => void;
  toggleNodeExpanded: (id: string) => void;
  setLoading: (loading: boolean) => void;
}

export const useSceneStore = create<SceneState>((set) => ({
  scene: null,
  selectedFurnitureId: null,
  selection: { type: null },
  expandedNodes: new Set<string>(),
  loading: false,

  setScene: (scene) => set({ scene }),
  selectFurniture: (id) =>
    set({
      selectedFurnitureId: id,
      selection: id ? { type: 'furniture', furnitureId: id } : { type: null },
    }),
  setSelection: (selection) =>
    set({
      selection,
      selectedFurnitureId:
        selection.type === 'furniture' ? selection.furnitureId ?? null : null,
    }),
  updateFurniture: (furniture) =>
    set((state) => ({
      scene: state.scene
        ? {
            ...state.scene,
            furniture: state.scene.furniture.map((item) =>
              item.id === furniture.id ? furniture : item,
            ),
          }
        : null,
    })),
  addFurniture: (furniture) =>
    set((state) => ({
      scene: state.scene
        ? { ...state.scene, furniture: [...state.scene.furniture, furniture] }
        : null,
    })),
  removeFurniture: (id) =>
    set((state) => ({
      scene: state.scene
        ? {
            ...state.scene,
            furniture: state.scene.furniture.filter((item) => item.id !== id),
          }
        : null,
      selectedFurnitureId:
        state.selectedFurnitureId === id ? null : state.selectedFurnitureId,
      selection:
        state.selection.type === 'furniture' && state.selection.furnitureId === id
          ? { type: null }
          : state.selection,
    })),
  toggleNodeExpanded: (id) =>
    set((state) => {
      const expandedNodes = new Set(state.expandedNodes);
      if (expandedNodes.has(id)) {
        expandedNodes.delete(id);
      } else {
        expandedNodes.add(id);
      }
      return { expandedNodes };
    }),
  setLoading: (loading) => set({ loading }),
}));

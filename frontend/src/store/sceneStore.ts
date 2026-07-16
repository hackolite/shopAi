import { create } from 'zustand';
import type { FurnitureInstance, Scene, Selection, StoreConfig } from '../types/cad';

/** Maximum number of undo steps to keep in memory. */
const MAX_HISTORY = 50;

export interface FurnitureClipboard {
  furniture: FurnitureInstance;
  /** planogram IDs mapped by face name */
  planogramIds: Record<string, string>;
}

interface SceneState {
  scene: Scene | null;
  selectedFurnitureId: string | null;
  selection: Selection;
  expandedNodes: Set<string>;
  loading: boolean;
  clipboard: FurnitureClipboard | null;
  /** Undo history — snapshots of scene BEFORE each mutation. */
  history: Scene[];
  setScene: (scene: Scene) => void;
  selectFurniture: (id: string | null) => void;
  setSelection: (selection: Selection) => void;
  updateFurniture: (furniture: FurnitureInstance) => void;
  updateStore: (store: StoreConfig) => void;
  addFurniture: (furniture: FurnitureInstance) => void;
  removeFurniture: (id: string) => void;
  toggleNodeExpanded: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setClipboard: (data: FurnitureClipboard | null) => void;
  undo: () => void;
}

export const useSceneStore = create<SceneState>((set) => ({
  scene: null,
  selectedFurnitureId: null,
  selection: { type: null },
  expandedNodes: new Set<string>(),
  loading: false,
  clipboard: null,
  history: [],

  setScene: (scene) => set({ scene, history: [] }),
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
    set((state) => {
      if (!state.scene) return {};
      return {
        history: [...state.history.slice(-MAX_HISTORY + 1), state.scene],
        scene: {
          ...state.scene,
          furniture: state.scene.furniture.map((item) =>
            item.id === furniture.id ? furniture : item,
          ),
        },
      };
    }),
  updateStore: (store) =>
    set((state) => {
      if (!state.scene) return {};
      return {
        history: [...state.history.slice(-MAX_HISTORY + 1), state.scene],
        scene: { ...state.scene, store },
      };
    }),
  addFurniture: (furniture) =>
    set((state) => {
      if (!state.scene) return {};
      return {
        history: [...state.history.slice(-MAX_HISTORY + 1), state.scene],
        scene: { ...state.scene, furniture: [...state.scene.furniture, furniture] },
      };
    }),
  removeFurniture: (id) =>
    set((state) => {
      if (!state.scene) return {};
      return {
        history: [...state.history.slice(-MAX_HISTORY + 1), state.scene],
        scene: {
          ...state.scene,
          furniture: state.scene.furniture.filter((item) => item.id !== id),
        },
        selectedFurnitureId:
          state.selectedFurnitureId === id ? null : state.selectedFurnitureId,
        selection:
          state.selection.type === 'furniture' && state.selection.furnitureId === id
            ? { type: null }
            : state.selection,
      };
    }),
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
  setClipboard: (data) => set({ clipboard: data }),
  undo: () =>
    set((state) => {
      if (state.history.length === 0) return {};
      const prev = state.history[state.history.length - 1];
      return {
        scene: prev,
        history: state.history.slice(0, -1),
      };
    }),
}));

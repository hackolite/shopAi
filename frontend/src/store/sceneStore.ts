import { create } from 'zustand';
import type { FurnitureInstance, Scene, Selection, StoreConfig } from '../types/cad';
import type { Vec3 } from '../types/cad';

/** Maximum number of undo steps to keep in memory. */
const MAX_HISTORY = 50;

export interface FurnitureClipboardItem {
  furniture: FurnitureInstance;
  /** planogram IDs mapped by face name */
  planogramIds: Record<string, string>;
}

export interface FurnitureClipboard {
  items: FurnitureClipboardItem[];
}

interface SceneState {
  scene: Scene | null;
  selectedFurnitureId: string | null;
  /** Set of all currently selected furniture IDs (used for multi-selection via Ctrl+click). */
  selectedFurnitureIds: Set<string>;
  selection: Selection;
  expandedNodes: Set<string>;
  loading: boolean;
  clipboard: FurnitureClipboard | null;
  /** Undo history — snapshots of scene BEFORE each mutation. */
  history: Scene[];
  setScene: (scene: Scene) => void;
  selectFurniture: (id: string | null) => void;
  /** Toggle a furniture item in/out of the multi-selection set. */
  toggleFurnitureSelection: (id: string) => void;
  /** Clear the multi-selection set. */
  clearFurnitureMultiSelection: () => void;
  setSelection: (selection: Selection) => void;
  updateFurniture: (furniture: FurnitureInstance) => void;
  updateStore: (store: StoreConfig) => void;
  /**
   * Atomically updates the store config AND shifts all furniture whose id appears
   * in `baseFurniture` by (shiftXCm, shiftZCm) centimetres.  Used when resizing
   * the store from the left or near edge, where the origin is fixed at (0,0) so
   * all furniture must translate to preserve their layout relative to that edge.
   */
  updateStoreAndShiftFurniture: (
    store: StoreConfig,
    baseFurniture: FurnitureInstance[],
    shiftXCm: number,
    shiftZCm: number,
  ) => void;
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
  selectedFurnitureIds: new Set<string>(),
  selection: { type: null },
  expandedNodes: new Set<string>(),
  loading: false,
  clipboard: null,
  history: [],

  setScene: (scene) => set({ scene, history: [] }),
  selectFurniture: (id) =>
    set({
      selectedFurnitureId: id,
      selectedFurnitureIds: new Set<string>(),
      selection: id ? { type: 'furniture', furnitureId: id } : { type: null },
    }),
  toggleFurnitureSelection: (id) =>
    set((state) => {
      const next = new Set(state.selectedFurnitureIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // Seed with the previously single-selected item so clicking A then Ctrl+clicking B
        // produces a group {A, B}.
        if (state.selectedFurnitureId && !next.has(state.selectedFurnitureId)) {
          next.add(state.selectedFurnitureId);
        }
        next.add(id);
      }
      return {
        selectedFurnitureIds: next,
        selectedFurnitureId: next.size === 1 ? [...next][0] : null,
        selection: next.size === 1
          ? { type: 'furniture', furnitureId: [...next][0] }
          : { type: null },
      };
    }),
  clearFurnitureMultiSelection: () =>
    set({ selectedFurnitureIds: new Set<string>() }),
  setSelection: (selection) =>
    set({
      selection,
      selectedFurnitureId:
        selection.type === 'furniture' ? selection.furnitureId ?? null : null,
    }),
  updateFurniture: (furniture) =>
    set((state) => {
      if (!state.scene) return {};
      console.debug('[sceneStore.updateFurniture]', furniture.id, 'rotation:', furniture.rotation);
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
  updateStoreAndShiftFurniture: (store, baseFurniture, shiftXCm, shiftZCm) =>
    set((state) => {
      if (!state.scene) return {};
      const newHistory = [...state.history.slice(-MAX_HISTORY + 1), state.scene];
      if (shiftXCm === 0 && shiftZCm === 0) {
        return { history: newHistory, scene: { ...state.scene, store } };
      }
      const baseById = new Map<string, FurnitureInstance>(baseFurniture.map((f) => [f.id, f]));
      return {
        history: newHistory,
        scene: {
          store,
          furniture: state.scene.furniture.map((f) => {
            const base = baseById.get(f.id);
            if (!base) return f;
            return {
              ...f,
              position: [
                base.position[0] + shiftXCm,
                base.position[1],
                base.position[2] + shiftZCm,
              ] as Vec3,
            };
          }),
        },
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
      const nextIds = new Set(state.selectedFurnitureIds);
      nextIds.delete(id);
      return {
        history: [...state.history.slice(-MAX_HISTORY + 1), state.scene],
        scene: {
          ...state.scene,
          furniture: state.scene.furniture.filter((item) => item.id !== id),
        },
        selectedFurnitureId:
          state.selectedFurnitureId === id ? null : state.selectedFurnitureId,
        selectedFurnitureIds: nextIds,
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

import { create } from 'zustand';
import type {
  FaceId,
  Planogram,
  PlanogramCell,
  PlanogramSummary,
} from '../types/cad';

interface PlanogramState {
  planograms: PlanogramSummary[];
  /** Full planogram data cached by ID (loaded at startup for 3D overlays). */
  planogramDetails: Map<string, Planogram>;
  activePlanogram: Planogram | null;
  selectedCellIds: Set<string>;
  loading: boolean;
  /** When set, App.tsx will open this planogram in the editor and then clear this. */
  requestOpenPlanogramId: string | null;
  setPlanograms: (planograms: PlanogramSummary[]) => void;
  setPlanogramDetail: (planogram: Planogram) => void;
  setActivePlanogram: (planogram: Planogram | null) => void;
  openPlanogramForFurniture: (furnitureId: string, face: FaceId) => void;
  selectCell: (cellId: string, multi?: boolean) => void;
  clearCellSelection: () => void;
  updateCell: (cell: PlanogramCell) => void;
  addCell: (cell: PlanogramCell) => void;
  removeCell: (cellId: string) => void;
  setLoading: (loading: boolean) => void;
  setRequestOpenPlanogramId: (id: string | null) => void;
}

export const usePlanogramStore = create<PlanogramState>((set) => ({
  planograms: [],
  planogramDetails: new Map<string, Planogram>(),
  activePlanogram: null,
  selectedCellIds: new Set<string>(),
  loading: false,
  requestOpenPlanogramId: null,

  setPlanograms: (planograms) => set({ planograms }),
  setPlanogramDetail: (planogram) =>
    set((state) => {
      const planogramDetails = new Map(state.planogramDetails);
      planogramDetails.set(planogram.id, planogram);
      return { planogramDetails };
    }),
  setActivePlanogram: (planogram) =>
    set({ activePlanogram: planogram, selectedCellIds: new Set<string>() }),
  openPlanogramForFurniture: (_furnitureId, _face) => {
    // Implemented by the component that coordinates API calls.
  },
  selectCell: (cellId, multi = false) =>
    set((state) => {
      if (multi) {
        const selectedCellIds = new Set(state.selectedCellIds);
        if (selectedCellIds.has(cellId)) {
          selectedCellIds.delete(cellId);
        } else {
          selectedCellIds.add(cellId);
        }
        return { selectedCellIds };
      }

      return { selectedCellIds: new Set<string>([cellId]) };
    }),
  clearCellSelection: () => set({ selectedCellIds: new Set<string>() }),
  updateCell: (cell) =>
    set((state) => ({
      activePlanogram: state.activePlanogram
        ? {
            ...state.activePlanogram,
            cells: state.activePlanogram.cells.map((item) =>
              item.id === cell.id ? cell : item,
            ),
          }
        : null,
    })),
  addCell: (cell) =>
    set((state) => ({
      activePlanogram: state.activePlanogram
        ? {
            ...state.activePlanogram,
            cells: [...state.activePlanogram.cells, cell],
          }
        : null,
    })),
  removeCell: (cellId) =>
    set((state) => {
      const selectedCellIds = new Set(state.selectedCellIds);
      selectedCellIds.delete(cellId);

      return {
        activePlanogram: state.activePlanogram
          ? {
              ...state.activePlanogram,
              cells: state.activePlanogram.cells.filter((item) => item.id !== cellId),
            }
          : null,
        selectedCellIds,
      };
    }),
  setLoading: (loading) => set({ loading }),
  setRequestOpenPlanogramId: (id) => set({ requestOpenPlanogramId: id }),
}));

import { create } from 'zustand';
import type { FloorZone, ZoneType } from '../types/cad';

export type { FloorZone, ZoneType };

interface ZoneState {
  zones: FloorZone[];
  selectedZoneId: string | null;
  /** True once zones have been initialised from the backend scene. */
  zonesLoaded: boolean;
  /**
   * Add a zone of the given type.  For entrance/exit, if a zone of that type
   * already exists it is selected instead of creating a duplicate.
   * Supply zones can be added multiple times.
   *
   * @param type       'entrance' | 'exit' | 'supply'
   * @param storeWidth Store width in cm (used to centre the new zone).
   * @param storeDepth Store depth in cm (used to position the exit at the far wall).
   */
  addZone: (type: ZoneType, storeWidth: number, storeDepth: number) => void;
  removeZone: (id: string) => void;
  updateZone: (zone: FloorZone) => void;
  selectZone: (id: string | null) => void;
  /** Bulk-set zones when loading from the backend (marks zonesLoaded = true). */
  setZones: (zones: FloorZone[]) => void;
}

const DEFAULT_ZONE_WIDTH_CM = 200;
const DEFAULT_ZONE_DEPTH_CM = 100;
const DEFAULT_SUPPLY_ROWS = 3;
const DEFAULT_SUPPLY_COLS = 4;
/** Snap grid step in centimetres – matches the 1 m floor grid. */
const SNAP_GRID_CM = 100;

function snapToCm(v: number) {
  return Math.round(v / SNAP_GRID_CM) * SNAP_GRID_CM;
}

export const useZoneStore = create<ZoneState>((set, get) => ({
  zones: [],
  selectedZoneId: null,
  zonesLoaded: false,

  addZone: (type, storeWidth, storeDepth) => {
    // For entrance/exit: only one allowed — select existing if present.
    if (type !== 'supply') {
      const existing = get().zones.find((z) => z.type === type);
      if (existing) {
        set({ selectedZoneId: existing.id });
        return;
      }
    }

    const label =
      type === 'entrance' ? 'Entrée'
      : type === 'exit'   ? 'Sortie sans achat'
      :                     'Fournitures';

    const x = snapToCm(storeWidth / 2 - DEFAULT_ZONE_WIDTH_CM / 2);
    const z =
      type === 'entrance'
        ? 0
        : type === 'exit'
          ? snapToCm(Math.max(0, storeDepth - DEFAULT_ZONE_DEPTH_CM))
          : snapToCm(storeDepth / 2 - DEFAULT_ZONE_DEPTH_CM / 2);

    const zone: FloorZone = {
      id: crypto.randomUUID(),
      type,
      label,
      x,
      z,
      width: DEFAULT_ZONE_WIDTH_CM,
      depth: DEFAULT_ZONE_DEPTH_CM,
      ...(type === 'supply' ? { rows: DEFAULT_SUPPLY_ROWS, cols: DEFAULT_SUPPLY_COLS } : {}),
    };

    set((state) => ({ zones: [...state.zones, zone], selectedZoneId: zone.id }));
  },

  removeZone: (id) =>
    set((state) => ({
      zones: state.zones.filter((z) => z.id !== id),
      selectedZoneId: state.selectedZoneId === id ? null : state.selectedZoneId,
    })),

  updateZone: (zone) =>
    set((state) => ({
      zones: state.zones.map((z) => (z.id === zone.id ? zone : z)),
    })),

  selectZone: (id) => set({ selectedZoneId: id }),

  setZones: (zones) => set({ zones, zonesLoaded: true }),
}));

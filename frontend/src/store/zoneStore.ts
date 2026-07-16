import { create } from 'zustand';

export type ZoneType = 'entrance' | 'exit';

export interface FloorZone {
  id: string;
  type: ZoneType;
  /** Display label (e.g. "Entrée" or "Sortie sans achat"). */
  label: string;
  /** X position of the zone's bottom-left corner, in centimetres. */
  x: number;
  /** Z position of the zone's bottom-left corner, in centimetres. */
  z: number;
  /** Zone width in centimetres. */
  width: number;
  /** Zone depth in centimetres. */
  depth: number;
}

interface ZoneState {
  zones: FloorZone[];
  selectedZoneId: string | null;
  /**
   * Add a zone of the given type.  If a zone of that type already exists it is
   * selected instead of creating a duplicate.
   *
   * @param type       'entrance' | 'exit'
   * @param storeWidth Store width in cm (used to centre the new zone).
   * @param storeDepth Store depth in cm (used to position the exit at the far wall).
   */
  addZone: (type: ZoneType, storeWidth: number, storeDepth: number) => void;
  removeZone: (id: string) => void;
  updateZone: (zone: FloorZone) => void;
  selectZone: (id: string | null) => void;
}

const DEFAULT_ZONE_WIDTH_CM = 200;
const DEFAULT_ZONE_DEPTH_CM = 100;
/** Snap grid step in centimetres – matches the 1 m floor grid. */
const SNAP_GRID_CM = 100;

function snapToCm(v: number) {
  return Math.round(v / SNAP_GRID_CM) * SNAP_GRID_CM;
}

export const useZoneStore = create<ZoneState>((set, get) => ({
  zones: [],
  selectedZoneId: null,

  addZone: (type, storeWidth, storeDepth) => {
    // If a zone of this type already exists, just select it.
    const existing = get().zones.find((z) => z.type === type);
    if (existing) {
      set({ selectedZoneId: existing.id });
      return;
    }

    const label = type === 'entrance' ? 'Entrée' : 'Sortie sans achat';
    const x = snapToCm(storeWidth / 2 - DEFAULT_ZONE_WIDTH_CM / 2);
    const z =
      type === 'entrance'
        ? 0
        : snapToCm(Math.max(0, storeDepth - DEFAULT_ZONE_DEPTH_CM));

    const zone: FloorZone = {
      id: crypto.randomUUID(),
      type,
      label,
      x,
      z,
      width: DEFAULT_ZONE_WIDTH_CM,
      depth: DEFAULT_ZONE_DEPTH_CM,
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
}));

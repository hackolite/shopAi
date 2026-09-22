import { create } from 'zustand';
import { floorZoneValidationError } from '../engine/floorZones';
import type { FloorZone, FloorZonePoint, ZonePathMode, ZoneShape, ZoneType } from '../types/cad';

export type { FloorZone, FloorZonePoint, ZoneShape, ZoneType };

interface AddZoneOptions {
  shape?: ZoneShape;
  color?: string;
  label?: string;
  points?: FloorZonePoint[];
  pathMode?: ZonePathMode;
  mounted?: boolean;
  heightCm?: number;
}

interface PolygonDraft {
  mode: 'polygon' | 'freehand';
  color: string;
  points: FloorZonePoint[];
  pathMode: ZonePathMode;
}

interface ZoneState {
  zones: FloorZone[];
  selectedZoneId: string | null;
  polygonDraft: PolygonDraft | null;
  polygonDraftError: string | null;
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
  addZone: (type: ZoneType, storeWidth: number, storeDepth: number, options?: AddZoneOptions) => void;
  removeZone: (id: string) => void;
  updateZone: (zone: FloorZone) => void;
  selectZone: (id: string | null) => void;
  startPolygonDrawing: (mode?: PolygonDraft['mode'], color?: string, pathMode?: ZonePathMode) => void;
  appendPolygonPoint: (point: FloorZonePoint) => void;
  removeLastPolygonPoint: () => void;
  finishPolygonDrawing: (store?: { width: number; depth: number; x?: number; z?: number }) => boolean;
  cancelPolygonDrawing: () => void;
  /** Bulk-set zones when loading from the backend (marks zonesLoaded = true). */
  setZones: (zones: FloorZone[]) => void;
  /** Clears zones and marks them as not loaded. Called when switching project. */
  reset: () => void;
}

const DEFAULT_ZONE_WIDTH_CM = 200;
const DEFAULT_ZONE_DEPTH_CM = 100;
const DEFAULT_SUPPLY_ROWS = 3;
const DEFAULT_SUPPLY_COLS = 4;
const DEFAULT_FORBIDDEN_COLOR = '#ef4444';
const DEFAULT_ZONE_HEIGHT_CM = 120;
/** Snap grid step in centimetres – matches the 1 m floor grid. */
const SNAP_GRID_CM = 100;

function snapToCm(v: number) {
  return Math.round(v / SNAP_GRID_CM) * SNAP_GRID_CM;
}

function polygonBounds(points: FloorZonePoint[]) {
  const xs = points.map((point) => point.x);
  const zs = points.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  return {
    x: minX,
    z: minZ,
    width: Math.max(DEFAULT_ZONE_WIDTH_CM / 2, maxX - minX),
    depth: Math.max(DEFAULT_ZONE_DEPTH_CM / 2, maxZ - minZ),
  };
}

function defaultLabel(type: ZoneType, shape: ZoneShape) {
  if (type === 'entrance') return 'Entrée';
  if (type === 'exit') return 'Sortie sans achat';
  if (type === 'supply') return 'Fournitures';
  if (shape === 'circle') return 'Zone interdite ronde';
  if (shape === 'diamond') return 'Zone interdite losange';
  if (shape === 'polygon') return 'Zone interdite libre';
  return 'Zone interdite';
}

function buildZone(
  type: ZoneType,
  storeWidth: number | undefined,
  storeDepth: number | undefined,
  options?: AddZoneOptions,
): FloorZone {
  const shape = options?.shape ?? 'rectangle';
  const points = options?.points
    ? options.points.map((point) => ({ x: point.x, z: point.z, corner: point.corner }))
    : undefined;
  const polygonBox = points && points.length >= 3 ? polygonBounds(points) : null;
  const safeStoreWidth = storeWidth ?? DEFAULT_ZONE_WIDTH_CM * 2;
  const safeStoreDepth = storeDepth ?? DEFAULT_ZONE_DEPTH_CM * 2;
  const x = polygonBox?.x ?? snapToCm(safeStoreWidth / 2 - DEFAULT_ZONE_WIDTH_CM / 2);
  const z = polygonBox?.z ?? (
    type === 'entrance'
      ? 0
      : type === 'exit'
        ? snapToCm(Math.max(0, safeStoreDepth - DEFAULT_ZONE_DEPTH_CM))
        : snapToCm(safeStoreDepth / 2 - DEFAULT_ZONE_DEPTH_CM / 2)
  );
  return {
    id: crypto.randomUUID(),
    type,
    label: options?.label ?? defaultLabel(type, shape),
    x,
    z,
    width: polygonBox?.width ?? DEFAULT_ZONE_WIDTH_CM,
    depth: polygonBox?.depth ?? DEFAULT_ZONE_DEPTH_CM,
    rotationDeg: 0,
    shape,
    color: options?.color ?? (type === 'forbidden' ? DEFAULT_FORBIDDEN_COLOR : undefined),
    points,
    pathMode: options?.pathMode ?? (shape === 'polygon' ? 'linear' : undefined),
    mounted: options?.mounted ?? false,
    heightCm: options?.heightCm ?? DEFAULT_ZONE_HEIGHT_CM,
    ...(type === 'supply' ? { rows: DEFAULT_SUPPLY_ROWS, cols: DEFAULT_SUPPLY_COLS } : {}),
  };
}

export const useZoneStore = create<ZoneState>((set, get) => ({
  zones: [],
  selectedZoneId: null,
  polygonDraft: null,
  polygonDraftError: null,
  zonesLoaded: false,

  addZone: (type, storeWidth, storeDepth, options) => {
    const shape = options?.shape ?? 'rectangle';
    // For entrance/exit: only one allowed — select existing if present.
    if (type === 'entrance' || type === 'exit') {
      const existing = get().zones.find((z) => z.type === type);
      if (existing) {
        set({ selectedZoneId: existing.id });
        return;
      }
    }
    const zone = buildZone(type, storeWidth, storeDepth, { ...options, shape });

    set((state) => ({
      zones: [...state.zones, zone],
      selectedZoneId: zone.id,
      polygonDraft: null,
      polygonDraftError: null,
    }));
  },

  removeZone: (id) =>
    set((state) => ({
      zones: state.zones.filter((z) => z.id !== id),
      selectedZoneId: state.selectedZoneId === id ? null : state.selectedZoneId,
    })),

  updateZone: (zone) =>
    set((state) => ({
      zones: state.zones.map((z) => (z.id === zone.id ? {
        ...zone,
        mounted: zone.mounted ?? false,
        heightCm: zone.heightCm ?? DEFAULT_ZONE_HEIGHT_CM,
        pathMode: zone.pathMode ?? (zone.shape === 'polygon' ? 'linear' : undefined),
      } : z)),
    })),

  selectZone: (id) => set({ selectedZoneId: id }),

  startPolygonDrawing: (mode = 'polygon', color = DEFAULT_FORBIDDEN_COLOR, pathMode) => set({
    polygonDraft: { mode, color, points: [], pathMode: pathMode ?? (mode === 'freehand' ? 'smooth' : 'linear') },
    selectedZoneId: null,
    polygonDraftError: null,
  }),

  appendPolygonPoint: (point) => set((state) => ({
    polygonDraft: state.polygonDraft
      ? {
          ...state.polygonDraft,
          points: (() => {
            const snapped = { x: snapToCm(point.x), z: snapToCm(point.z) };
            const last = state.polygonDraft?.points[state.polygonDraft.points.length - 1];
            return last && last.x === snapped.x && last.z === snapped.z
              ? state.polygonDraft.points
              : [...state.polygonDraft.points, snapped];
          })(),
        }
      : state.polygonDraft,
    polygonDraftError: null,
  })),

  removeLastPolygonPoint: () => set((state) => ({
    polygonDraft: state.polygonDraft
      ? { ...state.polygonDraft, points: state.polygonDraft.points.slice(0, -1) }
      : null,
    polygonDraftError: null,
  })),

  finishPolygonDrawing: (store) => {
    const draft = get().polygonDraft;
    if (!draft) return false;
    const validationError = floorZoneValidationError(draft.points, {
      storeWidth: store?.width,
      storeDepth: store?.depth,
      storeX: store?.x,
      storeZ: store?.z,
      pathMode: draft.pathMode,
    });
    if (validationError) {
      set({ polygonDraftError: validationError });
      return false;
    }
    const zone = buildZone('forbidden', undefined, undefined, {
      shape: 'polygon',
      color: draft.color,
      points: draft.points,
      pathMode: draft.pathMode,
    });
    set((state) => ({
      zones: [...state.zones, zone],
      selectedZoneId: zone.id,
      polygonDraft: null,
      polygonDraftError: null,
    }));
    return true;
  },

  cancelPolygonDrawing: () => set({ polygonDraft: null, polygonDraftError: null }),

  setZones: (zones) => set({
    zones: zones.map((zone) => ({
      ...zone,
      mounted: zone.mounted ?? false,
      heightCm: zone.heightCm ?? DEFAULT_ZONE_HEIGHT_CM,
      pathMode: zone.pathMode ?? (zone.shape === 'polygon' ? 'linear' : undefined),
    })),
    zonesLoaded: true,
  }),

  reset: () => set({
    zones: [],
    selectedZoneId: null,
    polygonDraft: null,
    polygonDraftError: null,
    zonesLoaded: false,
  }),
}));

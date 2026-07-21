// ─── Geometry primitives ─────────────────────────────────────────────────────
export type Vec3 = [number, number, number];

/** Tolerance (cm) used when comparing planogram dims against gondola face dims.
 *  Avoids false-positive overflow warnings from floating-point rounding. */
export const OVERFLOW_TOLERANCE_CM = 0.5;

export interface Dimensions {
  width: number; // cm
  depth: number; // cm
  height: number; // cm
}

// ─── Face enum ────────────────────────────────────────────────────────────────
export type FaceId = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

// ─── Furniture ────────────────────────────────────────────────────────────────
export interface FurnitureInstance {
  id: string;
  name: string;
  type: string;
  libraryId: string;
  position: Vec3;
  rotation: Vec3;
  dimensions: Dimensions;
  materialId: string;
  visible: boolean;
  locked: boolean;
  /** False = furniture is placed flat on the 2D floor plan but not yet rendered in 3D.
   *  True (default) = the furniture is "mounted" and visible in the 3D scene. */
  mounted: boolean;
  parentId: string | null;
  childIds: string[];
  faces: Partial<Record<FaceId, string | null>>;
}

export interface FurnitureDefinition {
  id: string;
  type: string;
  name: string;
  category: string;
  defaultDimensions: Dimensions;
  hasFaces: FaceId[];
  defaultMaterial: string;
  description: string;
}

// ─── Floor zones ──────────────────────────────────────────────────────────────
export type ZoneType = 'entrance' | 'exit' | 'supply';

export interface FloorZone {
  id: string;
  type: ZoneType;
  label: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  /** Number of rows in the supply grid (only used when type === 'supply'). */
  rows?: number;
  /** Number of columns in the supply grid (only used when type === 'supply'). */
  cols?: number;
}

// ─── Store / Scene ────────────────────────────────────────────────────────────
export interface StoreConfig {
  id: string;
  name: string;
  /** World-space position of the store's (0,0) corner (cm). Defaults to [0,0,0]. */
  position?: Vec3;
  dimensions: { width: number; depth: number; height: number };
  floorColor: string;
  wallColor: string;
  zones?: FloorZone[];
}

export interface Scene {
  store: StoreConfig;
  furniture: FurnitureInstance[];
}

// ─── Catalog / Products ───────────────────────────────────────────────────────
export interface CADProduct {
  ean: string;
  name: string;
  brand: string;
  category: string;
  widthCm: number;
  depthCm: number;
  heightCm: number;
  weightG: number;
  imageUrl: string | null;
}

export interface Catalog {
  products: CADProduct[];
}

// ─── Planogram ────────────────────────────────────────────────────────────────
export interface PlanogramCell {
  id: string;
  ean: string;
  row: number;
  col: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface Planogram {
  id: string;
  name: string;
  furnitureId: string;
  face: FaceId;
  rows: number;
  cols: number;
  widthCm: number;
  heightCm: number;
  cells: PlanogramCell[];
  /** Per-column widths in cm. When present and length === cols, used instead of widthCm/cols. */
  colWidthsCm?: number[];
  /** Per-row heights in cm. When present and length === rows, used instead of heightCm/rows. */
  rowHeightsCm?: number[];
  /**
   * Per-cell width overrides in cm, keyed by "row-col".
   * When set, overrides colWidthsCm[col] for that specific cell only.
   */
  cellWidthOverrides?: Record<string, number>;
  /**
   * Per-cell height overrides in cm, keyed by "row-col".
   * When set, overrides rowHeightsCm[row] for that specific cell only.
   */
  cellHeightOverrides?: Record<string, number>;
  /**
   * Per-row column counts. When set for row r, that row has rowColCounts[r] cells
   * instead of the global `cols`. Extra cells (col >= cols) rely on cellWidthOverrides
   * for their width. Used when adding a cell to a single row only.
   */
  rowColCounts?: number[];
  /**
   * Column-span for merged (fused) cells, keyed by "row-col".
   * When set for a cell, that cell spans mergedSpans[key] logical columns.
   * The cell's width in cellWidthOverrides already reflects the combined width.
   * Used to restore individual cells when splitting and to compute correct pixel widths.
   */
  mergedSpans?: Record<string, number>;
  /**
   * New boundary-based internal model (§2 of the gondola engine spec).
   * When present, this is the source of truth; cells/rows/cols are derived.
   * When absent, the legacy cells model is active.
   */
  gondola?: import('./gondola').Gondola;
}

export interface PlanogramSummary {
  id: string;
  name: string;
  furnitureId: string;
  face: FaceId;
  rows: number;
  cols: number;
  cellCount: number;
  widthCm: number;
  heightCm: number;
}

// ─── Material ─────────────────────────────────────────────────────────────────
export type MaterialType =
  | 'wood'
  | 'metal'
  | 'glass'
  | 'plastic'
  | 'solid_color'
  | 'texture';

export interface Material {
  id: string;
  name: string;
  type: MaterialType;
  color: string;
  roughness: number;
  metalness: number;
  textureUrl?: string;
}

// ─── Project ──────────────────────────────────────────────────────────────────
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSettings {
  gridSize: number;
  snapEnabled: boolean;
  defaultUnitScale: number;
}

// ─── Selection ────────────────────────────────────────────────────────────────
export type SelectionType = 'furniture' | 'planogram_cell' | 'product' | null;

export interface Selection {
  type: SelectionType;
  furnitureId?: string;
  planogramId?: string;
  cellIds?: string[];
  ean?: string;
}

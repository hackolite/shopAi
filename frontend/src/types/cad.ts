// ─── Geometry primitives ─────────────────────────────────────────────────────
export type Vec3 = [number, number, number];

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

// ─── Store / Scene ────────────────────────────────────────────────────────────
export interface StoreConfig {
  id: string;
  name: string;
  dimensions: { width: number; depth: number; height: number };
  floorColor: string;
  wallColor: string;
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
}

export interface PlanogramSummary {
  id: string;
  name: string;
  furnitureId: string;
  face: FaceId;
  rows: number;
  cols: number;
  cellCount: number;
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

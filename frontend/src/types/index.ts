// ─── Store ────────────────────────────────────────────────────────────────────
export interface StoreGeometry {
  type: 'rectangle' | 'square' | 'polygon';
  width: number;
  depth: number;
  points?: [number, number][];
}

export interface Store {
  store_id: string;
  name: string;
  geometry: StoreGeometry;
  height: number;
  aisles?: Aisle[];
}

export interface Aisle {
  id: string;
  zone: string;
  x_start: number;
  x_end: number;
  z_start: number;
  z_end: number;
}

// ─── Product ──────────────────────────────────────────────────────────────────
export interface ProductDimensions {
  width: number;
  depth: number;
  height: number;
}

export interface Product {
  ean: string;
  name: string;
  category: string;
  brand: string;
  dimensions_cm: ProductDimensions;
}

// ─── Planogram ────────────────────────────────────────────────────────────────
export interface InstanceLocation {
  zone: string;
  shelf: string;
  level: number;
  x: number;
  y: number;
  z: number;
}

export interface PlanogramInstance {
  instance_id: string;
  ean: string;
  location: InstanceLocation;
  facings: number;
  dimensions_units?: { width: number; depth: number; height: number };
}

export interface Planogram {
  instances: PlanogramInstance[];
}

// ─── Voxel ────────────────────────────────────────────────────────────────────
export interface Voxel {
  instance_id: string;
  facing_index: number;
  ean: string;
  category: string;
  color: string;
  position: [number, number, number];
  size: [number, number, number];
}

// ─── EAN Search ───────────────────────────────────────────────────────────────
export interface EanOccurrence {
  instance_id: string;
  position: [number, number, number];
  shelf: string;
  level: number;
  zone: string;
  facings: number;
}

export interface AnalyticsSummary {
  total_passes: number;
  total_views: number;
  avg_attention_seconds: number | null;
  data_available: boolean;
}

export interface SearchResult {
  ean: string;
  product: Product;
  instances: EanOccurrence[];
  total_positions: number;
  total_facings: number;
  analytics_summary: AnalyticsSummary;
}

// ─── Analytics ────────────────────────────────────────────────────────────────
export interface InstanceAnalytics {
  traffic: {
    passes: number;
    views: number;
    attention_seconds: number;
  };
}

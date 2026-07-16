import type {
  CADProduct,
  Catalog,
  FurnitureDefinition,
  FurnitureInstance,
  Material,
  Planogram,
  PlanogramSummary,
  ProjectMeta,
  ProjectSettings,
  Scene,
  StoreConfig,
} from '../types/cad';

const BASE = '/api/cad/projects';
const LIB_BASE = '/api/furniture-library';

type ProjectListItem = Pick<ProjectMeta, 'id' | 'name'>;
type CreateProjectResponse = Pick<ProjectMeta, 'id'>;

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const headers = new Headers(opts?.headers);
  if (!headers.has('Content-Type') && !(opts?.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    ...opts,
    headers,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`[${response.status}] ${text}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const cadApi = {
  listProjects: () => request<{ projects: ProjectListItem[] }>(BASE),
  getProject: (id: string) => request<ProjectMeta>(`${BASE}/${id}`),
  createProject: (name: string) =>
    request<CreateProjectResponse>(BASE, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  getScene: (id: string) => request<Scene>(`${BASE}/${id}/scene`),
  updateStore: (id: string, store: StoreConfig) =>
    request<void>(`${BASE}/${id}/scene/store`, {
      method: 'PUT',
      body: JSON.stringify(store),
    }),
  addFurniture: (id: string, furniture: FurnitureInstance) =>
    request<FurnitureInstance>(`${BASE}/${id}/scene/furniture`, {
      method: 'POST',
      body: JSON.stringify(furniture),
    }),
  updateFurniture: (id: string, furnitureId: string, furniture: FurnitureInstance) =>
    request<FurnitureInstance>(`${BASE}/${id}/scene/furniture/${furnitureId}`, {
      method: 'PUT',
      body: JSON.stringify(furniture),
    }),
  deleteFurniture: (id: string, furnitureId: string) =>
    request<void>(`${BASE}/${id}/scene/furniture/${furnitureId}`, {
      method: 'DELETE',
    }),

  getCatalog: (id: string) => request<Catalog>(`${BASE}/${id}/catalog`),
  searchProducts: (id: string, query: string) =>
    request<Catalog>(
      `${BASE}/${id}/catalog/search?q=${encodeURIComponent(query)}`,
    ),
  addProduct: (id: string, product: CADProduct) =>
    request<CADProduct>(`${BASE}/${id}/catalog/products`, {
      method: 'POST',
      body: JSON.stringify(product),
    }),
  updateProduct: (id: string, ean: string, product: CADProduct) =>
    request<CADProduct>(`${BASE}/${id}/catalog/products/${ean}`, {
      method: 'PUT',
      body: JSON.stringify(product),
    }),
  deleteProduct: (id: string, ean: string) =>
    request<void>(`${BASE}/${id}/catalog/products/${ean}`, {
      method: 'DELETE',
    }),

  listPlanograms: (id: string) =>
    request<{ planograms: PlanogramSummary[] }>(`${BASE}/${id}/planograms`),
  createPlanogram: (id: string, planogram: Planogram) =>
    request<Planogram>(`${BASE}/${id}/planograms`, {
      method: 'POST',
      body: JSON.stringify(planogram),
    }),
  getPlanogram: (id: string, planogramId: string) =>
    request<Planogram>(`${BASE}/${id}/planograms/${planogramId}`),
  updatePlanogram: (id: string, planogramId: string, planogram: Planogram) =>
    request<Planogram>(`${BASE}/${id}/planograms/${planogramId}`, {
      method: 'PUT',
      body: JSON.stringify(planogram),
    }),
  deletePlanogram: (id: string, planogramId: string) =>
    request<void>(`${BASE}/${id}/planograms/${planogramId}`, {
      method: 'DELETE',
    }),

  getMaterials: (id: string) =>
    request<{ materials: Material[] }>(`${BASE}/${id}/materials`),
  addMaterial: (id: string, material: Material) =>
    request<Material>(`${BASE}/${id}/materials`, {
      method: 'POST',
      body: JSON.stringify(material),
    }),
  updateMaterial: (id: string, materialId: string, material: Material) =>
    request<Material>(`${BASE}/${id}/materials/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify(material),
    }),
  deleteMaterial: (id: string, materialId: string) =>
    request<void>(`${BASE}/${id}/materials/${materialId}`, {
      method: 'DELETE',
    }),

  getSettings: (id: string) => request<ProjectSettings>(`${BASE}/${id}/settings`),
  updateSettings: (id: string, settings: ProjectSettings) =>
    request<void>(`${BASE}/${id}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  getFurnitureLibrary: () =>
    request<{ furniture: FurnitureDefinition[] }>(LIB_BASE),
  getFurnitureDefinition: (type: string) =>
    request<FurnitureDefinition>(`${LIB_BASE}/${type}`),
};

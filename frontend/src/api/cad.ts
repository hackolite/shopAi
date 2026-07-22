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
  duplicateProject: (id: string, name: string) =>
    request<CreateProjectResponse>(`${BASE}/${id}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  importProject: (name: string, snapshot: object) =>
    request<CreateProjectResponse>(`${BASE}/import`, {
      method: 'POST',
      body: JSON.stringify({ name, snapshot }),
    }),

  importProjectZip: (name: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    return request<CreateProjectResponse>(`${BASE}/import/zip`, {
      method: 'POST',
      body: form,
    });
  },

  exportProjectZip: async (id: string, projectName: string): Promise<void> => {
    const response = await fetch(`${BASE}/${id}/export`);
    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`[${response.status}] ${text}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.replace(/\s+/g, '_')}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  },

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

  importCatalog: (id: string, products: CADProduct[], merge = false) =>
    request<{ imported: number; total: number }>(`${BASE}/${id}/catalog/import`, {
      method: 'POST',
      body: JSON.stringify({ products, merge }),
    }),

  uploadProductImage: (id: string, ean: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ ean: string; imageUrl: string }>(
      `${BASE}/${id}/catalog/products/${ean}/image`,
      { method: 'POST', body: form },
    );
  },

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

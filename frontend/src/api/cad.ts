import type {
  LiveAgentBasketResponse,
  LiveBasketsResponse,
  CADProduct,
  Catalog,
  FurnitureDefinition,
  FurnitureInstance,
  Material,
  PedestrianImportResult,
  Planogram,
  PlanogramSummary,
  ProjectMeta,
  ProjectSettings,
  Scene,
  SimulationConfig,
  LiveSimulationAnalyticsResponse,
  LiveSimulationResponse,
  SimulationResult,
  StoreConfig,
  WalkablePreview,
} from '../types/cad';

const BASE = '/api/cad/projects';
const LIB_BASE = '/api/furniture-library';

type ProjectListItem = Pick<ProjectMeta, 'id' | 'name'>;
type CreateProjectResponse = Pick<ProjectMeta, 'id'>;

export interface StudioAssistantResponse {
  message: string;
  requiresConfirmation: boolean;
  changed: boolean;
  projectId?: string;
  steps?: string[];
  confirmationToken?: string;
}

export interface LlmAssistantStatus {
  enabled: boolean;
  reachable: boolean;
  status: 'ready' | 'missing' | 'unreachable' | 'error';
  message: string;
}

export type AssistantCategory =
  | 'layout-modify'
  | 'layout-create'
  | 'assortment-modify'
  | 'assortment-full'
  | 'freestyle';

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const headers = new Headers(opts?.headers);
  if (!headers.has('Content-Type') && !(opts?.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    ...opts,
    credentials: opts?.credentials ?? 'include',
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
  askAssistant: (id: string, prompt: string, confirm = false) =>
    request<StudioAssistantResponse>(`${BASE}/${id}/assistant`, {
      method: 'POST',
      body: JSON.stringify({ prompt, confirm }),
    }),
  askLlmAssistant: (
    id: string, prompt: string, confirm = false,
    options?: { category: AssistantCategory; confirmationToken?: string },
  ) =>
    request<StudioAssistantResponse>(`${BASE}/${id}/assistant/llm`, {
      method: 'POST',
      body: JSON.stringify({ prompt, confirm, ...options }),
    }),
  getLlmAssistantStatus: (id: string) =>
    request<LlmAssistantStatus>(`${BASE}/${id}/assistant/llm/status`),
  listProjects: () => request<{ projects: ProjectListItem[] }>(BASE),
  getProject: (id: string) => request<ProjectMeta>(`${BASE}/${id}`),
  createProject: (
    name: string,
    options?: { storeLayoutId?: string; catalogId?: string; pedestrianDatasetId?: string },
  ) =>
    request<CreateProjectResponse>(BASE, {
      method: 'POST',
      body: JSON.stringify({
        name,
        storeLayoutId: options?.storeLayoutId ?? null,
        catalogId: options?.catalogId ?? null,
        pedestrianDatasetId: options?.pedestrianDatasetId ?? null,
      }),
    }),
  deleteProject: (id: string) =>
    request<{ deleted: boolean; id: string }>(`${BASE}/${id}`, {
      method: 'DELETE',
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
    const response = await fetch(`${BASE}/${id}/export`, { credentials: 'include' });
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
  saveSnapshot: (id: string, scene: Scene, simulation: SimulationConfig) =>
    request<void>(`${BASE}/${id}/snapshot`, {
      method: 'PUT',
      body: JSON.stringify({ scene, simulation }),
    }),
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

  loadTenantCatalog: (id: string, catalogId: string) =>
    request<{ imported: number; total: number }>(
      `${BASE}/${id}/catalog/load-tenant-catalog/${catalogId}`,
      { method: 'POST' },
    ),

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
  updateSettings: (id: string, settings: Partial<ProjectSettings>) =>
    request<void>(`${BASE}/${id}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  runSimulation: (id: string, scene: Scene, config: SimulationConfig) =>
    request<SimulationResult>(`${BASE}/${id}/simulation/run`, {
      method: 'POST',
      body: JSON.stringify({ scene, config }),
    }),
  startLiveSimulation: (id: string, scene: Scene, config: SimulationConfig) =>
    request<LiveSimulationResponse>(`${BASE}/${id}/simulation/live/start`, {
      method: 'POST',
      body: JSON.stringify({ scene, config }),
    }),
  getWalkablePreview: (id: string, scene: Scene, config: SimulationConfig) =>
    request<WalkablePreview>(`${BASE}/${id}/simulation/walkable-preview`, {
      method: 'POST',
      body: JSON.stringify({ scene, config }),
    }),
  tickLiveSimulation: (id: string, sessionId: string, steps = 1, includeWaypointMetrics = true, frameWindow = 20) =>
    request<LiveSimulationResponse>(`${BASE}/${id}/simulation/live/${sessionId}/tick`, {
      method: 'POST',
      body: JSON.stringify({ steps, includeWaypointMetrics, frameWindow }),
    }),
  pauseLiveSimulation: (id: string, sessionId: string) =>
    request<LiveSimulationResponse>(`${BASE}/${id}/simulation/live/${sessionId}/pause`, {
      method: 'POST',
    }),
  resumeLiveSimulation: (id: string, sessionId: string) =>
    request<LiveSimulationResponse>(`${BASE}/${id}/simulation/live/${sessionId}/resume`, {
      method: 'POST',
    }),
  updateLiveSimulation: (id: string, sessionId: string, scene: Scene, config: SimulationConfig) =>
    request<LiveSimulationResponse>(`${BASE}/${id}/simulation/live/${sessionId}/update`, {
      method: 'POST',
      body: JSON.stringify({ scene, config }),
    }),
  getLiveSimulationAnalytics: (id: string, sessionId: string, sinceSeq?: number) =>
    request<LiveSimulationAnalyticsResponse>(
      `${BASE}/${id}/simulation/live/${sessionId}/analytics${sinceSeq != null ? `?sinceSeq=${sinceSeq}` : ''}`,
    ),
  stopLiveSimulation: (id: string, sessionId: string) =>
    request<{ stopped: boolean; sessionId: string }>(`${BASE}/${id}/simulation/live/${sessionId}/stop`, {
      method: 'POST',
    }),

  importPedestrians: (id: string, file: File, datasetName?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (datasetName && datasetName.trim()) {
      form.append('datasetName', datasetName.trim());
    }
    return request<PedestrianImportResult & { datasetId?: string }>(
      `${BASE}/${id}/simulation/import-pedestrians`,
      {
        method: 'POST',
        body: form,
      },
    );
  },
  getPedestrians: (id: string) =>
    request<PedestrianImportResult>(`${BASE}/${id}/simulation/pedestrians`),
  loadPedestrianDataset: (id: string, datasetId: string) =>
    request<PedestrianImportResult>(
      `${BASE}/${id}/simulation/load-pedestrian-dataset/${encodeURIComponent(datasetId)}`,
      { method: 'POST' },
    ),
  loadPedestriansIntoLiveSimulation: (id: string, sessionId: string) =>
    request<{ sessionId: string; pedestrianCount: number }>(
      `${BASE}/${id}/simulation/live/${sessionId}/load-pedestrians`,
      { method: 'POST' },
    ),
  getLiveAgentBasket: (id: string, sessionId: string, agentId: number, sinceSeq?: number) =>
    request<LiveAgentBasketResponse>(
      `${BASE}/${id}/simulation/live/${sessionId}/agents/${agentId}/basket${sinceSeq != null ? `?sinceSeq=${sinceSeq}` : ''}`,
    ),
  listLiveAgentBaskets: (id: string, sessionId: string, sinceSeq?: number) =>
    request<LiveBasketsResponse>(
      `${BASE}/${id}/simulation/live/${sessionId}/baskets${sinceSeq != null ? `?sinceSeq=${sinceSeq}` : ''}`,
    ),

  getFurnitureLibrary: () =>
    request<{ furniture: FurnitureDefinition[] }>(LIB_BASE),
  getFurnitureDefinition: (type: string) =>
    request<FurnitureDefinition>(`${LIB_BASE}/${type}`),

  exportRetailLayout: async (id: string, projectName: string): Promise<void> => {
    const response = await fetch(`${BASE}/${id}/export/retail-layout`, { credentials: 'include' });
    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`[${response.status}] ${text}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.replace(/\s+/g, '_')}_retail_layout.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  },

  importRetailLayout: (name: string, layout: object) =>
    request<{ id: string }>(`${BASE}/import/retail-layout`, {
      method: 'POST',
      body: JSON.stringify({ name, layout }),
    }),
};

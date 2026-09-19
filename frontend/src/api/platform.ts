export interface PlatformUser {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  catalogProducts: number;
  planograms: number;
  furniture: number;
  checkoutSimulations: number;
}

export interface PlatformCatalogWorkspace {
  id: string;
  name: string;
  description: string;
  sourceProjectId: string | null;
  productCount: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformSimulationList {
  id: string;
  name: string;
  description: string;
  sourceProjectId: string | null;
  scenarioCount: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformStoreLayout {
  id: string;
  name: string;
  description: string;
  sourceProjectId: string | null;
  furnitureCount: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformPedestrianDataset {
  id: string;
  name: string;
  description: string;
  sourceProjectId: string | null;
  pedestrianCount: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformAgentRequest {
  id: string;
  provider: string;
  targetResourceType: string;
  targetResourceId: string | null;
  prompt: string;
  implementationNotes: string;
  status: string;
  createdAt: string;
}

export interface PlatformDashboard {
  user: PlatformUser;
  tenant: {
    id: string;
    name: string;
  };
  oauthProviders: PlatformOAuthProvider[];
  stats: {
    projectCount: number;
    catalogCount: number;
    simulationCount: number;
    agentRequestCount: number;
    storeLayoutCount: number;
    pedestrianDatasetCount: number;
  };
  projects: PlatformProjectSummary[];
  catalogs: PlatformCatalogWorkspace[];
  simulations: PlatformSimulationList[];
  agentRequests: PlatformAgentRequest[];
  storeLayouts: PlatformStoreLayout[];
  pedestrianDatasets: PlatformPedestrianDataset[];
}

export interface AgentApiGuide {
  name: string;
  openApiUrl: string;
  dashboardUrl: string;
  capabilityUrl: string;
  changeRequestUrl: string;
  workflowSteps: string[];
  promptPrefixes: Array<{
    prefix: string;
    description: string;
    example: string;
  }>;
  sampleRequests: Record<string, unknown>;
}

export interface PlatformOAuthProvider {
  name: string;
  configured: boolean;
  startPath: string;
}

export interface AgentCapabilityReport {
  tenantId: string;
  oauthProviders: PlatformOAuthProvider[];
  apiAutomation: AgentApiGuide;
  agentPilot: {
    script: string;
    supportsAgentGeneratedLayout: boolean;
    supportsSuppliedLayout: boolean;
    supportsStoreDimensioning: boolean;
    supportsFurniturePlacement: boolean;
    supportsCatalogImport: boolean;
    supportsProductPlacement: boolean;
    supportsAbsolutePositionVerification: boolean;
  };
  projectAudit?: {
    projectId: string;
    projectName: string;
    ok: boolean;
    issueCount: number;
    checks: {
      storeDimensions: { ok: boolean; issues: string[] };
      furnitureBounds: { ok: boolean; issues: string[] };
      planograms: { ok: boolean; issues: string[] };
      slotPositions: { ok: boolean; issues: string[] };
    };
  };
}

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

function extractDownloadName(contentDisposition: string | null, fallbackName: string): string {
  if (!contentDisposition) return fallbackName;
  const encodedMatch = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
  if (encodedMatch) {
    const encodedValue = encodedMatch[1].trim().replace(/^UTF-8''/i, '').replace(/^"(.*)"$/, '$1');
    try {
      return decodeURIComponent(encodedValue);
    } catch {
      return encodedValue || fallbackName;
    }
  }
  const quotedMatch = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch) return quotedMatch[1];
  const bareMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  return bareMatch?.[1]?.trim().replace(/^"(.*)"$/, '$1') || fallbackName;
}

function safeDownloadName(name: string, fallback: string): string {
  const safe = name.trim().replace(/[^\w-]/g, '_');
  return safe || fallback;
}

async function download(url: string, fallbackName: string): Promise<void> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`[${response.status}] ${text}`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = extractDownloadName(response.headers.get('Content-Disposition'), fallbackName);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
}

export const platformApi = {
  bootstrap: () =>
    request<{
      hasUsers: boolean;
      authProviders: string[];
      oauthProviders: PlatformOAuthProvider[];
      features: string[];
    }>('/api/platform/bootstrap'),
  getSession: () => request<{ user: PlatformUser | null }>('/api/platform/session'),
  login: (email: string, password: string) =>
    request<{ user: PlatformUser }>('/api/platform/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (name: string, email: string, password: string) =>
    request<{ user: PlatformUser }>('/api/platform/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    }),
  oauthSignIn: (provider: 'google' | 'github', email: string, name?: string) =>
    request<{ user: PlatformUser }>(`/api/platform/auth/oauth/${provider}`, {
      method: 'POST',
      body: JSON.stringify({ email, name }),
    }),
  logout: () => request<{ ok: boolean }>('/api/platform/auth/logout', { method: 'POST' }),
  getDashboard: () => request<PlatformDashboard>('/api/platform/dashboard'),
  listCatalogs: () => request<{ catalogs: PlatformCatalogWorkspace[] }>('/api/platform/catalogs'),
  getCatalog: (catalogId: string) =>
    request<PlatformCatalogWorkspace>(`/api/platform/catalogs/${encodeURIComponent(catalogId)}`),
  downloadCatalog: (catalogId: string, catalogName: string) =>
    download(
      `/api/platform/catalogs/${encodeURIComponent(catalogId)}/download`,
      `${safeDownloadName(catalogName, 'catalogue')}_catalog.json`,
    ),
  deleteCatalog: (catalogId: string) =>
    request<{ deleted: boolean; id: string }>(`/api/platform/catalogs/${encodeURIComponent(catalogId)}`, {
      method: 'DELETE',
    }),
  createCatalog: (payload: {
    name: string;
    description?: string;
    sourceProjectId?: string | null;
    productCount?: number;
    payload?: Record<string, unknown>;
  }) =>
    request<PlatformCatalogWorkspace>('/api/platform/catalogs', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  createSimulation: (payload: {
    name: string;
    description?: string;
    sourceProjectId?: string | null;
    scenarioCount?: number;
    payload?: Record<string, unknown>;
  }) =>
    request<PlatformSimulationList>('/api/platform/simulations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  listSimulations: () => request<{ simulations: PlatformSimulationList[] }>('/api/platform/simulations'),
  getSimulation: (simulationId: string) =>
    request<PlatformSimulationList>(`/api/platform/simulations/${encodeURIComponent(simulationId)}`),
  downloadSimulation: (simulationId: string, simulationName: string) =>
    download(
      `/api/platform/simulations/${encodeURIComponent(simulationId)}/download`,
      `${safeDownloadName(simulationName, 'simulation')}_simulation.json`,
    ),
  deleteSimulation: (simulationId: string) =>
    request<{ deleted: boolean; id: string }>(
      `/api/platform/simulations/${encodeURIComponent(simulationId)}`,
      {
        method: 'DELETE',
      },
    ),
  importSimulationJson: (file: File, name: string, description?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    form.append('description', description ?? '');
    return request<PlatformSimulationList>('/api/platform/simulations/import-json', {
      method: 'POST',
      body: form,
    });
  },
  importCatalogJson: (file: File, name: string, description?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    form.append('description', description ?? '');
    return request<PlatformCatalogWorkspace>('/api/platform/catalogs/import-json', {
      method: 'POST',
      body: form,
    });
  },
  createStoreLayout: (payload: {
    name: string;
    description?: string;
    sourceProjectId?: string | null;
    payload?: Record<string, unknown>;
  }) =>
    request<PlatformStoreLayout>('/api/platform/store-layouts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteStoreLayout: (layoutId: string) =>
    request<{ deleted: boolean; id: string }>(
      `/api/platform/store-layouts/${encodeURIComponent(layoutId)}`,
      { method: 'DELETE' },
    ),
  importStoreLayoutJson: (file: File, name: string, description?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    form.append('description', description ?? '');
    return request<PlatformStoreLayout>('/api/platform/store-layouts/import-json', {
      method: 'POST',
      body: form,
    });
  },
  getStoreLayout: (layoutId: string) =>
    request<PlatformStoreLayout>(`/api/platform/store-layouts/${encodeURIComponent(layoutId)}`),
  downloadStoreLayout: (layoutId: string, layoutName: string) =>
    download(
      `/api/platform/store-layouts/${encodeURIComponent(layoutId)}/download`,
      `${safeDownloadName(layoutName, 'layout')}_retail_layout.json`,
    ),
  createPedestrianDataset: (payload: {
    name: string;
    description?: string;
    sourceProjectId?: string | null;
    pedestrianCount?: number;
    payload?: Record<string, unknown>;
  }) =>
    request<PlatformPedestrianDataset>('/api/platform/pedestrian-datasets', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getPedestrianDataset: (datasetId: string) =>
    request<PlatformPedestrianDataset>(`/api/platform/pedestrian-datasets/${encodeURIComponent(datasetId)}`),
  listPedestrianDatasets: () =>
    request<{ pedestrianDatasets: PlatformPedestrianDataset[] }>('/api/platform/pedestrian-datasets'),
  downloadPedestrianDataset: (datasetId: string, datasetName: string) =>
    download(
      `/api/platform/pedestrian-datasets/${encodeURIComponent(datasetId)}/download`,
      `${safeDownloadName(datasetName, 'dataset')}_pedestrian_dataset.csv`,
    ),
  deletePedestrianDataset: (datasetId: string) =>
    request<{ deleted: boolean; id: string }>(
      `/api/platform/pedestrian-datasets/${encodeURIComponent(datasetId)}`,
      { method: 'DELETE' },
    ),
  importPedestrianDatasetCsv: (file: File, name: string, description?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    form.append('description', description ?? '');
    return request<PlatformPedestrianDataset>('/api/platform/pedestrian-datasets/import-csv', {
      method: 'POST',
      body: form,
    });
  },
  createAgentRequest: (payload: {
    provider: string;
    targetResourceType: string;
    targetResourceId?: string | null;
    prompt: string;
  }) =>
    request<PlatformAgentRequest>('/api/platform/agent-requests', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAgentGuide: () => request<AgentApiGuide>('/api/platform/agent-guide'),
  getAgentCapabilities: (projectId?: string) =>
    request<AgentCapabilityReport>(
      projectId
        ? `/api/platform/agent-capabilities?projectId=${encodeURIComponent(projectId)}`
        : '/api/platform/agent-capabilities',
    ),
};

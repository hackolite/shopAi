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
  importCatalogCsv: (file: File, name: string, description?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    form.append('description', description ?? '');
    return request<PlatformCatalogWorkspace>('/api/platform/catalogs/import-csv', {
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
  getStoreLayout: (layoutId: string) =>
    request<PlatformStoreLayout>(`/api/platform/store-layouts/${encodeURIComponent(layoutId)}`),
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

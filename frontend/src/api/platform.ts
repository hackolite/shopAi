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
  stats: {
    projectCount: number;
    catalogCount: number;
    simulationCount: number;
    agentRequestCount: number;
  };
  projects: PlatformProjectSummary[];
  catalogs: PlatformCatalogWorkspace[];
  simulations: PlatformSimulationList[];
  agentRequests: PlatformAgentRequest[];
}

export interface McpServerDescription {
  name: string;
  transport: string;
  endpoint: string;
  serverInfo: {
    name: string;
    version: string;
  };
  tools: Array<{ name: string; description: string }>;
  connectionSteps: string[];
  sampleInitialize: Record<string, unknown>;
  sampleToolsCall: Record<string, unknown>;
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
  getMcpDescription: () => request<McpServerDescription>('/api/platform/mcp'),
};

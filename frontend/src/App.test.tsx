import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import App from './App';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  bootstrap,
  getSession,
  getDashboard,
  getAgentGuide,
  getAgentCapabilities,
} = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  getSession: vi.fn(),
  getDashboard: vi.fn(),
  getAgentGuide: vi.fn(),
  getAgentCapabilities: vi.fn(),
}));

const {
  duplicateProject,
  createProject,
  deleteProject,
  exportProjectZip,
  importProjectZip,
} = vi.hoisted(() => ({
  duplicateProject: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  exportProjectZip: vi.fn(),
  importProjectZip: vi.fn(),
}));

vi.mock('./api/platform', () => ({
  platformApi: {
    bootstrap,
    getSession,
    getDashboard,
    getAgentGuide,
    getAgentCapabilities,
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    createAgentRequest: vi.fn(),
    createStoreLayout: vi.fn(),
    importStoreLayoutJson: vi.fn(),
    deleteStoreLayout: vi.fn(),
    downloadStoreLayout: vi.fn(),
    createCatalog: vi.fn(),
    importCatalogJson: vi.fn(),
    deleteCatalog: vi.fn(),
    downloadCatalog: vi.fn(),
    createSimulation: vi.fn(),
    importSimulationJson: vi.fn(),
    deleteSimulation: vi.fn(),
    downloadSimulation: vi.fn(),
    importPedestrianDatasetCsv: vi.fn(),
    deletePedestrianDataset: vi.fn(),
    downloadPedestrianDataset: vi.fn(),
  },
}));

vi.mock('./api/cad', () => ({
  cadApi: {
    duplicateProject,
    createProject,
    deleteProject,
    exportProjectZip,
    importProjectZip,
  },
}));

vi.mock('./StudioApp', () => ({
  default: () => null,
}));

vi.mock('./components/ProjectSceneThumbnail', () => ({
  default: ({ projectName }: { projectName: string }) => <div>Aperçu 3D {projectName}</div>,
}));

vi.mock('./components/NameDialog', () => ({
  default: ({ defaultValue, onConfirm, onCancel }: {
    defaultValue?: string;
    onConfirm: (name: string) => void;
    onCancel: () => void;
  }) => (
    <div>
      <span>{defaultValue}</span>
      <button type="button" onClick={() => onConfirm('Projet A clone')}>Confirmer duplication</button>
      <button type="button" onClick={onCancel}>Annuler duplication</button>
    </div>
  ),
}));

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function hasText(renderer: ReactTestRenderer, text: string): boolean {
  return renderer.root.findAll((node) => typeof node.type === 'string' && node.children.join('') === text).length > 0;
}

function makeDashboard(projectNames: string[]) {
  return {
    user: { id: 'u1', tenantId: 't1', name: 'Alice', email: 'alice@example.com', createdAt: '', updatedAt: '' },
    tenant: { id: 't1', name: 'Workspace' },
    oauthProviders: [],
    stats: {
      projectCount: projectNames.length,
      catalogCount: 0,
      simulationCount: 0,
      agentRequestCount: 0,
      storeLayoutCount: 0,
      pedestrianDatasetCount: 0,
    },
    projects: projectNames.map((name, index) => ({
      id: `p${index + 1}`,
      name,
      createdAt: '2026-09-21T10:00:00Z',
      updatedAt: '2026-09-21T12:00:00Z',
      catalogProducts: 10,
      planograms: 2,
      furniture: 4,
      checkoutSimulations: 1,
    })),
    catalogs: [],
    simulations: [],
    agentRequests: [],
    storeLayouts: [],
    pedestrianDatasets: [],
  };
}

describe('App workspace project cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrap.mockResolvedValue({ hasUsers: true, authProviders: [], oauthProviders: [], features: [] });
    getSession.mockResolvedValue({
      user: { id: 'u1', tenantId: 't1', name: 'Alice', email: 'alice@example.com', createdAt: '', updatedAt: '' },
    });
    getDashboard
      .mockResolvedValueOnce(makeDashboard(['Projet A']))
      .mockResolvedValueOnce(makeDashboard(['Projet A', 'Projet A clone']));
    getAgentGuide.mockResolvedValue({ promptPrefixes: [] });
    getAgentCapabilities.mockResolvedValue({ agentPilot: {} });
    duplicateProject.mockResolvedValue({ id: 'p2' });
  });

  it('shows the 3D preview and clones a project with a custom name', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
      await flushPromises();
      await flushPromises();
    });

    expect(renderer.root.findAllByProps({ children: 'Cloner' })).toHaveLength(1);
    expect(hasText(renderer, 'Aperçu 3D Projet A')).toBe(true);

    await act(async () => {
      renderer.root.findByProps({ children: 'Cloner' }).props.onClick();
      await flushPromises();
    });

    expect(hasText(renderer, 'Projet A (copie)')).toBe(true);

    await act(async () => {
      renderer.root.findByProps({ children: 'Confirmer duplication' }).props.onClick();
      await flushPromises();
      await flushPromises();
    });

    expect(duplicateProject).toHaveBeenCalledWith('p1', 'Projet A clone');
    expect(getDashboard).toHaveBeenCalledTimes(2);
    expect(hasText(renderer, 'Projet cloné.')).toBe(true);
    expect(hasText(renderer, 'Projet A clone')).toBe(true);
  });
});

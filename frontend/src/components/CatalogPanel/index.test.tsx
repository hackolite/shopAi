import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { CADProduct } from '../../types/cad';
import { useCatalogStore } from '../../store/catalogStore';
import CatalogPanel from './index';

const { listCatalogs, loadTenantCatalog, getCatalog } = vi.hoisted(() => ({
  listCatalogs: vi.fn(),
  loadTenantCatalog: vi.fn(),
  getCatalog: vi.fn(),
}));

vi.mock('../../api/platform', () => ({
  platformApi: {
    listCatalogs,
  },
}));

vi.mock('../../api/cad', () => ({
  cadApi: {
    loadTenantCatalog,
    getCatalog,
    uploadProductImage: vi.fn(),
  },
}));

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function makeProduct(partial: Partial<CADProduct> & Pick<CADProduct, 'ean' | 'name' | 'brand' | 'category'>): CADProduct {
  return {
    widthCm: 1,
    depthCm: 1,
    heightCm: 1,
    weightG: 1,
    imageUrl: '',
    ...partial,
  };
}

function paragraphTexts(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('p').map((node: ReactTestInstance) => node.children.join(''));
}

describe('CatalogPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCatalogStore.setState({
      products: [],
      searchQuery: '',
      filteredProducts: [],
      selectedEan: null,
      favoriteEans: new Set<string>(),
      recentlyUsedEans: [],
      loading: false,
    });
  });

  it('renders the workspace catalog select when catalogs load successfully', async () => {
    listCatalogs.mockResolvedValue({
      catalogs: [
        { id: 'cat-1', name: 'Catalogue A', productCount: 12 },
        { id: 'cat-2', name: 'Catalogue B', productCount: 8 },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CatalogPanel projectId="project-1" />);
      await flushPromises();
    });

    const select = renderer.root.findByType('select');
    const options = renderer.root.findAllByType('option');

    expect(select.props.value).toBe('');
    expect(options).toHaveLength(3);
    expect(options[1].children.join('')).toContain('Catalogue A');
    expect(options[2].children.join('')).toContain('Catalogue B');
  });

  it('shows a dedicated error when workspace catalogs cannot be loaded', async () => {
    listCatalogs.mockRejectedValue(new Error('boom'));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CatalogPanel projectId="project-1" />);
      await flushPromises();
    });

    expect(paragraphTexts(renderer)).toContain('Impossible de charger les catalogues workspace pour le moment.');
  });

  it('keeps only the latest rapid catalog selection result', async () => {
    listCatalogs.mockResolvedValue({
      catalogs: [
        { id: 'cat-1', name: 'Catalogue A', productCount: 12 },
        { id: 'cat-2', name: 'Catalogue B', productCount: 8 },
      ],
    });

    let resolveFirstLoad!: () => void;
    loadTenantCatalog.mockImplementation((_projectId: string, catalogId: string) => {
      if (catalogId === 'cat-1') {
        return new Promise<void>((resolve) => {
          resolveFirstLoad = resolve;
        });
      }
      return Promise.resolve();
    });
    getCatalog
      .mockResolvedValueOnce({
        products: [makeProduct({ ean: '222', name: 'Produit B', brand: 'B', category: 'Boissons' })],
      })
      .mockResolvedValueOnce({
        products: [makeProduct({ ean: '111', name: 'Produit A', brand: 'A', category: 'Épicerie' })],
      });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CatalogPanel projectId="project-1" />);
      await flushPromises();
    });

    const select = renderer.root.findByType('select');
    await act(async () => {
      void select.props.onChange({ target: { value: 'cat-1' } });
      void select.props.onChange({ target: { value: 'cat-2' } });
      await flushPromises();
    });

    await act(async () => {
      resolveFirstLoad();
      await flushPromises();
    });

    expect(renderer.root.findByType('select').props.value).toBe('cat-2');
    expect(useCatalogStore.getState().products).toEqual([
      makeProduct({ ean: '222', name: 'Produit B', brand: 'B', category: 'Boissons' }),
    ]);
  });

  it('restores the previous selection when applying a catalog fails', async () => {
    listCatalogs.mockResolvedValue({
      catalogs: [
        { id: 'cat-1', name: 'Catalogue A', productCount: 12 },
        { id: 'cat-2', name: 'Catalogue B', productCount: 8 },
      ],
    });
    loadTenantCatalog.mockResolvedValue(undefined);
    getCatalog.mockResolvedValue({
      products: [makeProduct({ ean: '111', name: 'Produit A', brand: 'A', category: 'Épicerie' })],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CatalogPanel projectId="project-1" />);
      await flushPromises();
    });

    await act(async () => {
      void renderer.root.findByType('select').props.onChange({ target: { value: 'cat-1' } });
      await flushPromises();
    });

    loadTenantCatalog.mockRejectedValueOnce(new Error('apply failed'));

    await act(async () => {
      void renderer.root.findByType('select').props.onChange({ target: { value: 'cat-2' } });
      await flushPromises();
    });

    expect(renderer.root.findByType('select').props.value).toBe('cat-1');
    expect(paragraphTexts(renderer)).toContain('Impossible d’appliquer ce catalogue au projet.');
  });
});

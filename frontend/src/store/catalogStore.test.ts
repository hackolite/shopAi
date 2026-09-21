import { beforeEach, describe, expect, it } from 'vitest';
import type { CADProduct } from '../types/cad';
import { useCatalogStore } from './catalogStore';

const PRODUCTS = [
  { ean: '111', name: 'Jus orange', brand: 'Alpha', category: 'Boissons' },
  { ean: '222', name: 'Pâtes', brand: 'Beta', category: 'Épicerie' },
] as CADProduct[];

describe('catalogStore', () => {
  beforeEach(() => {
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

  it('reapplies the current search when products change', () => {
    useCatalogStore.getState().setSearchQuery('jus');
    useCatalogStore.getState().setProducts(PRODUCTS);

    expect(useCatalogStore.getState().filteredProducts).toEqual([PRODUCTS[0]]);
  });

  it('clears the selected product when the new catalog no longer contains it', () => {
    useCatalogStore.getState().setProducts(PRODUCTS);
    useCatalogStore.getState().selectProduct('111');

    useCatalogStore.getState().setProducts([PRODUCTS[1]]);

    expect(useCatalogStore.getState().selectedEan).toBeNull();
  });
});

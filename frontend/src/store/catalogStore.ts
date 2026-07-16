import { create } from 'zustand';
import type { CADProduct } from '../types/cad';

interface CatalogState {
  products: CADProduct[];
  searchQuery: string;
  filteredProducts: CADProduct[];
  selectedEan: string | null;
  favoriteEans: Set<string>;
  recentlyUsedEans: string[];
  loading: boolean;
  setProducts: (products: CADProduct[]) => void;
  setSearchQuery: (query: string) => void;
  selectProduct: (ean: string | null) => void;
  toggleFavorite: (ean: string) => void;
  addRecentlyUsed: (ean: string) => void;
  setLoading: (loading: boolean) => void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  products: [],
  searchQuery: '',
  filteredProducts: [],
  selectedEan: null,
  favoriteEans: new Set<string>(),
  recentlyUsedEans: [],
  loading: false,

  setProducts: (products) => set({ products, filteredProducts: products }),
  setSearchQuery: (query) =>
    set((state) => {
      const normalizedQuery = query.trim().toLowerCase();

      return {
        searchQuery: query,
        filteredProducts: normalizedQuery
          ? state.products.filter(
              (product) =>
                product.name.toLowerCase().includes(normalizedQuery) ||
                product.brand.toLowerCase().includes(normalizedQuery) ||
                product.category.toLowerCase().includes(normalizedQuery) ||
                product.ean.includes(query.trim()),
            )
          : state.products,
      };
    }),
  selectProduct: (ean) => set({ selectedEan: ean }),
  toggleFavorite: (ean) =>
    set((state) => {
      const favoriteEans = new Set(state.favoriteEans);
      if (favoriteEans.has(ean)) {
        favoriteEans.delete(ean);
      } else {
        favoriteEans.add(ean);
      }
      return { favoriteEans };
    }),
  addRecentlyUsed: (ean) =>
    set((state) => ({
      recentlyUsedEans: [ean, ...state.recentlyUsedEans.filter((item) => item !== ean)]
        .slice(0, 20),
    })),
  setLoading: (loading) => set({ loading }),
}));

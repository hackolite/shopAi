import { useState } from 'react';
import { useCatalogStore } from '../../store/catalogStore';
import type { CADProduct } from '../../types/cad';

const CATEGORIES = ['All', 'Épicerie', 'Boissons', 'Frais', 'Hygiène', 'Bébé', 'Promotion'];

const CATEGORY_COLORS: Record<string, string> = {
  'Épicerie':  '#F5C518',
  'Boissons':  '#2196F3',
  'Frais':     '#4CAF50',
  'Hygiène':   '#9C27B0',
  'Bébé':      '#FF9800',
  'Promotion': '#F44336',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? '#9E9E9E';
}

interface ProductCardProps {
  product: CADProduct;
  isSelected: boolean;
  onSelect: () => void;
}

function ProductCard({ product, isSelected, onSelect }: ProductCardProps) {
  const color = getCategoryColor(product.category);

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', product.ean);
        e.dataTransfer.setData('application/ean', product.ean);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={onSelect}
      className={[
        'flex items-center gap-2 px-2 py-2 rounded cursor-pointer transition-colors',
        isSelected
          ? 'bg-blue-600/20 border border-blue-600/40'
          : 'hover:bg-gray-800 border border-transparent',
      ].join(' ')}
    >
      {/* Category dot */}
      <div
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ background: color }}
        title={product.category}
      />

      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-gray-200 truncate">{product.name}</div>
        <div className="text-xs text-gray-500 truncate">
          {product.brand}
          <span className="mx-1 text-gray-700">·</span>
          <span className="font-mono text-gray-600">{product.ean}</span>
        </div>
      </div>

      <div
        className="text-xs px-1.5 py-0.5 rounded text-white shrink-0 font-medium"
        style={{ background: color + '33', color }}
      >
        {product.category.slice(0, 3)}
      </div>
    </div>
  );
}

interface CatalogPanelProps {
  projectId: string | null;
}

export default function CatalogPanel({ projectId: _projectId }: CatalogPanelProps) {
  const { filteredProducts, searchQuery, selectedEan, setSearchQuery, selectProduct, loading } =
    useCatalogStore();
  const [selectedCategory, setSelectedCategory] = useState<string>('All');

  const displayed =
    selectedCategory === 'All'
      ? filteredProducts
      : filteredProducts.filter((p) => p.category === selectedCategory);

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="p-2 border-b border-gray-800 shrink-0">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-xs">
            🔍
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search products…"
            className="w-full pl-7 pr-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
          {searchQuery && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              onClick={() => setSearchQuery('')}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex overflow-x-auto border-b border-gray-800 shrink-0">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={[
              'px-2.5 py-1.5 text-xs shrink-0 transition-colors whitespace-nowrap',
              selectedCategory === cat
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-500 hover:text-gray-300',
            ].join(' ')}
          >
            {cat === 'All' ? (
              cat
            ) : (
              <span className="flex items-center gap-1">
                <span
                  className="w-1.5 h-1.5 rounded-full inline-block"
                  style={{ background: getCategoryColor(cat) }}
                />
                {cat}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Count */}
      <div className="px-3 py-1 text-xs text-gray-600 border-b border-gray-800 shrink-0">
        {displayed.length} products
        {selectedEan && (
          <span className="ml-2 text-blue-400">• Selected: {selectedEan}</span>
        )}
      </div>

      {/* Product list */}
      <div className="flex-1 overflow-y-auto p-1">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && displayed.length === 0 && (
          <p className="text-xs text-gray-600 text-center py-8 italic">
            No products found
          </p>
        )}

        {!loading &&
          displayed.map((product) => (
            <ProductCard
              key={product.ean}
              product={product}
              isSelected={selectedEan === product.ean}
              onSelect={() =>
                selectProduct(selectedEan === product.ean ? null : product.ean)
              }
            />
          ))}
      </div>

      {/* Drag hint */}
      {selectedEan && (
        <div className="border-t border-gray-800 px-3 py-2 text-xs text-gray-500 shrink-0">
          Drag a product to a planogram cell, or click a cell to place it.
        </div>
      )}
    </div>
  );
}

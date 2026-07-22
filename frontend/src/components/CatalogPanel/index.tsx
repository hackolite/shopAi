import { useRef, useState } from 'react';
import { useCatalogStore } from '../../store/catalogStore';
import { cadApi } from '../../api/cad';
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

/** Small product thumbnail in catalog list. */
function CatalogThumb({ product }: { product: CADProduct }) {
  const color = getCategoryColor(product.category);
  const [imgError, setImgError] = useState(false);
  if (product.imageUrl && !imgError) {
    return (
      <img
        src={product.imageUrl}
        alt={product.name}
        className="w-8 h-8 object-contain rounded shrink-0"
        onError={() => setImgError(true)}
      />
    );
  }
  // Default SVG
  return (
    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 shrink-0" style={{ display: 'block' }}>
      <rect x="1" y="1" width="30" height="30" rx="3" fill={color + '22'} stroke={color} strokeWidth="1.5" />
      <rect x="6" y="10" width="20" height="2.5" rx="1" fill={color + 'aa'} />
      <rect x="6" y="16" width="14" height="2" rx="1" fill={color + '77'} />
      <rect x="6" y="21" width="10" height="1.5" rx="1" fill={color + '55'} />
    </svg>
  );
}

interface ProductCardProps {
  product: CADProduct;
  isSelected: boolean;
  onSelect: () => void;
  projectId: string | null;
  onImageUploaded: (ean: string, imageUrl: string) => void;
}

function ProductCard({ product, isSelected, onSelect, projectId, onImageUploaded }: ProductCardProps) {
  const color = getCategoryColor(product.category);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (file: File) => {
    if (!projectId) return;
    setUploading(true);
    try {
      const result = await cadApi.uploadProductImage(projectId, product.ean, file);
      onImageUploaded(product.ean, result.imageUrl);
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
    }
  };

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
        'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors group',
        isSelected
          ? 'bg-blue-600/20 border border-blue-600/40'
          : 'hover:bg-gray-800 border border-transparent',
      ].join(' ')}
    >
      {/* Thumbnail */}
      <div className="relative shrink-0">
        {uploading ? (
          <div className="w-8 h-8 flex items-center justify-center">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <CatalogThumb product={product} />
        )}
        {/* Upload button on hover */}
        <button
          className="absolute inset-0 flex items-center justify-center bg-black/50 rounded opacity-0 group-hover:opacity-100 transition-opacity text-xs"
          title="Uploader une vignette"
          onClick={(e) => { e.stopPropagation(); uploadRef.current?.click(); }}
        >
          📷
        </button>
        <input
          ref={uploadRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleUpload(file);
            e.target.value = '';
          }}
        />
      </div>

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

export default function CatalogPanel({ projectId }: CatalogPanelProps) {
  const {
    filteredProducts, searchQuery, selectedEan,
    setSearchQuery, selectProduct, setProducts, products, loading,
  } = useCatalogStore();
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const importRef = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const displayed =
    selectedCategory === 'All'
      ? filteredProducts
      : filteredProducts.filter((p) => p.category === selectedCategory);

  const handleImageUploaded = (ean: string, imageUrl: string) => {
    const updated = products.map(p => p.ean === ean ? { ...p, imageUrl } : p);
    setProducts(updated);
  };

  const handleImportJson = async (file: File) => {
    if (!projectId) return;
    setImportStatus('Importation…');
    try {
      const text = await file.text();
      const json = JSON.parse(text) as unknown;
      // Accept either { products: [...] } or a bare array
      const raw = Array.isArray(json) ? json : (json as Record<string, unknown>).products;
      if (!Array.isArray(raw)) throw new Error('Format invalide : tableau "products" attendu');
      const result = await cadApi.importCatalog(projectId, raw as CADProduct[], false);
      const refreshed = await cadApi.getCatalog(projectId);
      setProducts(refreshed.products);
      setImportStatus(`${result.imported} produits importés`);
    } catch (err) {
      setImportStatus(`Erreur : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTimeout(() => setImportStatus(null), 3000);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="p-2 border-b border-gray-800 shrink-0">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-xs">🔍</span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher des produits…"
            className="w-full pl-7 pr-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
          {searchQuery && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              onClick={() => setSearchQuery('')}
            >×</button>
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
            {cat === 'All' ? cat : (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: getCategoryColor(cat) }} />
                {cat}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Count + import button */}
      <div className="px-3 py-1 text-xs text-gray-600 border-b border-gray-800 shrink-0 flex items-center justify-between">
        <span>
          {displayed.length} produits
          {selectedEan && <span className="ml-2 text-blue-400">• Sélectionné: {selectedEan}</span>}
        </span>
        <button
          title="Importer un catalogue JSON"
          onClick={() => importRef.current?.click()}
          className="text-gray-500 hover:text-blue-400 transition-colors text-xs flex items-center gap-1"
          disabled={!projectId}
        >
          📂 Importer JSON
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportJson(file);
            e.target.value = '';
          }}
        />
      </div>

      {/* Import status */}
      {importStatus && (
        <div className="px-3 py-1 text-xs text-blue-400 border-b border-gray-800 shrink-0">
          {importStatus}
        </div>
      )}

      {/* Product list */}
      <div className="flex-1 overflow-y-auto p-1">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {!loading && displayed.length === 0 && (
          <p className="text-xs text-gray-600 text-center py-8 italic">Aucun produit trouvé</p>
        )}
        {!loading && displayed.map((product) => (
          <ProductCard
            key={product.ean}
            product={product}
            isSelected={selectedEan === product.ean}
            onSelect={() => selectProduct(selectedEan === product.ean ? null : product.ean)}
            projectId={projectId}
            onImageUploaded={handleImageUploaded}
          />
        ))}
      </div>

      {selectedEan && (
        <div className="border-t border-gray-800 px-3 py-2 text-xs text-gray-500 shrink-0">
          Glissez un produit vers une cellule du planogramme, ou cliquez une cellule.
        </div>
      )}
    </div>
  );
}

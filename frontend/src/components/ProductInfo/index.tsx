import type { SearchResult, Voxel } from '../../types';

interface ProductInfoProps {
  result: SearchResult | null;
  hoveredVoxel: Voxel | null;
  error: string | null;
}

function MetricCard({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="bg-gray-800 rounded p-3 space-y-0.5">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg font-semibold text-white">
        {value}
        {unit && <span className="text-xs text-gray-400 ml-1">{unit}</span>}
      </p>
    </div>
  );
}

const CATEGORY_COLORS: Record<string, string> = {
  epicerie:  '#F5C518',
  boisson:   '#2196F3',
  frais:     '#4CAF50',
  hygiene:   '#9C27B0',
  promotion: '#F44336',
};

export function ProductInfo({ result, hoveredVoxel, error }: ProductInfoProps) {
  if (error) {
    return (
      <div className="p-4">
        <div className="bg-red-900/30 border border-red-800 rounded p-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="p-4 space-y-3">
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block">
          Product Info
        </label>
        {hoveredVoxel ? (
          <div className="space-y-2">
            <div className="text-xs text-gray-400">Hovering:</div>
            <div className="bg-gray-800 rounded p-3 space-y-1">
              <p className="text-gray-300 text-sm font-mono">{hoveredVoxel.ean}</p>
              <p className="text-xs text-gray-500 capitalize">{hoveredVoxel.category}</p>
              <div
                className="w-4 h-4 rounded-sm mt-1"
                style={{ background: hoveredVoxel.color }}
              />
            </div>
          </div>
        ) : (
          <p className="text-xs text-gray-600 leading-relaxed">
            Search for an EAN to see product details and highlight all store locations.
          </p>
        )}
      </div>
    );
  }

  const { product, instances, total_positions, total_facings, analytics_summary } = result;
  const catColor = CATEGORY_COLORS[product.category] ?? '#90A4AE';

  return (
    <div className="p-4 space-y-4 overflow-y-auto">
      {/* Product identity */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-sm shrink-0"
            style={{ background: catColor }}
          />
          <span className="text-xs text-gray-500 capitalize">{product.category}</span>
        </div>
        <h2 className="text-white font-semibold text-base leading-snug">{product.name}</h2>
        <p className="text-gray-400 text-sm">{product.brand}</p>
        <p className="text-gray-500 font-mono text-xs">{product.ean}</p>
      </div>

      {/* Dimensions */}
      <div className="bg-gray-800 rounded p-3">
        <p className="text-xs text-gray-500 mb-2">Dimensions</p>
        <div className="grid grid-cols-3 gap-2 text-center">
          {['width', 'depth', 'height'].map((dim) => (
            <div key={dim}>
              <p className="text-white text-sm font-mono">
                {product.dimensions_cm[dim as keyof typeof product.dimensions_cm]}
              </p>
              <p className="text-gray-600 text-xs">{dim.charAt(0).toUpperCase() + dim.slice(1)} cm</p>
            </div>
          ))}
        </div>
      </div>

      {/* Position metrics */}
      <div className="grid grid-cols-2 gap-2">
        <MetricCard label="Positions" value={total_positions} />
        <MetricCard label="Total facings" value={total_facings} />
      </div>

      {/* Analytics */}
      {analytics_summary.data_available && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Analytics (demo)
          </p>
          <div className="grid grid-cols-1 gap-2">
            <MetricCard
              label="Total passes"
              value={analytics_summary.total_passes.toLocaleString()}
            />
            <MetricCard
              label="Total views"
              value={analytics_summary.total_views.toLocaleString()}
            />
            {analytics_summary.avg_attention_seconds !== null && (
              <MetricCard
                label="Avg attention"
                value={analytics_summary.avg_attention_seconds}
                unit="sec"
              />
            )}
          </div>
        </div>
      )}

      {/* Location list */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Locations ({total_positions})
        </p>
        <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
          {instances.map((inst) => (
            <div
              key={inst.instance_id}
              className="bg-gray-800 rounded px-3 py-2 flex justify-between items-center"
            >
              <div>
                <p className="text-gray-300 text-xs font-medium">
                  {inst.shelf} · Level {inst.level}
                </p>
                <p className="text-gray-600 text-xs capitalize">{inst.zone}</p>
              </div>
              <span className="text-xs text-gray-500 bg-gray-700 rounded px-2 py-0.5">
                ×{inst.facings}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { api } from './api';
import type { Store, Voxel, SearchResult } from './types';
import { StoreScene } from './three/StoreScene';
import { Header } from './components/Header';
import { SidePanel } from './components/SidePanel';
import { SearchBar } from './components/SearchBar';
import { ProductInfo } from './components/ProductInfo';

const DEFAULT_PROJECT = 'demo_store';

export default function App() {
  const [projects, setProjects] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string>(DEFAULT_PROJECT);
  const [store, setStore] = useState<Store | null>(null);
  const [voxels, setVoxels] = useState<Voxel[]>([]);
  const [eanList, setEanList] = useState<string[]>([]);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hoveredVoxel, setHoveredVoxel] = useState<Voxel | null>(null);
  const [sceneLoading, setSceneLoading] = useState(false);

  const loadProject = useCallback(async (id: string) => {
    setSceneLoading(true);
    setSearchResult(null);
    setSearchError(null);
    try {
      const [storeData, planogramData] = await Promise.all([
        api.getStore(id),
        api.getPlanogram(id),
      ]);
      setStore(storeData);
      setVoxels(planogramData.voxels);

      const eanIdx = await fetch(`/api/projects/${id}/ean-index`)
        .then((r) => r.json())
        .catch(() => ({}));
      setEanList(Object.keys(eanIdx));
    } catch (err) {
      console.error('Failed to load project:', err);
    } finally {
      setSceneLoading(false);
    }
  }, []);

  useEffect(() => {
    api.listProjects().then(({ projects }) => {
      setProjects(projects);
      const id = projects.includes(DEFAULT_PROJECT) ? DEFAULT_PROJECT : projects[0];
      if (id) {
        setProjectId(id);
        loadProject(id);
      }
    });
  }, [loadProject]);

  const handleSearch = useCallback(async (ean: string) => {
    setSearchLoading(true);
    setSearchError(null);
    try {
      const result = await api.searchEan(projectId, ean);
      setSearchResult(result);
    } catch (err) {
      setSearchResult(null);
      setSearchError((err as Error).message);
    } finally {
      setSearchLoading(false);
    }
  }, [projectId]);

  const handleProjectLoad = useCallback((id: string) => {
    setProjectId(id);
    loadProject(id);
  }, [loadProject]);

  const handleVoxelClick = useCallback((voxel: Voxel) => {
    handleSearch(voxel.ean);
  }, [handleSearch]);

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      <Header projectId={projectId} />

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel */}
        <div className="flex flex-col w-64 shrink-0 border-r border-gray-800 bg-gray-900 overflow-y-auto">
          <SidePanel
            projectId={projectId}
            projects={projects}
            onProjectLoad={handleProjectLoad}
          />
          <SearchBar
            onSearch={handleSearch}
            loading={searchLoading}
            suggestions={eanList}
          />
        </div>

        {/* 3D Viewport */}
        <main className="flex-1 relative">
          {sceneLoading && (
            <div className="absolute inset-0 z-10 bg-gray-950/80 flex items-center justify-center">
              <div className="text-center space-y-2">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-gray-400 text-sm">Loading store…</p>
              </div>
            </div>
          )}

          <StoreScene
            store={store}
            voxels={voxels}
            searchResult={searchResult}
            onHoverVoxel={setHoveredVoxel}
            onClickVoxel={handleVoxelClick}
          />

          {hoveredVoxel && !searchResult && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-gray-900/90 backdrop-blur border border-gray-700 rounded px-3 py-2 text-xs text-gray-300 pointer-events-none">
              <span className="font-mono">{hoveredVoxel.ean}</span>
              <span className="mx-2 text-gray-600">·</span>
              <span className="capitalize">{hoveredVoxel.category}</span>
            </div>
          )}

          {searchResult && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-gray-900/90 backdrop-blur border border-blue-800 rounded px-4 py-2 text-sm text-gray-200 pointer-events-none flex items-center gap-3">
              <span
                className="w-2.5 h-2.5 rounded-full animate-pulse"
                style={{ background: '#FFD700' }}
              />
              <span>
                <strong className="text-white">{searchResult.product.name}</strong>
                {' '}&mdash;{' '}
                <span className="text-gray-400">
                  {searchResult.total_positions} position{searchResult.total_positions > 1 ? 's' : ''},{' '}
                  {searchResult.total_facings} facings
                </span>
              </span>
              <button
                className="pointer-events-auto text-gray-500 hover:text-gray-300 ml-2"
                onClick={() => setSearchResult(null)}
              >
                ×
              </button>
            </div>
          )}
        </main>

        {/* Right panel */}
        <aside className="w-72 shrink-0 border-l border-gray-800 bg-gray-900 overflow-y-auto">
          <div className="p-4 border-b border-gray-800">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Product Info
            </h3>
          </div>
          <ProductInfo
            result={searchResult}
            hoveredVoxel={hoveredVoxel}
            error={searchError}
          />
        </aside>
      </div>
    </div>
  );
}

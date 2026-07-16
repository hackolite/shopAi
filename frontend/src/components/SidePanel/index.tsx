import { useState, useRef } from 'react';
import { api } from '../../api';

interface SidePanelProps {
  projectId: string;
  onProjectLoad: (id: string) => void;
  projects: string[];
}

function FileImportRow({
  label,
  onImport,
  loading,
}: {
  label: string;
  onImport: (file: File) => Promise<void>;
  loading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('Importing…');
    try {
      await onImport(file);
      setStatus('✓ Imported');
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="space-y-1">
      <button
        disabled={loading}
        onClick={() => inputRef.current?.click()}
        className="w-full text-left text-sm px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded border border-gray-700 transition-colors disabled:opacity-50"
      >
        {label}
      </button>
      {status && (
        <p className={`text-xs px-1 ${status.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
          {status}
        </p>
      )}
      <input ref={inputRef} type="file" accept=".json" className="hidden" onChange={handleChange} />
    </div>
  );
}

export function SidePanel({ projectId, onProjectLoad, projects }: SidePanelProps) {
  const [loading, setLoading] = useState(false);

  const handleImport = (fn: (file: File) => Promise<unknown>) => async (file: File) => {
    setLoading(true);
    try {
      await fn(file);
      onProjectLoad(projectId);
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="w-64 bg-gray-900 border-r border-gray-700 flex flex-col shrink-0 overflow-y-auto">
      {/* Project selector */}
      <div className="p-4 border-b border-gray-800">
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">
          Project
        </label>
        <select
          value={projectId}
          onChange={(e) => onProjectLoad(e.target.value)}
          className="w-full bg-gray-800 text-gray-200 text-sm px-3 py-2 rounded border border-gray-700 focus:border-blue-500 focus:outline-none"
        >
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {/* Import section */}
      <div className="p-4 border-b border-gray-800 space-y-3">
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block">
          Import
        </label>

        <FileImportRow
          label="📁 Import store.json"
          loading={loading}
          onImport={handleImport((f) => api.importStore(projectId, f))}
        />
        <FileImportRow
          label="📋 Import products.json"
          loading={loading}
          onImport={handleImport((f) => api.importProducts(projectId, f))}
        />
        <FileImportRow
          label="🗂 Import planogram.json"
          loading={loading}
          onImport={handleImport((f) => api.importPlanogram(projectId, f))}
        />
      </div>

      {/* Legend */}
      <div className="p-4">
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-3">
          Category Legend
        </label>
        <div className="space-y-2">
          {[
            { label: 'Épicerie',  color: '#F5C518' },
            { label: 'Boisson',   color: '#2196F3' },
            { label: 'Frais',     color: '#4CAF50' },
            { label: 'Hygiène',   color: '#9C27B0' },
            { label: 'Promotion', color: '#F44336' },
          ].map(({ label, color }) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: color }} />
              <span className="text-xs text-gray-400">{label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-auto p-4 border-t border-gray-800">
        <p className="text-xs text-gray-600 leading-relaxed">
          1 unit = 10 cm · Scale: voxel Minecraft
        </p>
      </div>
    </aside>
  );
}

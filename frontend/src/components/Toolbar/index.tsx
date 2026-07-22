import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import type { ActiveTool, ViewMode } from '../../store/uiStore';

interface ToolbarProps {
  projectName: string;
  projects: { id: string; name: string }[];
  saveStatus: 'idle' | 'saving' | 'saved';
  onNew: () => void;
  onLoad: (projectId: string) => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: () => void;
  onImport: () => void;
}

const TOOLS: { id: ActiveTool; label: string; icon: string; title: string }[] = [
  { id: 'select',    label: 'Sélect.',  icon: '↖', title: 'Sélectionner (S)' },
  { id: 'translate', label: 'Déplacer', icon: '✥', title: 'Déplacer (G)' },
  { id: 'rotate',    label: 'Rotation', icon: '↻', title: 'Rotation (R)' },
  { id: 'scale',     label: 'Redim.',   icon: '⤡', title: 'Redimensionner (E)' },
  { id: 'measure',   label: 'Mesure',   icon: '📏', title: 'Mesure distance (M)' },
];

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: '3d',        label: '3D'  },
  { id: 'planogram', label: 'PLN' },
  { id: 'split',     label: '⊞'  },
];

export default function Toolbar({ projectName, projects, saveStatus, onNew, onLoad, onSave, onSaveAs, onExport, onImport }: ToolbarProps) {
  const { activeTool, setActiveTool, viewMode, setViewMode, bevMode, setBevMode } = useUIStore();
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [loadMenuOpen, setLoadMenuOpen] = useState(false);

  const closeMenus = () => { setFileMenuOpen(false); setLoadMenuOpen(false); };

  return (
    <div className="flex items-center h-11 bg-gray-950 border-b border-gray-800 shrink-0 px-3 gap-4 select-none">
      {/* ── Left: Logo + Project Name + File menu ── */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-lg leading-none">🏪</span>
        <span className="text-sm font-semibold text-gray-200 truncate max-w-32" title={projectName}>
          {projectName}
        </span>

        {/* File menu button */}
        <div className="relative">
          <button
            onClick={() => { setFileMenuOpen((v) => !v); setLoadMenuOpen(false); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
            title="Menu Fichier"
          >
            📁
            <span className="hidden md:inline">Fichier</span>
            <span className="text-gray-600">▾</span>
          </button>

          {fileMenuOpen && (
            <>
              {/* Backdrop */}
              <div className="fixed inset-0 z-40" onClick={closeMenus} />
              <div className="absolute left-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded shadow-xl min-w-44 py-1">
                <button
                  onClick={() => { closeMenus(); void onNew(); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2"
                >
                  <span>📄</span> Nouveau
                </button>

                {/* Load submenu */}
                <div className="relative">
                  <button
                    onClick={() => setLoadMenuOpen((v) => !v)}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2 justify-between"
                  >
                    <span className="flex items-center gap-2"><span>📂</span> Ouvrir</span>
                    <span className="text-gray-600">▶</span>
                  </button>
                  {loadMenuOpen && (
                    <div className="absolute left-full top-0 ml-1 bg-gray-900 border border-gray-700 rounded shadow-xl min-w-48 py-1 max-h-64 overflow-y-auto">
                      {projects.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-gray-500">Aucun projet</div>
                      ) : (
                        projects.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => { closeMenus(); onLoad(p.id); }}
                            className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white truncate"
                          >
                            {p.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-800 my-1" />

                <button
                  onClick={() => { closeMenus(); void onSave(); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2"
                >
                  <span>💾</span> Enregistrer <span className="ml-auto text-gray-600">Ctrl+S</span>
                </button>
                <button
                  onClick={() => { closeMenus(); void onSaveAs(); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2"
                >
                  <span>💾</span> Enregistrer sous…
                </button>

                <div className="border-t border-gray-800 my-1" />

                <button
                  onClick={() => { closeMenus(); onExport(); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2"
                >
                  <span>⬇</span> Exporter…
                </button>
                <button
                  onClick={() => { closeMenus(); onImport(); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2"
                >
                  <span>⬆</span> Importer…
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex-1" />

      {/* ── Center: Tools ── */}
      <div className="flex items-center gap-1">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            title={tool.title}
            onClick={() => setActiveTool(tool.id)}
            className={[
              'flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors',
              activeTool === tool.id
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800',
            ].join(' ')}
          >
            <span className="text-sm">{tool.icon}</span>
            <span className="hidden sm:inline">{tool.label}</span>
          </button>
        ))}
      </div>

      {/* ── Separator ── */}
      <div className="h-5 w-px bg-gray-800" />

      {/* ── BEV toggle ── */}
      {(viewMode === '3d' || viewMode === 'split') && (
        <button
          title="Vue de dessus (Bird's Eye View)"
          onClick={() => setBevMode(!bevMode)}
          className={[
            'flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors',
            bevMode
              ? 'bg-indigo-600 text-white'
              : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800 border border-gray-700',
          ].join(' ')}
        >
          <span>🔭</span>
          <span className="hidden sm:inline">BEV</span>
        </button>
      )}

      {/* ── Separator ── */}
      <div className="h-5 w-px bg-gray-800" />

      {/* ── View Mode ── */}
      <div className="flex items-center rounded overflow-hidden border border-gray-800">
        {VIEW_MODES.map((mode) => (
          <button
            key={mode.id}
            onClick={() => setViewMode(mode.id)}
            className={[
              'px-3 py-1 text-xs font-medium transition-colors',
              viewMode === mode.id
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800',
            ].join(' ')}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* ── Right: Save status + Settings ── */}
      <div className="flex items-center gap-3 text-xs text-gray-500">
        {saveStatus === 'saving' && (
          <span className="flex items-center gap-1 text-yellow-400">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 inline-block animate-pulse" />
            Enregistrement…
          </span>
        )}
        {saveStatus === 'saved' && (
          <span className="flex items-center gap-1 text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
            Enregistré
          </span>
        )}
        {saveStatus === 'idle' && (
          <span className="hidden md:flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
            Auto-saved
          </span>
        )}
        <button
          className="px-2 py-1 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}

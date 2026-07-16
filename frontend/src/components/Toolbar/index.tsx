import { useUIStore } from '../../store/uiStore';
import type { ActiveTool, ViewMode } from '../../store/uiStore';

interface ToolbarProps {
  projectName: string;
}

const TOOLS: { id: ActiveTool; label: string; icon: string; title: string }[] = [
  { id: 'select',    label: 'Select',    icon: '↖', title: 'Select (S)' },
  { id: 'translate', label: 'Move',      icon: '✥', title: 'Move (G)' },
  { id: 'rotate',    label: 'Rotate',    icon: '↻', title: 'Rotate (R)' },
  { id: 'scale',     label: 'Resize',    icon: '⤡', title: 'Resize / Scale (E)' },
  { id: 'measure',   label: 'Mesure',    icon: '📏', title: 'Mesure distance (M)' },
];

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: '3d',        label: '3D'  },
  { id: 'planogram', label: 'PLN' },
  { id: 'split',     label: '⊞'  },
];

export default function Toolbar({ projectName }: ToolbarProps) {
  const { activeTool, setActiveTool, viewMode, setViewMode } = useUIStore();

  return (
    <div className="flex items-center h-11 bg-gray-950 border-b border-gray-800 shrink-0 px-3 gap-4 select-none">
      {/* ── Left: Logo + Project Name ── */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-lg leading-none">🏪</span>
        <span className="text-sm font-semibold text-gray-200 truncate max-w-40">
          {projectName}
        </span>
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

      {/* ── Right: Status ── */}
      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span className="hidden md:inline flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
          Auto-saved
        </span>
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

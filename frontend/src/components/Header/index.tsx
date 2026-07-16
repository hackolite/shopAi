interface HeaderProps {
  projectId: string | null;
}

export function Header({ projectId }: HeaderProps) {
  return (
    <header className="h-14 bg-gray-900 border-b border-gray-700 flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 bg-blue-600 rounded flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" className="w-4 h-4">
            <rect x="2" y="3" width="7" height="7" />
            <rect x="15" y="3" width="7" height="7" />
            <rect x="2" y="14" width="7" height="7" />
            <rect x="15" y="14" width="7" height="7" />
          </svg>
        </div>
        <span className="text-white font-semibold text-base tracking-tight">
          Retail Digital Twin
        </span>
      </div>

      <div className="flex items-center gap-4">
        {projectId && (
          <span className="text-xs text-gray-400 font-mono bg-gray-800 px-2 py-1 rounded">
            {projectId}
          </span>
        )}
        <span className="text-xs text-gray-500">MVP v1.0</span>
      </div>
    </header>
  );
}

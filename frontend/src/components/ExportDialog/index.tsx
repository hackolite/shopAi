interface ExportDialogProps {
  projectName: string;
  onConfirm: (format: 'zip') => void;
  onCancel: () => void;
}

const FORMATS: { id: 'zip'; label: string; description: string; enabled: boolean }[] = [
  { id: 'zip', label: 'ZIP', description: 'Archive ZIP contenant les fichiers JSON du projet', enabled: true },
];

export default function ExportDialog({ projectName, onConfirm, onCancel }: ExportDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />

      <div className="relative z-10 w-96 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-100 mb-1">Exporter le projet</h2>
        <p className="text-xs text-gray-500 mb-4 truncate">
          <span className="text-gray-400">{projectName}</span>
        </p>

        <p className="text-xs text-gray-400 mb-3">Choisissez un format d'exportation :</p>

        <div className="flex flex-col gap-2 mb-5">
          {FORMATS.map((fmt) => (
            <button
              key={fmt.id}
              onClick={() => fmt.enabled && onConfirm(fmt.id)}
              disabled={!fmt.enabled}
              className={[
                'flex items-start gap-3 px-3 py-3 rounded-lg border text-left transition-colors',
                fmt.enabled
                  ? 'border-blue-600 bg-blue-600/10 hover:bg-blue-600/20 cursor-pointer'
                  : 'border-gray-700 bg-gray-800/40 opacity-50 cursor-not-allowed',
              ].join(' ')}
            >
              <span className="text-lg leading-none mt-0.5">📦</span>
              <div>
                <div className="text-xs font-semibold text-gray-100">
                  {fmt.label}
                  {!fmt.enabled && (
                    <span className="ml-2 text-gray-500 font-normal">(bientôt disponible)</span>
                  )}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">{fmt.description}</div>
              </div>
            </button>
          ))}
        </div>

        <div className="flex justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded transition-colors"
          >
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
}

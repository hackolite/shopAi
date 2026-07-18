import { useRef, useState } from 'react';

export type ImportFormat = 'zip';

interface ImportDialogProps {
  onImport: (file: File, name: string, format: ImportFormat) => void;
  onCancel: () => void;
}

const FORMATS: { id: ImportFormat; label: string; description: string; accept: string; enabled: boolean }[] = [
  {
    id: 'zip',
    label: 'ZIP',
    description: 'Archive ZIP exportée depuis ShopAI',
    accept: '.zip,application/zip',
    enabled: true,
  },
];

export default function ImportDialog({ onImport, onCancel }: ImportDialogProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<ImportFormat>('zip');
  const [projectName, setProjectName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentFormat = FORMATS.find((f) => f.id === selectedFormat)!;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    setSelectedFile(file);
    if (!projectName) {
      // Strip known archive extension (handles e.g. "project.backup.zip" → "project.backup")
      const derived = file.name
        .replace(/\.zip$/i, '')
        .replace(/_/g, ' ')
        .trim();
      setProjectName(derived);
    }
    e.target.value = '';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || !projectName.trim()) return;
    onImport(selectedFile, projectName.trim(), selectedFormat);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />

      <div className="relative z-10 w-96 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl p-5">
        <h2 className="text-sm font-semibold text-gray-100 mb-4">Importer un projet</h2>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Format selection */}
          <div>
            <p className="text-xs text-gray-400 mb-2">Format :</p>
            <div className="flex flex-col gap-1.5">
              {FORMATS.map((fmt) => (
                <label
                  key={fmt.id}
                  className={[
                    'flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors',
                    !fmt.enabled && 'opacity-50 cursor-not-allowed',
                    fmt.enabled && selectedFormat === fmt.id
                      ? 'border-blue-600 bg-blue-600/10'
                      : 'border-gray-700 hover:border-gray-600',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="format"
                    value={fmt.id}
                    checked={selectedFormat === fmt.id}
                    disabled={!fmt.enabled}
                    onChange={() => {
                      if (fmt.enabled) {
                        setSelectedFormat(fmt.id);
                        setSelectedFile(null);
                      }
                    }}
                    className="mt-0.5 accent-blue-500"
                  />
                  <div>
                    <div className="text-xs font-semibold text-gray-100">
                      {fmt.label}
                      {!fmt.enabled && (
                        <span className="ml-2 text-gray-500 font-normal">(bientôt disponible)</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400">{fmt.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* File picker */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept={currentFormat.accept}
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 border border-dashed border-gray-600 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:border-gray-400 transition-colors"
            >
              <span>📂</span>
              {selectedFile ? (
                <span className="text-gray-200 truncate max-w-56">{selectedFile.name}</span>
              ) : (
                <span>Sélectionner un fichier {currentFormat.label}…</span>
              )}
            </button>
          </div>

          {/* Project name */}
          {selectedFile && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Nom du projet importé</label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                className="bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                autoFocus
              />
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded transition-colors"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={!selectedFile || !projectName.trim()}
              className="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors"
            >
              Importer
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

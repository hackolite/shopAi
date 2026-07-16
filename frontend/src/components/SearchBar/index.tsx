import { useState, useRef } from 'react';

interface SearchBarProps {
  onSearch: (ean: string) => Promise<void>;
  loading: boolean;
  suggestions?: string[];
}

export function SearchBar({ onSearch, loading, suggestions = [] }: SearchBarProps) {
  const [value, setValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Demo EAN shortcut
  const DEMO_EAN = '3017620422003';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ean = value.trim();
    if (!ean) return;
    setShowSuggestions(false);
    await onSearch(ean);
  };

  const handleDemo = () => {
    setValue(DEMO_EAN);
    onSearch(DEMO_EAN);
  };

  const filtered = suggestions.filter((s) => s.includes(value) && value.length > 3);

  return (
    <div className="p-4 border-b border-gray-800">
      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">
        EAN Search
      </label>

      <form onSubmit={handleSubmit} className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setShowSuggestions(true);
              }}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              onFocus={() => setShowSuggestions(true)}
              placeholder="3017620422003"
              className="w-full bg-gray-800 text-gray-200 text-sm px-3 py-2 rounded-l border border-gray-700 focus:border-blue-500 focus:outline-none font-mono placeholder-gray-600"
            />

            {showSuggestions && filtered.length > 0 && (
              <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-lg max-h-48 overflow-y-auto">
                {filtered.slice(0, 8).map((s) => (
                  <li
                    key={s}
                    className="px-3 py-1.5 text-xs font-mono text-gray-300 hover:bg-gray-700 cursor-pointer"
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep input focused
                      setValue(s);
                      onSearch(s);
                    }}
                  >
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || !value.trim()}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-r border border-blue-600 disabled:opacity-40 transition-colors"
          >
            {loading ? (
              <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
            ) : (
              '→'
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={handleDemo}
          className="mt-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          Demo: Nutella ({DEMO_EAN})
        </button>
      </form>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { cadApi } from '../api/cad';

interface Props {
  projectId: string;
  onProjectCreated: (id: string) => Promise<void>;
  onSave: () => Promise<void>;
}

const suggestions = [
  'Crée une implantation complète Carrefour City',
  'Crée une implantation complète Carrefour Express aéroport',
  'Crée une implantation seule Carrefour Express',
  "Recommandation d'implantation",
  'Vérifie',
];

function isPlacementRecommendation(prompt: string): boolean {
  return /recommand|implante le catalogue|implemente le catalogue/i.test(prompt);
}

export default function StudioAssistant({ projectId, onProjectCreated, onSave }: Props) {
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([]);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const generatedProject = useRef<string | null>(null);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;

  useEffect(() => {
    if (generatedProject.current !== projectId) setMessages([]);
    generatedProject.current = null;
    setPrompt('');
    setConfirmation(null);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, busy]);

  async function send(text: string, confirm = false) {
    if (!text.trim() || busy) return;
    const sourceId = projectId;
    setBusy(true);
    setError(null);
    setConfirmation(null);
    if (!confirm) {
      setMessages((current) => [...current, { role: 'Vous', text }]);
      setPrompt('');
    }
    try {
      if (/^(enregistre|sauvegarde)( le projet)?[.!?]*$/i.test(text.trim())) {
        await onSave();
        if (activeProject.current !== sourceId) return;
      }
      const result = await cadApi.askAssistant(sourceId, text, confirm);
      if (activeProject.current !== sourceId) return;
      setMessages((current) => [...current, {
        role: 'Assistant',
        text: [result.message, ...(result.steps ?? [])].join('\n'),
      }]);
      if (result.requiresConfirmation) setConfirmation(text);
      if (result.changed && result.projectId) {
        generatedProject.current = result.projectId;
        await onProjectCreated(result.projectId);
      }
    } catch (cause) {
      if (activeProject.current === sourceId) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Assistant d’implantation" className="flex h-full flex-col text-base">
      <div className="border-b border-gray-700 p-5">
        <h2 className="text-lg font-semibold">Assistant d’implantation</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-300">
          Assistant local basé sur les modèles Carrefour, sans IA externe.
          Une implantation complète inclut mobilier, catalogue et produits.
          Le résultat s’ouvre en 3D dès sa création et reste enregistré.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mb-5 flex flex-col gap-2">
          {suggestions.map((text) => (
            <button key={text} type="button" disabled={busy}
              onClick={() => setPrompt(text)}
              className="rounded-xl border border-gray-600 px-3 py-3 text-left text-sm text-cyan-200 hover:bg-gray-800 disabled:opacity-50">
              {text}
            </button>
          ))}
        </div>
        <div role="log" aria-live="polite" aria-relevant="additions" className="space-y-4">
          {messages.map((message, index) => (
            <div key={index} className="rounded-xl bg-gray-800 p-4">
              <p className="mb-2 text-sm font-semibold text-cyan-200">{message.role}</p>
              <p className="whitespace-pre-wrap leading-relaxed">{message.text}</p>
            </div>
          ))}
        </div>
        {busy && <p role="status" className="mt-4 text-cyan-200">Traitement de la demande…</p>}
        {error && <p role="alert" className="mt-4 break-words text-red-300">{error}</p>}
        {confirmation && (
          <div className="mt-4 space-y-3 rounded-xl border border-cyan-800 p-4">
            <p className="text-sm text-gray-200">
              {isPlacementRecommendation(confirmation)
                ? 'Les articles seront implantés un par un dans les planogrammes de ce projet.'
                : 'Un nouveau projet sera enregistré. Le projet actuel ne sera pas remplacé.'}
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={busy} onClick={() => void send(confirmation, true)}
                className="rounded-lg bg-cyan-400 px-4 py-3 font-medium text-gray-950">
                {isPlacementRecommendation(confirmation) ? 'Exécuter la recommandation' : 'Créer et ouvrir en 3D'}
              </button>
              <button type="button" onClick={() => setConfirmation(null)} className="px-3 py-3 text-gray-300">Annuler</button>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <form className="space-y-3 border-t border-gray-700 p-5" onSubmit={(event) => {
        event.preventDefault();
        void send(prompt);
      }}>
        <label htmlFor="studio-agent-prompt" className="block font-medium">Votre demande</label>
        <textarea id="studio-agent-prompt" value={prompt} maxLength={2000} rows={3}
          onChange={(event) => setPrompt(event.target.value)} disabled={busy}
          placeholder="Décrivez l’implantation souhaitée…"
          className="w-full resize-y rounded-xl border border-gray-600 bg-gray-950 p-3 focus:border-cyan-400 focus:outline-none" />
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy || !prompt.trim()}
            className="rounded-xl bg-cyan-400 px-4 py-3 font-semibold text-gray-950 disabled:opacity-50">Envoyer</button>
          <button type="button" disabled={busy} onClick={() => void onSave().catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          })} className="rounded-xl border border-gray-600 px-4 py-3 disabled:opacity-50">Enregistrer</button>
        </div>
      </form>
    </section>
  );
}

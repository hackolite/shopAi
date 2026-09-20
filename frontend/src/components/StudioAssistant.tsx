import { useEffect, useRef, useState } from 'react';
import { cadApi } from '../api/cad';
import type { AssistantCategory, LlmAssistantStatus } from '../api/cad';
import { shouldUseLlmPath } from '../engine/assistantRouting';

interface Props {
  projectId: string;
  onProjectCreated: (id: string) => Promise<void>;
  onSave: () => Promise<void>;
}

interface PendingConfirmation {
  text: string;
  category: AssistantCategory;
  viaLlm: boolean;
  token?: string;
}

interface CategoryOption {
  id: AssistantCategory;
  label: string;
  hint: string;
  suggestions: string[];
}

const categories: CategoryOption[] = [
  {
    id: 'layout-modify',
    label: "Modifier l'implantation",
    hint: 'Le magasin existe déjà : ajuster le mobilier, la grille ou les dimensions.',
    suggestions: ['Vérifie'],
  },
  {
    id: 'layout-create',
    label: "Créer l'implantation",
    hint: "Aucune implantation encore : générer un nouveau magasin (mobilier seul).",
    suggestions: [
      'Crée une implantation seule Carrefour City',
      'Crée une implantation seule Carrefour Express',
      'Crée une implantation seule Carrefour Express aéroport',
    ],
  },
  {
    id: 'assortment-modify',
    label: "Modifier l'assortiment (catalogue déjà chargé)",
    hint: 'Le catalogue est déjà importé dans ce projet : compléter ou corriger les planogrammes existants.',
    suggestions: ["Recommandation d'implantation"],
  },
  {
    id: 'assortment-full',
    label: 'Assortiment complet (aucun produit placé)',
    hint: "Aucun produit n'est encore placé : implanter tout le catalogue depuis zéro.",
    suggestions: ['Implante le catalogue'],
  },
  {
    id: 'freestyle',
    label: 'Libre — from scratch / freestyle',
    hint: 'Projet complet, sans contrainte : implantation, catalogue et planogrammes en une fois.',
    suggestions: [
      'Crée une implantation complète Carrefour City',
      'Crée une implantation complète Carrefour Express aéroport',
    ],
  },
];

function isPlacementRecommendation(prompt: string): boolean {
  return /recommand|implante le catalogue|implemente le catalogue/i.test(prompt);
}

export default function StudioAssistant({ projectId, onProjectCreated, onSave }: Props) {
  const [prompt, setPrompt] = useState('');
  const [category, setCategory] = useState<AssistantCategory | null>(null);
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([]);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmAssistantStatus>({
    enabled: false,
    reachable: false,
    status: 'missing',
    message: 'Prétest LLM en attente…',
  });
  const endRef = useRef<HTMLDivElement>(null);
  const generatedProject = useRef<string | null>(null);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;

  useEffect(() => {
    if (generatedProject.current !== projectId) setMessages([]);
    generatedProject.current = null;
    setPrompt('');
    setCategory(null);
    setConfirmation(null);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLlmStatus({
      enabled: false,
      reachable: false,
      status: 'missing',
      message: 'Prétest LLM en cours…',
    });
    cadApi.getLlmAssistantStatus(projectId)
      .then((status) => { if (!cancelled) setLlmStatus(status); })
      .catch((cause) => {
        if (!cancelled) {
          setLlmStatus({
            enabled: false,
            reachable: false,
            status: 'error',
            message: cause instanceof Error ? cause.message : 'Prétest LLM impossible',
          });
        }
      });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, busy]);

  async function send(text: string, pending?: PendingConfirmation) {
    if (!text.trim() || !category || busy) return;
    const confirm = pending !== undefined;
    const sourceId = projectId;
    const viaLlm = pending?.viaLlm ?? shouldUseLlmPath(llmStatus);
    const requestCategory = pending?.category ?? category;
    setBusy(true);
    setError(null);
    setConfirmation(null);
    if (!confirm) {
      setMessages((current) => [...current, { role: 'Vous', text }]);
      setPrompt('');
    }
    try {
      if (!viaLlm && /^(enregistre|sauvegarde)( le projet)?[.!?]*$/i.test(text.trim())) {
        await onSave();
        if (activeProject.current !== sourceId) return;
      }
      const result = viaLlm
        ? await cadApi.askLlmAssistant(sourceId, text, confirm, {
          category: requestCategory, confirmationToken: pending?.token,
        })
        : await cadApi.askAssistant(sourceId, text, confirm);
      if (activeProject.current !== sourceId) return;
      setMessages((current) => [...current, {
        role: viaLlm ? 'Agent LLM' : 'Assistant',
        text: [result.message, ...(result.steps ?? [])].join('\n'),
      }]);
      if (result.requiresConfirmation) setConfirmation({
        text, category: requestCategory, viaLlm, token: result.confirmationToken,
      });
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
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="rounded-2xl border border-cyan-900/70 bg-gray-900/70 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-cyan-500/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-200">
                Mode par défaut
              </span>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${
                shouldUseLlmPath(llmStatus)
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-red-500/15 text-red-300'
              }`}>
                {shouldUseLlmPath(llmStatus) ? 'LLM actif' : 'Fallback local'}
              </span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-gray-300">
              {shouldUseLlmPath(llmStatus)
                ? "Le prompt part désormais directement vers l'orchestrateur LLM configuré côté serveur."
                : "Le prétest LLM a détecté une indisponibilité : l'assistant local reprend automatiquement le relais."}
              {' '}Une implantation complète inclut mobilier, catalogue et produits.
              Le résultat s’ouvre en 3D dès sa création et reste enregistré.
            </p>
          </div>
          <div className={`rounded-2xl border p-4 ${
            shouldUseLlmPath(llmStatus)
              ? 'border-emerald-800 bg-emerald-950/20'
              : 'border-red-900 bg-red-950/30'
          }`}>
            <p className={`text-[11px] font-semibold uppercase tracking-[0.2em] ${
              shouldUseLlmPath(llmStatus) ? 'text-emerald-300' : 'text-red-300'
            }`}>
              Prétest provider LLM
            </p>
            <p className="mt-2 text-sm leading-relaxed text-gray-200">{llmStatus.message}</p>
            {!shouldUseLlmPath(llmStatus) ? (
              <p className="mt-2 text-xs font-medium text-red-300">
                Critique : vérifiez immédiatement la configuration et la disponibilité du provider.
              </p>
            ) : (
              <p className="mt-2 text-xs font-medium text-emerald-300">
                Provider validé avant envoi : les requêtes LLM peuvent partir.
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <fieldset className="mb-5 rounded-xl border border-gray-600 p-4">
          <legend className="px-1 text-sm font-semibold text-cyan-200">
            Type de demande <span aria-hidden="true">*</span>
          </legend>
          <p className="mb-3 text-xs text-gray-400">
            Obligatoire : choisissez d’abord une catégorie pour orienter la demande et éviter un envoi sans instruction.
          </p>
          <div role="radiogroup" aria-label="Type de demande" className="flex flex-col gap-2">
            {categories.map((option) => (
              <label key={option.id}
                className={`flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2 text-sm ${
                  category === option.id ? 'border-cyan-400 bg-gray-800' : 'border-gray-700 hover:bg-gray-800'
                }`}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="assistant-category" value={option.id} disabled={busy}
                    checked={category === option.id}
                    onChange={() => {
                      setCategory(option.id);
                      setConfirmation(null);
                    }} />
                  <span className="font-medium text-cyan-100">{option.label}</span>
                </span>
                <span className="pl-6 text-xs text-gray-400">{option.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {category && (
          <div className="mb-5 flex flex-col gap-2">
            {categories.find((option) => option.id === category)?.suggestions.map((text) => (
              <button key={text} type="button" disabled={busy}
                onClick={() => setPrompt(text)}
                className="rounded-xl border border-gray-600 px-3 py-3 text-left text-sm text-cyan-200 hover:bg-gray-800 disabled:opacity-50">
                {text}
              </button>
            ))}
          </div>
        )}
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
              {confirmation.viaLlm
                ? 'Seules les opérations de cet aperçu seront confirmées. Vérifiez les étapes avant de continuer.'
                : isPlacementRecommendation(confirmation.text)
                ? 'Les articles seront implantés un par un dans les planogrammes de ce projet.'
                : 'Un nouveau projet sera enregistré. Le projet actuel ne sera pas remplacé.'}
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={busy} onClick={() => void send(confirmation.text, confirmation)}
                className="rounded-lg bg-cyan-400 px-4 py-3 font-medium text-gray-950">
                {confirmation.viaLlm
                  ? 'Confirmer les opérations'
                  : isPlacementRecommendation(confirmation.text) ? 'Exécuter la recommandation' : 'Créer et ouvrir en 3D'}
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
        {!category && (
          <p className="text-xs text-amber-300">
            Choisissez d’abord un type de demande ci-dessus pour pouvoir envoyer.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy || !prompt.trim() || !category}
            className="rounded-xl bg-cyan-400 px-4 py-3 font-semibold text-gray-950 disabled:opacity-50">Envoyer</button>
          <button type="button" disabled={busy} onClick={() => void onSave().catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          })} className="rounded-xl border border-gray-600 px-4 py-3 disabled:opacity-50">Enregistrer</button>
        </div>
      </form>
    </section>
  );
}

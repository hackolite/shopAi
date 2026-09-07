import { useCatalogStore } from '../../store/catalogStore';
import { useSimulationStore } from '../../store/simulationStore';

/** Formats an optional euro amount, "—" when unknown. */
function formatEur(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toFixed(2)} €`;
}

/**
 * « Fiche piéton » shown when an agent is clicked in the 3D scene: its basket
 * with, for every wanted product, whether it was found on the planogram and
 * whether it has already been picked up.
 */
export default function PedestrianDetailPanel() {
  const selectedAgentId = useSimulationStore((state) => state.selectedAgentId);
  const basket = useSimulationStore((state) => state.agentBasket);
  const selectAgent = useSimulationStore((state) => state.selectAgent);
  const products = useCatalogStore((state) => state.products);

  if (selectedAgentId == null) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-gray-500">
        Cliquez sur un piéton dans la scène 3D pour voir son panier.
      </div>
    );
  }

  const priceByEan = new Map(products.map((product) => [product.ean, product.priceSellEur ?? null]));
  const pickedItems = basket?.items.filter((item) => item.picked) ?? [];
  const total = pickedItems.reduce((sum, item) => sum + (priceByEan.get(item.ean) ?? 0), 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Piéton #{basket?.pedestrianId ?? selectedAgentId}
        </h3>
        <button
          onClick={() => selectAgent(null)}
          className="text-xs text-gray-500 hover:text-gray-300"
          title="Fermer"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {!basket && <p className="text-xs text-gray-500">Chargement…</p>}
        {basket && (
          <>
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>{basket.active ? '🟢 En magasin' : '⚪ Sorti'}</span>
              <span>
                {pickedItems.length}/{basket.items.length} pris
              </span>
            </div>
            <ul className="space-y-1.5">
              {basket.items.map((item) => (
                <li
                  key={item.ean}
                  className={[
                    'flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs',
                    item.picked
                      ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
                      : item.found
                        ? 'border-gray-800 bg-gray-900/60 text-gray-300'
                        : 'border-red-900/60 bg-red-950/30 text-red-300',
                  ].join(' ')}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <span>{item.picked ? '✅' : item.found ? '⏳' : '❌'}</span>
                    <span className="truncate">{item.name ?? item.ean}</span>
                  </span>
                  <span className="shrink-0 text-gray-500">
                    {item.picked
                      ? formatEur(priceByEan.get(item.ean))
                      : item.found
                        ? ''
                        : (item.reasonNotFound ?? 'introuvable')}
                  </span>
                </li>
              ))}
              {basket.items.length === 0 && (
                <li className="text-xs text-gray-500">Panier vide (aucun produit demandé).</li>
              )}
            </ul>
            <div className="flex items-center justify-between border-t border-gray-800 pt-2 text-xs font-semibold text-gray-200">
              <span>Total pris</span>
              <span>{formatEur(total)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

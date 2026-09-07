import { useMemo } from 'react';
import { useCatalogStore } from '../../store/catalogStore';
import { useSimulationStore } from '../../store/simulationStore';
import type { AgentBasket } from '../../types/cad';

/** Formats an optional euro amount, "—" when unknown. */
function formatEur(value: number): string {
  return `${value.toFixed(2)} €`;
}

interface JourneyRow {
  basket: AgentBasket;
  pickedCount: number;
  wantedCount: number;
  totalEur: number;
  fullyPurchased: boolean;
}

function buildRows(baskets: AgentBasket[], priceByEan: Map<string, number | null>): JourneyRow[] {
  return baskets
    .map((basket) => {
      const wanted = basket.items.filter((item) => item.found);
      const picked = basket.items.filter((item) => item.picked);
      const totalEur = picked.reduce((sum, item) => sum + (priceByEan.get(item.ean) ?? 0), 0);
      return {
        basket,
        pickedCount: picked.length,
        wantedCount: wanted.length,
        totalEur,
        // "Acheté" = tout ce qui était trouvable sur le planogramme a été pris
        // (aucun circuit de caisse/renoncement n'existe encore dans la simu).
        fullyPurchased: wanted.length > 0 && picked.length === wanted.length,
      };
    })
    .sort((a, b) => a.basket.pedestrianId - b.basket.pedestrianId);
}

/**
 * « Parcours client » : un tableau de tous les piétons vus dans la session,
 * avec ce qui a été pické, ce qui a été acheté (= entièrement pické) et le
 * montant total du panier acheté.
 */
export default function CustomerJourneyPanel() {
  const journeyBaskets = useSimulationStore((state) => state.journeyBaskets);
  const selectAgent = useSimulationStore((state) => state.selectAgent);
  const products = useCatalogStore((state) => state.products);

  const priceByEan = useMemo(
    () => new Map(products.map((product) => [product.ean, product.priceSellEur ?? null])),
    [products],
  );
  const rows = useMemo(() => buildRows(journeyBaskets, priceByEan), [journeyBaskets, priceByEan]);

  const purchasedCount = rows.filter((row) => row.fullyPurchased).length;
  const totalRevenue = rows.reduce((sum, row) => sum + row.totalEur, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-800 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Parcours client</h3>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {rows.length === 0 ? (
          <p className="text-xs text-gray-500">
            Aucun piéton pour le moment. Importez un CSV et chargez-le dans la simulation live.
          </p>
        ) : (
          <>
            <div className="mb-2 grid grid-cols-3 gap-2 text-center text-[11px]">
              <div className="rounded border border-gray-800 bg-gray-950/70 p-2">
                <div className="text-gray-500">Piétons</div>
                <div className="text-sm font-semibold text-gray-200">{rows.length}</div>
              </div>
              <div className="rounded border border-gray-800 bg-gray-950/70 p-2">
                <div className="text-gray-500">Achats complets</div>
                <div className="text-sm font-semibold text-emerald-400">{purchasedCount}</div>
              </div>
              <div className="rounded border border-gray-800 bg-gray-950/70 p-2">
                <div className="text-gray-500">CA cumulé</div>
                <div className="text-sm font-semibold text-gray-200">{formatEur(totalRevenue)}</div>
              </div>
            </div>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-left text-gray-500">
                  <th className="py-1 font-medium">Piéton</th>
                  <th className="py-1 font-medium">Statut</th>
                  <th className="py-1 text-right font-medium">Pické</th>
                  <th className="py-1 text-right font-medium">Acheté</th>
                  <th className="py-1 text-right font-medium">Montant</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.basket.pedestrianId}
                    className="cursor-pointer border-b border-gray-900 text-gray-300 hover:bg-gray-800/60"
                    onClick={() => row.basket.agentId != null && selectAgent(row.basket.agentId)}
                  >
                    <td className="py-1">#{row.basket.pedestrianId}</td>
                    <td className="py-1">{row.basket.active ? '🟢 En magasin' : '⚪ Sorti'}</td>
                    <td className="py-1 text-right">
                      {row.pickedCount}/{row.basket.items.length}
                    </td>
                    <td className="py-1 text-right">{row.fullyPurchased ? '✅' : '—'}</td>
                    <td className="py-1 text-right font-semibold text-gray-100">{formatEur(row.totalEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

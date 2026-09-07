/**
 * Aggregated revenue (« CA ») and margin metric tiles computed from every
 * pedestrian basket seen so far in the running simulation: totals, per-second
 * rates and per-customer averages.
 *
 * Pure functions so they can be unit-tested; consumed by the
 * « Waypoints & rendement » panel tiles and the recorded 3D HUD, mirroring
 * `journeyMetrics.ts` and `yieldMetrics.ts`.
 */
import type { AgentBasket, CADProduct } from '../types/cad';
import { productMarginEur } from './marginHeatmap';

/** Identifier of one aggregated revenue/margin metric tile. */
export type RevenueMetricId =
  | 'total-revenue'
  | 'total-margin'
  | 'margin-per-second'
  | 'revenue-per-second'
  | 'average-margin'
  | 'average-revenue';

/** Order in which the metric tiles are rendered. */
export const REVENUE_METRIC_IDS: RevenueMetricId[] = [
  'total-revenue',
  'total-margin',
  'margin-per-second',
  'revenue-per-second',
  'average-margin',
  'average-revenue',
];

export interface RevenueSummary {
  /** Number of pedestrian baskets included in the aggregation. */
  customerCount: number;
  /** Sum of the sell price of every picked item, in euros. */
  totalRevenueEur: number;
  /** Sum of the exposed margin of every picked item, in euros. */
  totalMarginEur: number;
  /** Total revenue divided by the elapsed simulation time, in €/s. */
  revenuePerSecond: number;
  /** Total margin divided by the elapsed simulation time, in €/s. */
  marginPerSecond: number;
  /** Average revenue per basket, in euros (0 when there is no basket). */
  averageRevenueEur: number;
  /** Average margin per basket, in euros (0 when there is no basket). */
  averageMarginEur: number;
}

/**
 * Aggregate every picked item of every pedestrian basket into plain sums,
 * per-second rates (over the elapsed simulation time) and per-basket
 * averages (0 when there is no basket, never NaN).
 */
export function computeRevenueSummary(
  baskets: AgentBasket[] | null | undefined,
  catalogProducts: CADProduct[] | null | undefined,
  timeSeconds: number,
): RevenueSummary {
  const list = baskets ?? [];
  const productByEan = new Map((catalogProducts ?? []).map((product) => [product.ean, product]));
  let totalRevenueEur = 0;
  let totalMarginEur = 0;
  for (const basket of list) {
    for (const item of basket.items) {
      if (!item.picked) continue;
      const product = productByEan.get(item.ean);
      if (!product) continue;
      if (Number.isFinite(product.priceSellEur)) totalRevenueEur += product.priceSellEur ?? 0;
      totalMarginEur += productMarginEur(product);
    }
  }
  const customerCount = list.length;
  const elapsedSeconds = Math.max(timeSeconds, 1);
  return {
    customerCount,
    totalRevenueEur,
    totalMarginEur,
    revenuePerSecond: totalRevenueEur / elapsedSeconds,
    marginPerSecond: totalMarginEur / elapsedSeconds,
    averageRevenueEur: customerCount > 0 ? totalRevenueEur / customerCount : 0,
    averageMarginEur: customerCount > 0 ? totalMarginEur / customerCount : 0,
  };
}

function formatFr(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('fr-FR', { maximumFractionDigits: digits });
}

/** Short label + formatted value of one metric, shared by tiles and HUD. */
export function revenueMetricDisplay(
  id: RevenueMetricId,
  summary: RevenueSummary,
): { label: string; value: string } {
  switch (id) {
    case 'total-revenue':
      return { label: 'CA total', value: `${formatFr(summary.totalRevenueEur, 0)} €` };
    case 'total-margin':
      return { label: 'Marge totale', value: `${formatFr(summary.totalMarginEur, 0)} €` };
    case 'margin-per-second':
      return { label: 'Marge / s', value: `${formatFr(summary.marginPerSecond, 2)} €/s` };
    case 'revenue-per-second':
      return { label: 'CA / s', value: `${formatFr(summary.revenuePerSecond, 2)} €/s` };
    case 'average-margin':
      return { label: 'Marge moy. / client', value: `${formatFr(summary.averageMarginEur, 2)} €` };
    case 'average-revenue':
      return { label: 'CA moy. / client', value: `${formatFr(summary.averageRevenueEur, 2)} €` };
  }
}

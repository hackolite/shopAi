/**
 * Exposed-margin (« rendement ») metric tiles: exposed margin (€), exposed
 * flow (clients counted in the exposed-margin computation), the same flow per
 * second, and the yield (€ of exposed margin per second).
 *
 * Pure display helpers so they can be unit-tested; consumed by the
 * « Waypoints & rendement » panel tiles and the recorded 3D HUD, mirroring
 * `journeyMetrics.ts` for the customer-journey tiles.
 */
import type { AbsoluteYieldStats } from './absoluteYield';

/** Identifier of one exposed-margin metric tile. */
export type YieldMetricId =
  | 'exposed-margin'
  | 'exposed-flow'
  | 'exposed-flow-per-second'
  | 'yield-eur-per-second';

/** Order in which the metric tiles are rendered. */
export const YIELD_METRIC_IDS: YieldMetricId[] = [
  'exposed-margin',
  'exposed-flow',
  'exposed-flow-per-second',
  'yield-eur-per-second',
];

function formatFr(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('fr-FR', { maximumFractionDigits: digits });
}

/** Short label + formatted value of one metric, shared by tiles and HUD. */
export function yieldMetricDisplay(
  id: YieldMetricId,
  stats: AbsoluteYieldStats | null,
): { label: string; value: string } {
  switch (id) {
    case 'exposed-margin':
      return { label: 'Marge exposée', value: stats ? `${formatFr(stats.exposedMarginEur, 0)} €` : '—' };
    case 'exposed-flow':
      return { label: 'Flux exposé', value: stats ? `${formatFr(stats.exposedPassages, 0)} clients` : '—' };
    case 'exposed-flow-per-second':
      return { label: 'Flux exposé / s', value: stats ? `${formatFr(stats.exposedFlowPerSecond, 2)} pers/s` : '—' };
    case 'yield-eur-per-second':
      return { label: 'Rendement', value: stats ? `${formatFr(stats.totalEurPerSecond, 2)} €/s` : '—' };
  }
}

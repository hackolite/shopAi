/**
 * Aggregated customer-journey metrics.
 *
 * Distance and time metrics are computed only on customers that completed the
 * full path (entry + exit).
 *
 * Pure functions so they can be unit-tested; consumed by the
 * « Waypoints & rendement » panel tiles and the recorded 3D HUD.
 */
import type { CustomerJourney } from '../types/cad';

/** Identifier of one aggregated journey metric tile. */
export type JourneyMetricId =
  | 'total-distance'
  | 'total-time'
  | 'average-distance'
  | 'average-time';

export interface JourneySummary {
  /** Number of customers included in the aggregation. */
  customerCount: number;
  /** Number of customers that completed the full entry → exit journey. */
  completedCustomerCount: number;
  /** Sum of the distance travelled by completed customers, in metres. */
  totalDistanceM: number;
  /** Sum of the time spent in store by completed customers, in seconds. */
  totalTimeSeconds: number;
  /** Average distance travelled per completed customer, in metres (0 when none). */
  averageDistanceM: number;
  /** Average time spent in store per completed customer, in seconds (0 when none). */
  averageTimeSeconds: number;
}

/** Order in which the metric tiles are rendered. */
export const JOURNEY_METRIC_IDS: JourneyMetricId[] = [
  'total-distance',
  'total-time',
  'average-distance',
  'average-time',
];

/**
 * Aggregate the customer journeys into plain sums and per-customer averages.
 * Totals are simple additions of rows.
 * Distance and time metrics use completed customers only
 * (0 when the relevant denominator is empty, never NaN).
 */
export function computeJourneySummary(customers: CustomerJourney[] | null | undefined): JourneySummary {
  const list = customers ?? [];
  let totalDistanceCm = 0;
  let totalTimeSeconds = 0;
  let completedCustomerCount = 0;
  for (const customer of list) {
    const completedJourney =
      customer.exitTimeSeconds != null &&
      Number.isFinite(customer.exitTimeSeconds) &&
      customer.active === false;
    if (completedJourney) {
      completedCustomerCount += 1;
      if (Number.isFinite(customer.distanceCm)) totalDistanceCm += customer.distanceCm;
      if (Number.isFinite(customer.totalTimeSeconds)) totalTimeSeconds += customer.totalTimeSeconds;
    }
  }
  const customerCount = list.length;
  const totalDistanceM = totalDistanceCm / 100;
  return {
    customerCount,
    completedCustomerCount,
    totalDistanceM,
    totalTimeSeconds,
    averageDistanceM: completedCustomerCount > 0 ? totalDistanceM / completedCustomerCount : 0,
    averageTimeSeconds: completedCustomerCount > 0 ? totalTimeSeconds / completedCustomerCount : 0,
  };
}

function formatFr(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('fr-FR', { maximumFractionDigits: digits });
}

/** Seconds → compact French duration ("45 s" or "2 min 05 s"). */
export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${formatFr(seconds, 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes} min ${String(rest).padStart(2, '0')} s`;
}

/** Metres → compact French distance ("824 m" or "1,2 km"). */
export function formatDistanceM(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  if (metres >= 1000) return `${formatFr(metres / 1000, 1)} km`;
  return `${formatFr(metres, metres < 10 ? 1 : 0)} m`;
}

/** Short label + formatted value of one metric, shared by tiles and HUD. */
export function journeyMetricDisplay(
  id: JourneyMetricId,
  summary: JourneySummary,
): { label: string; value: string } {
  switch (id) {
    case 'total-distance':
      return { label: 'Distance totale', value: formatDistanceM(summary.totalDistanceM) };
    case 'total-time':
      return { label: 'Temps total en magasin', value: formatDurationSeconds(summary.totalTimeSeconds) };
    case 'average-distance':
      return { label: 'Distance moy. / client', value: formatDistanceM(summary.averageDistanceM) };
    case 'average-time':
      return { label: 'Temps moy. / client', value: formatDurationSeconds(summary.averageTimeSeconds) };
  }
}

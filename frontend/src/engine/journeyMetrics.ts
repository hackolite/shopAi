/**
 * Aggregated customer-journey metrics: totals and per-customer averages over
 * every customer of the running simulation (active and exited alike).
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
  /** Sum of the distance travelled by every customer, in metres. */
  totalDistanceM: number;
  /** Sum of the time spent in store by every customer, in seconds. */
  totalTimeSeconds: number;
  /** Average distance travelled per customer, in metres (0 when no customer). */
  averageDistanceM: number;
  /** Average time spent in store per customer, in seconds (0 when no customer). */
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
 * Totals are simple additions of the rows; averages divide by the customer
 * count (0 when there is no customer, never NaN).
 */
export function computeJourneySummary(customers: CustomerJourney[] | null | undefined): JourneySummary {
  const list = customers ?? [];
  let totalDistanceCm = 0;
  let totalTimeSeconds = 0;
  for (const customer of list) {
    if (Number.isFinite(customer.distanceCm)) totalDistanceCm += customer.distanceCm;
    if (Number.isFinite(customer.totalTimeSeconds)) totalTimeSeconds += customer.totalTimeSeconds;
  }
  const customerCount = list.length;
  const totalDistanceM = totalDistanceCm / 100;
  return {
    customerCount,
    totalDistanceM,
    totalTimeSeconds,
    averageDistanceM: customerCount > 0 ? totalDistanceM / customerCount : 0,
    averageTimeSeconds: customerCount > 0 ? totalTimeSeconds / customerCount : 0,
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

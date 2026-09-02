import type { Planogram } from '../types/cad';

/**
 * Implantation metrics of an assortment (catmanager point of view).
 *
 * A *facing* is one product slot on a shelf; several facings can carry the same
 * EAN, so the number of **distinct products** implanted is always lower than or
 * equal to the number of facings. Both are needed: facings measure the occupied
 * linear, distinct products measure the breadth of the assortment offered.
 */
export interface ImplantationMetrics {
  /** Distinct EANs implanted at least once. */
  distinctProducts: number;
  /** Total number of product slots (facings) implanted. */
  facings: number;
  /** Planograms carrying at least one facing. */
  filledPlanograms: number;
  /** Planograms taken into account (including empty ones). */
  planograms: number;
  /** Average number of facings per distinct product implanted. */
  averageFacingsPerProduct: number;
}

/** Compute the implantation metrics of a set of planograms. */
export function computeImplantationMetrics(
  planograms: Iterable<Planogram>,
): ImplantationMetrics {
  const eans = new Set<string>();
  let facings = 0;
  let filledPlanograms = 0;
  let planogramCount = 0;
  for (const planogram of planograms) {
    planogramCount += 1;
    if (planogram.cells.length > 0) filledPlanograms += 1;
    for (const cell of planogram.cells) {
      facings += 1;
      if (cell.ean) eans.add(cell.ean);
    }
  }
  return {
    distinctProducts: eans.size,
    facings,
    filledPlanograms,
    planograms: planogramCount,
    averageFacingsPerProduct: eans.size > 0 ? facings / eans.size : 0,
  };
}

/**
 * Share of the catalog actually implanted, in percent.
 * Returns 0 when the catalog is empty, so the caller never divides by zero.
 */
export function catalogCoveragePct(distinctProducts: number, catalogSize: number): number {
  if (catalogSize <= 0) return 0;
  return (distinctProducts / catalogSize) * 100;
}

/** Metrics restricted to the planograms mounted on one piece of furniture. */
export function computeFurnitureMetrics(
  planograms: Iterable<Planogram>,
  furnitureId: string,
): ImplantationMetrics {
  const owned: Planogram[] = [];
  for (const planogram of planograms) {
    if (planogram.furnitureId === furnitureId) owned.push(planogram);
  }
  return computeImplantationMetrics(owned);
}

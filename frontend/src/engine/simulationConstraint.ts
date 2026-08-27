import type { SimulationWaypoint } from '../types/cad';

const MAX_CONSTRAINT_EDGE_DISTANCE_CM = 250;
const MIN_WAYPOINT_RADIUS_CM = 40;
const CONSTRAINT_ERROR_PATTERN = /Agent\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*too close to geometry boundaries/i;

export interface ConstraintCorrection {
  message: string;
  waypointId: string | null;
  currentXcm: number | null;
  currentZcm: number | null;
  suggestedXcm: number | null;
  suggestedZcm: number | null;
}

export function extractConstraintDetail(raw: string): unknown {
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) return raw;
  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as { detail?: unknown };
    return parsed.detail ?? raw;
  } catch {
    return raw;
  }
}

export function extractConstraintPoint(error: unknown): { xM: number; zM: number } | null {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = extractConstraintDetail(raw);
  if (typeof detail !== 'string') return null;
  const match = detail.match(CONSTRAINT_ERROR_PATTERN);
  if (!match) return null;
  const xM = Number(match[1]);
  const zM = Number(match[2]);
  if (!Number.isFinite(xM) || !Number.isFinite(zM)) return null;
  return { xM, zM };
}

export function extractConstraintCorrection(error: unknown): ConstraintCorrection | null {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = extractConstraintDetail(raw);
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  if (typeof record.message !== 'string') return null;
  return {
    message: record.message,
    waypointId: typeof record.waypointId === 'string' ? record.waypointId : null,
    currentXcm: typeof record.currentXcm === 'number' ? record.currentXcm : null,
    currentZcm: typeof record.currentZcm === 'number' ? record.currentZcm : null,
    suggestedXcm: typeof record.suggestedXcm === 'number' ? record.suggestedXcm : null,
    suggestedZcm: typeof record.suggestedZcm === 'number' ? record.suggestedZcm : null,
  };
}

export function hasDistinctConstraintSuggestion(correction: ConstraintCorrection, minDistanceCm = 1): boolean {
  if (correction.suggestedXcm == null || correction.suggestedZcm == null) return false;
  if (correction.currentXcm == null || correction.currentZcm == null) return false;
  return Math.hypot(
    correction.suggestedXcm - correction.currentXcm,
    correction.suggestedZcm - correction.currentZcm,
  ) >= minDistanceCm;
}

export function formatConstraintCorrection(correction: ConstraintCorrection): string {
  if (!hasDistinctConstraintSuggestion(correction)) return correction.message;
  return `${correction.message}\nCorrection proposée : X=${correction.suggestedXcm} cm, Z=${correction.suggestedZcm} cm.`;
}

export function pickClosestWaypointId(
  point: { xM: number; zM: number },
  waypoints: SimulationWaypoint[],
): string | null {
  const targetXCm = point.xM * 100;
  const targetZCm = point.zM * 100;
  let bestId: string | null = null;
  let bestEdgeDistance = Number.POSITIVE_INFINITY;
  let bestCenterDistance = Number.POSITIVE_INFINITY;

  for (const waypoint of waypoints) {
    const dx = waypoint.x - targetXCm;
    const dz = waypoint.z - targetZCm;
    const distanceCm = Math.hypot(dx, dz);
    const edgeDistanceCm = Math.max(0, distanceCm - Math.max(MIN_WAYPOINT_RADIUS_CM, waypoint.radiusCm));
    if (
      edgeDistanceCm < bestEdgeDistance
      || (edgeDistanceCm === bestEdgeDistance && distanceCm < bestCenterDistance)
    ) {
      bestEdgeDistance = edgeDistanceCm;
      bestCenterDistance = distanceCm;
      bestId = waypoint.id;
    }
  }

  return bestEdgeDistance <= MAX_CONSTRAINT_EDGE_DISTANCE_CM ? bestId : null;
}

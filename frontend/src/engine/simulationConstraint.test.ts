import { describe, expect, it } from 'vitest';
import {
  extractConstraintDetail,
  extractConstraintCorrection,
  extractConstraintPoint,
  formatConstraintCorrection,
  hasDistinctConstraintSuggestion,
  pickClosestWaypointId,
} from './simulationConstraint';

describe('simulationConstraint', () => {
  it('extracts JSON detail payloads from API errors', () => {
    expect(extractConstraintDetail('[422] {"detail":"Erreur brute"}')).toBe('Erreur brute');
  });

  it('parses legacy geometry boundary error coordinates', () => {
    expect(extractConstraintPoint(new Error('Agent(12.5, 9.75) too close to geometry boundaries'))).toEqual({ xM: 12.5, zM: 9.75 });
  });

  it('hides redundant waypoint corrections when the suggested point is unchanged', () => {
    const correction = extractConstraintCorrection(new Error('[422] {"detail":{"message":"Waypoint invalide","waypointId":"wp-1","currentXcm":1200,"currentZcm":800,"suggestedXcm":1200,"suggestedZcm":800}}'));
    expect(correction).not.toBeNull();
    expect(hasDistinctConstraintSuggestion(correction!)).toBe(false);
    expect(formatConstraintCorrection(correction!)).toBe('Waypoint invalide');
  });

  it('keeps distinct waypoint corrections when the suggested point actually moves', () => {
    const correction = extractConstraintCorrection(new Error('[422] {"detail":{"message":"Waypoint invalide","waypointId":"wp-1","currentXcm":1200,"currentZcm":800,"suggestedXcm":1235,"suggestedZcm":800}}'));
    expect(correction).not.toBeNull();
    expect(hasDistinctConstraintSuggestion(correction!)).toBe(true);
    expect(formatConstraintCorrection(correction!)).toContain('Correction proposée : X=1235 cm, Z=800 cm.');
  });

  it('matches the closest waypoint from a reported geometry point', () => {
    expect(pickClosestWaypointId(
      { xM: 12.1, zM: 8 },
      [
        { id: 'far', label: 'Far', type: 'transit', x: 2200, z: 800, radiusCm: 120, optional: false, visitProbability: 1, retentionSeconds: 0, visionAngleDeg: 70, visionRangeCm: 220 },
        { id: 'near', label: 'Near', type: 'transit', x: 1200, z: 800, radiusCm: 120, optional: false, visitProbability: 1, retentionSeconds: 0, visionAngleDeg: 70, visionRangeCm: 220 },
      ],
    )).toBe('near');
  });
});

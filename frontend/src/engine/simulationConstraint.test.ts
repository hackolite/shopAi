import { describe, expect, it } from 'vitest';
import {
  extractConstraintCorrection,
  formatConstraintCorrection,
  hasDistinctConstraintSuggestion,
} from './simulationConstraint';

describe('simulationConstraint', () => {
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
});

import { describe, expect, it } from 'vitest';
import { isSessionNotFoundError } from './liveSession';

describe('isSessionNotFoundError', () => {
  it('returns true for API errors with a [404] status prefix', () => {
    expect(isSessionNotFoundError(new Error('[404] {"detail":"Unknown live simulation session"}'))).toBe(true);
  });

  it('returns false for other API error statuses', () => {
    expect(isSessionNotFoundError(new Error('[400] {"detail":"invalid waypoint"}'))).toBe(false);
    expect(isSessionNotFoundError(new Error('[500] Internal Server Error'))).toBe(false);
  });

  it('returns false for network errors and non-Error values', () => {
    expect(isSessionNotFoundError(new Error('Failed to fetch'))).toBe(false);
    expect(isSessionNotFoundError('404')).toBe(false);
    expect(isSessionNotFoundError(null)).toBe(false);
    expect(isSessionNotFoundError(undefined)).toBe(false);
  });
});

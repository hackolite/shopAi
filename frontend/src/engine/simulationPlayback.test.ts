import { describe, expect, it } from 'vitest';
import {
  advancePlaybackClock,
  clampMonotonicTime,
  clampNoReverseStep,
  resolveSimulationTime,
  type PlaybackClockOptions,
} from './simulationPlayback';

describe('resolveSimulationTime', () => {
  it('clamps to simulation end instead of looping', () => {
    expect(resolveSimulationTime(12.4, 10)).toBe(10);
  });

  it('keeps elapsed time within bounds during playback', () => {
    expect(resolveSimulationTime(3.5, 10)).toBe(3.5);
  });

  it('guards against negative elapsed values', () => {
    expect(resolveSimulationTime(-2, 10)).toBe(0);
  });

  it('returns elapsed time when duration is not positive', () => {
    expect(resolveSimulationTime(5, 0)).toBe(5);
  });
});

describe('clampNoReverseStep', () => {
  it('keeps forward movement unchanged', () => {
    expect(clampNoReverseStep(1, 2, 4, 2, 1, 0)).toEqual({ x: 4, z: 2 });
  });

  it('removes pure backward movement', () => {
    expect(clampNoReverseStep(4, 2, 1, 2, 1, 0)).toEqual({ x: 4, z: 2 });
  });

  it('preserves lateral correction while removing backward drift', () => {
    expect(clampNoReverseStep(4, 2, 3, 5, 1, 0)).toEqual({ x: 4, z: 5 });
  });

  it('falls back to the proposed position when no forward direction is available', () => {
    expect(clampNoReverseStep(4, 2, 1, 5, 0, 0)).toEqual({ x: 1, z: 5 });
  });
});

describe('clampMonotonicTime', () => {
  it('never lets playback time go backward', () => {
    expect(clampMonotonicTime(8.4, 7.9)).toBe(8.4);
  });

  it('accepts newer frame times', () => {
    expect(clampMonotonicTime(8.4, 8.9)).toBe(8.9);
  });
});

describe('advancePlaybackClock', () => {
  const options: PlaybackClockOptions = {
    targetBufferSeconds: 0.2,
    minRate: 0.25,
    maxRate: 1.6,
    rateStiffness: 3,
    maxExtrapolationSeconds: 0.2,
    resnapThresholdSeconds: 1,
  };

  it('initialises to the ideal buffered point when uninitialised', () => {
    expect(advancePlaybackClock(-1, 0.016, 5, options)).toBeCloseTo(4.8, 6);
  });

  it('advances at roughly real time when perfectly buffered', () => {
    // previous is exactly the ideal point, so rate stays at 1.0.
    const next = advancePlaybackClock(4.8, 0.1, 5, options);
    expect(next).toBeCloseTo(4.9, 6);
  });

  it('speeds up (but stays capped) to consume a frame backlog', () => {
    // Far behind the ideal point → rate saturates at maxRate.
    const next = advancePlaybackClock(4.0, 0.1, 5, options);
    expect(next).toBeCloseTo(4.0 + 1.6 * 0.1, 6);
  });

  it('keeps moving forward at the minimum rate when the buffer is exhausted', () => {
    // Render time is well past the ideal point, so the rate floors at minRate
    // but never reaches zero: motion continues instead of freezing.
    const previous = 5.05;
    const next = advancePlaybackClock(previous, 0.1, 5, options);
    expect(next).toBeGreaterThanOrEqual(previous + options.minRate * 0.1);
  });

  it('never advances past the extrapolation ceiling', () => {
    const next = advancePlaybackClock(5.19, 0.1, 5, options);
    expect(next).toBeLessThanOrEqual(5 + options.maxExtrapolationSeconds);
  });

  it('never reverses when the newest frame time drops slightly', () => {
    const next = advancePlaybackClock(5.0, 0.1, 4.9, options);
    expect(next).toBeGreaterThanOrEqual(5.0);
  });

  it('never reverses when previous is already past the extrapolation ceiling', () => {
    // previous = 5.3, ceiling = 5.0 + 0.2 = 5.2 → previous > ceiling.
    // The old formula (min(ceil, max(prev, adv))) would return 5.2 < 5.3 (backwards).
    // The corrected formula must keep the clock at or above 5.3.
    const next = advancePlaybackClock(5.3, 0.1, 5.0, options);
    expect(next).toBeGreaterThanOrEqual(5.3);
  });

  it('hard-snaps forward after a large desync (e.g. backgrounded tab)', () => {
    expect(advancePlaybackClock(2.0, 0.1, 10, options)).toBeCloseTo(9.8, 6);
  });

  it('hard-snaps back when the server session resets behind the clock', () => {
    expect(advancePlaybackClock(20, 0.1, 3, options)).toBeCloseTo(2.8, 6);
  });
});

import { describe, expect, it } from 'vitest';
import { clampMonotonicTime, clampNoReverseStep, resolveSimulationTime } from './simulationPlayback';

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

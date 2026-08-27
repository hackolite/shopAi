import { describe, expect, it } from 'vitest';
import { resolveSimulationTime } from './simulationPlayback';

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
});

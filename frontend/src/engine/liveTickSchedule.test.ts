import { describe, expect, it } from 'vitest';
import { planLiveTick, type LiveTickScheduleOptions } from './liveTickSchedule';

const OPTIONS: LiveTickScheduleOptions = {
  intervalMs: 100,
  maxCatchUpSteps: 50,
  maxBacklogSteps: 50,
};

describe('planLiveTick', () => {
  it('requests a single step on a nominal tick', () => {
    const plan = planLiveTick(1_000, 900, OPTIONS);
    expect(plan.steps).toBe(1);
    expect(plan.nextTickAt).toBe(1_000);
  });

  it('starts the cursor at now when it is not initialised', () => {
    const plan = planLiveTick(5_000, null, OPTIONS);
    expect(plan.steps).toBe(1);
    expect(plan.nextTickAt).toBe(5_100);
  });

  it('catches a short hiccup up without dropping time', () => {
    const plan = planLiveTick(2_000, 1_000, OPTIONS);
    expect(plan.steps).toBe(10);
    expect(plan.nextTickAt).toBe(2_000);
  });

  it('caps a single request and keeps the recoverable debt', () => {
    // 8 s late: 80 steps requested-worth of debt, capped at 50 for this call,
    // the remaining 30 steps stay in the cursor for the next ticks.
    const plan = planLiveTick(9_000, 1_000, OPTIONS);
    expect(plan.steps).toBe(50);
    expect(plan.nextTickAt).toBe(6_000);
  });

  it('drops the unrecoverable debt of a long backgrounded tab', () => {
    // Tab hidden for 3 hours: replaying it would fast-forward the simulation at
    // ~50x for hours, resnapping the render clock (agent teleportation).
    const threeHoursMs = 3 * 60 * 60 * 1_000;
    const plan = planLiveTick(threeHoursMs, 0, OPTIONS);
    expect(plan.steps).toBe(50);
    expect(plan.nextTickAt).toBe(threeHoursMs - 5_000);
  });

  it('never moves the cursor backwards', () => {
    const plan = planLiveTick(1_000, 1_000, OPTIONS);
    expect(plan.nextTickAt).toBeGreaterThanOrEqual(1_000);
  });
});

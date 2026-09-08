export interface LiveTickScheduleOptions {
  /** Nominal simulated duration of one backend step, in milliseconds. */
  intervalMs: number;
  /** Maximum number of steps a single tick request may ask for. */
  maxCatchUpSteps: number;
  /**
   * Maximum accumulated debt (in steps) the client is allowed to keep after a
   * tick. Anything older is dropped instead of being replayed later.
   */
  maxBacklogSteps: number;
}

export interface LiveTickPlan {
  /** Steps to request from the backend for this tick. */
  steps: number;
  /** New value for the tick cursor (`lastTickAt`). */
  nextTickAt: number;
}

/**
 * Plans one live-simulation tick, catching the simulation clock up with real
 * time *without* letting the backlog grow without bound.
 *
 * Background/hidden tabs throttle `setInterval` (down to one call per minute),
 * so the client can only request `maxCatchUpSteps` per throttled tick while
 * real time keeps running. Left unbounded, the missed time accumulates as debt:
 * a tab hidden for hours comes back and then replays that debt at
 * `maxCatchUpSteps` per 100 ms — the simulation fast-forwards at ~50x real time
 * for a very long while, which makes the render playback clock resnap on nearly
 * every frame and the agents visibly teleport again and again.
 *
 * Clamping the cursor to `now - maxBacklogSteps * intervalMs` keeps the normal
 * short-hiccup catch-up (a few dropped frames, a stalled request) while
 * discarding the unrecoverable debt of a long background period, so playback
 * returns to real-time speed as soon as the tab is visible again.
 */
export function planLiveTick(
  now: number,
  lastTickAt: number | null,
  options: LiveTickScheduleOptions,
): LiveTickPlan {
  const { intervalMs, maxCatchUpSteps, maxBacklogSteps } = options;
  const previousTickAt = lastTickAt ?? now;
  const elapsedSteps = Math.max(1, Math.round((now - previousTickAt) / intervalMs));
  const steps = Math.min(maxCatchUpSteps, elapsedSteps);
  const advancedTickAt = previousTickAt + steps * intervalMs;
  const oldestKeptTickAt = now - Math.max(0, maxBacklogSteps) * intervalMs;
  return { steps, nextTickAt: Math.max(advancedTickAt, oldestKeptTickAt) };
}

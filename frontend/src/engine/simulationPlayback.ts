export function resolveSimulationTime(elapsedSeconds: number, totalDurationSeconds: number): number {
  const elapsed = Math.max(0, elapsedSeconds);
  if (totalDurationSeconds <= 0) return elapsed;
  return Math.min(elapsed, totalDurationSeconds);
}

export function clampMonotonicTime(previousSeconds: number, nextSeconds: number): number {
  return Math.max(previousSeconds, nextSeconds);
}

export interface PlaybackClockOptions {
  /** Desired render lag behind the newest available frame, in seconds. */
  targetBufferSeconds: number;
  /** Minimum playback speed multiplier. Must stay above 0 so motion never fully stops. */
  minRate: number;
  /** Maximum playback speed multiplier used to consume a frame backlog. */
  maxRate: number;
  /** Proportional gain (1/s) mapping the buffer error onto the rate correction. */
  rateStiffness: number;
  /** Extra seconds the clock may run past the newest frame before it is capped. */
  maxExtrapolationSeconds: number;
  /** Desync (seconds) above which the clock hard-snaps to the ideal point. */
  resnapThresholdSeconds: number;
}

/**
 * Advances a self-regulating playback clock for live simulation rendering.
 *
 * Instead of pinning render time to the wall clock (which stutters when the
 * jittery frame supply lags real time), the clock keeps a small buffer behind
 * the newest frame and gently speeds up or slows down to stay there. Because the
 * rate stays strictly positive and the time is monotonic, playback is fluid with
 * no rhythmic freezes and no reverse motion.
 *
 * A negative `previousRenderTime` marks an uninitialised clock and snaps to the
 * ideal starting point.
 */
export function advancePlaybackClock(
  previousRenderTime: number,
  deltaSeconds: number,
  latestFrameTime: number,
  options: PlaybackClockOptions,
): number {
  const {
    targetBufferSeconds,
    minRate,
    maxRate,
    rateStiffness,
    maxExtrapolationSeconds,
    resnapThresholdSeconds,
  } = options;

  const idealRenderTime = Math.max(0, latestFrameTime - targetBufferSeconds);
  const delta = Math.max(0, deltaSeconds);

  // Uninitialised clock, or a large desync (tab backgrounded, new session,
  // server reset): jump straight to the ideal point rather than crawling or
  // racing across the whole gap.
  if (
    previousRenderTime < 0 ||
    idealRenderTime - previousRenderTime > resnapThresholdSeconds ||
    previousRenderTime - latestFrameTime > resnapThresholdSeconds
  ) {
    return idealRenderTime;
  }

  const bufferError = idealRenderTime - previousRenderTime;
  const rate = Math.min(maxRate, Math.max(minRate, 1 + rateStiffness * bufferError));
  const advanced = previousRenderTime + rate * delta;
  const ceiling = latestFrameTime + Math.max(0, maxExtrapolationSeconds);

  // Never reverse (monotonic) and never overrun the bounded extrapolation ceiling.
  // Using Math.max(previous, Math.min(ceiling, advanced)) instead of
  // Math.min(ceiling, Math.max(previous, advanced)) so the clock stays monotonic
  // even when previousRenderTime > ceiling (e.g. after a hot-update shrinks the
  // ceiling).  The old order could return ceiling < previousRenderTime, reversing
  // the clock and causing agents to jump backwards.
  return Math.max(previousRenderTime, Math.min(ceiling, advanced));
}

export function clampNoReverseStep(
  previousX: number,
  previousZ: number,
  nextX: number,
  nextZ: number,
  forwardX: number,
  forwardZ: number,
): { x: number; z: number } {
  const forwardLength = Math.hypot(forwardX, forwardZ);
  if (forwardLength <= 1e-9) return { x: nextX, z: nextZ };

  const unitForwardX = forwardX / forwardLength;
  const unitForwardZ = forwardZ / forwardLength;
  const deltaX = nextX - previousX;
  const deltaZ = nextZ - previousZ;
  const forwardDelta = deltaX * unitForwardX + deltaZ * unitForwardZ;

  if (forwardDelta >= 0) return { x: nextX, z: nextZ };

  return {
    x: nextX - unitForwardX * forwardDelta,
    z: nextZ - unitForwardZ * forwardDelta,
  };
}

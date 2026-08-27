export function resolveSimulationTime(elapsedSeconds: number, totalDurationSeconds: number): number {
  const elapsed = Math.max(0, elapsedSeconds);
  if (totalDurationSeconds <= 0) return elapsed;
  return Math.min(elapsed, totalDurationSeconds);
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

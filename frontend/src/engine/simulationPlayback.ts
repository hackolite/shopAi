export function resolveSimulationTime(elapsedSeconds: number, totalDurationSeconds: number): number {
  const elapsed = Math.max(0, elapsedSeconds);
  if (totalDurationSeconds <= 0) return elapsed;
  return Math.min(elapsed, totalDurationSeconds);
}

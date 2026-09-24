import type { AgentTrajectory } from '../types/cad';

export function visibleTrajectoryOverlayTrajectories(trajectories: AgentTrajectory[]) {
  return trajectories.filter((trajectory) => !trajectory.active);
}

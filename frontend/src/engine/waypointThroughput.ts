import type { WaypointSample } from '../types/cad';

/** One point of the raw (non-normalised) throughput series of a waypoint. */
export interface ThroughputPoint {
  timeSeconds: number;
  /** Agents released by the waypoint per second over the last interval. */
  agentsPerSecond: number;
}

export interface ThroughputSeries {
  points: ThroughputPoint[];
  /** Throughput (ag/s) of the most recent interval. */
  currentAgentsPerSecond: number;
  /** Highest throughput (ag/s) observed on the window. */
  maxAgentsPerSecond: number;
}

/**
 * Derive the raw throughput of a waypoint from its cumulative
 * `releasedAgents` samples: Δreleased / Δt, in agents per second.
 *
 * The value is intentionally **not normalised**: it keeps its physical unit so
 * waypoints (and successive runs) can be compared in absolute terms.  Samples
 * with a non-positive Δt, or a decreasing counter (the backend only keeps a
 * window of samples, and a restarted session resets the counter), are skipped.
 */
export function waypointThroughput(samples: WaypointSample[]): ThroughputSeries {
  const points: ThroughputPoint[] = [];
  let maxAgentsPerSecond = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    const deltaTime = current.timeSeconds - previous.timeSeconds;
    const deltaReleased = current.releasedAgents - previous.releasedAgents;
    if (!(deltaTime > 0) || deltaReleased < 0) continue;
    const agentsPerSecond = deltaReleased / deltaTime;
    points.push({ timeSeconds: current.timeSeconds, agentsPerSecond });
    if (agentsPerSecond > maxAgentsPerSecond) maxAgentsPerSecond = agentsPerSecond;
  }
  return {
    points,
    currentAgentsPerSecond: points.length > 0 ? points[points.length - 1].agentsPerSecond : 0,
    maxAgentsPerSecond,
  };
}

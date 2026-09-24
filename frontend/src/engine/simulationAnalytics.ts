import type { SimulationAnalytics, SimulationAnalyticsDelta } from '../types/cad';

function applyHeatmapDelta(
  source: SimulationAnalytics['heatmap'] | undefined | null,
  deltas: { index: number; delta: number }[],
) {
  if (!source) return source ?? null;
  if (deltas.length === 0) return source;
  const counts = [...source.counts];
  let maxCount = source.maxCount;
  for (const { index, delta } of deltas) {
    if (index < 0 || index >= counts.length) continue;
    counts[index] += delta;
    if (counts[index] > maxCount) maxCount = counts[index];
  }
  return { ...source, counts, maxCount };
}

export function applyAnalyticsDelta(base: SimulationAnalytics, delta: SimulationAnalyticsDelta): SimulationAnalytics {
  const trajectoriesByAgent = new Map(base.trajectories.map((item) => [item.agentId, { ...item, pointsCm: [...item.pointsCm] }]));
  for (const agentId of delta.removedTrajectoryAgentIds ?? []) trajectoriesByAgent.delete(agentId);
  for (const trajectory of delta.trajectoryReplacements ?? []) {
    trajectoriesByAgent.set(trajectory.agentId, { ...trajectory, pointsCm: [...trajectory.pointsCm] });
  }
  for (const append of delta.trajectoryAppends) {
    const existing = trajectoriesByAgent.get(append.agentId);
    if (existing) {
      existing.pointsCm.push(...append.appendPointsCm);
    } else {
      trajectoriesByAgent.set(append.agentId, {
        agentId: append.agentId,
        active: true,
        pointsCm: [...append.appendPointsCm],
      });
    }
  }
  for (const agentId of delta.deactivatedTrajectoryAgentIds) {
    const existing = trajectoriesByAgent.get(agentId);
    if (existing) existing.active = false;
  }
  const customers = new Map((base.customers ?? []).map((item) => [item.customerId, item]));
  for (const customerId of delta.removedCustomerIds ?? []) customers.delete(customerId);
  for (const customer of delta.customerUpdates) customers.set(customer.customerId, customer);
  return {
    ...base,
    timeSeconds: delta.timeSeconds,
    heatmap: applyHeatmapDelta(base.heatmap, delta.occupancyIncrements),
    visitHeatmap: applyHeatmapDelta(base.visitHeatmap ?? null, delta.visitIncrements),
    trajectories: Array.from(trajectoriesByAgent.values()),
    customers: Array.from(customers.values()),
  };
}

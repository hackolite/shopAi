import { describe, expect, it } from 'vitest';
import { visibleWaypointSystems } from './SimulationLayer';
import { visibleTrajectoryOverlayTrajectories } from '../engine/trajectoryOverlay';
import { defaultSimulationConfig } from '../store/simulationStore';

describe('visibleWaypointSystems', () => {
  it('returns all JuPedSim systems so every waypoint stays visible', () => {
    const systems = visibleWaypointSystems({
      ...defaultSimulationConfig(),
      activeWaypointSystemId: 'sys-1',
      waypointSystems: [
        {
          id: 'sys-1',
          label: 'System 1',
          color: '#111111',
          waypoints: [{ id: 'w1', label: 'A', type: 'entry', x: 0, z: 0, radiusCm: 100, optional: false, visitProbability: 1, retentionSeconds: 0, visionAngleDeg: 70, visionRangeCm: 220 }],
        },
        {
          id: 'sys-2',
          label: 'System 2',
          color: '#222222',
          waypoints: [{ id: 'w2', label: 'B', type: 'exit', x: 10, z: 10, radiusCm: 100, optional: false, visitProbability: 1, retentionSeconds: 0, visionAngleDeg: 70, visionRangeCm: 220 }],
        },
      ],
      waypoints: [],
    });

    expect(systems).toHaveLength(2);
    expect(systems.flatMap((system) => system.waypoints).map((waypoint) => waypoint.id)).toEqual(['w1', 'w2']);
  });

  it('falls back to legacy waypoints when no systems exist', () => {
    const systems = visibleWaypointSystems({
      ...defaultSimulationConfig(),
      activeWaypointSystemId: 'legacy',
      waypoints: [{ id: 'legacy-waypoint', label: 'Legacy', type: 'transit', x: 20, z: 30, radiusCm: 120, optional: false, visitProbability: 1, retentionSeconds: 0, visionAngleDeg: 70, visionRangeCm: 220 }],
    });

    expect(systems).toHaveLength(1);
    expect(systems[0].waypoints[0]?.id).toBe('legacy-waypoint');
    expect(systems[0].color).toBe('#3b82f6');
  });
});

describe('visibleTrajectoryOverlayTrajectories', () => {
  it("hides active agent lines so only completed paths remain visible", () => {
    expect(visibleTrajectoryOverlayTrajectories([
      { agentId: 1, active: true, pointsCm: [0, 0, 100, 0] },
      { agentId: 2, active: false, pointsCm: [0, 0, 50, 50] },
    ])).toEqual([
      { agentId: 2, active: false, pointsCm: [0, 0, 50, 50] },
    ]);
  });
});

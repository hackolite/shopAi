import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntimeSimulationConfig, defaultSimulationConfig, useSimulationStore } from './simulationStore';

describe('simulationStore waypoint systems', () => {
  afterEach(() => {
    useSimulationStore.getState().reset();
  });

  it('creates a default waypoint system from legacy waypoints', () => {
    useSimulationStore.getState().setConfig({
      ...defaultSimulationConfig(),
      waypoints: [
        {
          id: 'entry-1',
          label: 'Entrée 1',
          type: 'entry',
          x: 100,
          z: 120,
          radiusCm: 120,
          optional: false,
          visitProbability: 1,
          retentionSeconds: 0,
          visionAngleDeg: 70,
          visionRangeCm: 220,
        },
      ],
    });

    const { config } = useSimulationStore.getState();
    expect(config.waypointSystems).toHaveLength(1);
    expect(config.waypointSystems?.[0].waypoints).toHaveLength(1);
    expect(config.activeWaypointSystemId).toBe(config.waypointSystems?.[0].id);
  });

  it('keeps each JuPedSim system on its own waypoint set', () => {
    const store = useSimulationStore.getState();
    store.addWaypoint('entry', { x: 100, z: 100 });
    const firstWaypointId = useSimulationStore.getState().config.waypoints[0]?.id;

    useSimulationStore.getState().addWaypointSystem();
    useSimulationStore.getState().addWaypoint('exit', { x: 400, z: 400 });

    const state = useSimulationStore.getState();
    expect(state.config.waypoints).toHaveLength(1);
    expect(state.config.waypointSystems).toHaveLength(2);
    expect(state.config.waypointSystems?.[0].waypoints[0]?.id).toBe(firstWaypointId);
    expect(state.config.waypointSystems?.[1].waypoints[0]?.type).toBe('exit');
  });

  it('switches and removes waypoint systems while keeping active waypoints in sync', () => {
    const store = useSimulationStore.getState();
    store.addWaypoint('entry', { x: 100, z: 100 });
    const firstSystemId = useSimulationStore.getState().config.activeWaypointSystemId as string;

    useSimulationStore.getState().addWaypointSystem();
    useSimulationStore.getState().addWaypoint('exit', { x: 400, z: 400 });
    const secondSystemId = useSimulationStore.getState().config.activeWaypointSystemId as string;

    useSimulationStore.getState().selectWaypointSystem(firstSystemId);
    expect(useSimulationStore.getState().config.waypoints[0]?.type).toBe('entry');

    useSimulationStore.getState().removeWaypointSystem(firstSystemId);
    const nextState = useSimulationStore.getState();
    expect(nextState.config.activeWaypointSystemId).toBe(secondSystemId);
    expect(nextState.config.waypoints[0]?.type).toBe('exit');
    expect(nextState.config.waypointSystems).toHaveLength(1);
  });

  it('builds runtime config with all JuPedSim systems waypoints', () => {
    const store = useSimulationStore.getState();
    store.addWaypoint('entry', { x: 100, z: 100 });
    const firstSystemId = useSimulationStore.getState().config.activeWaypointSystemId as string;

    store.addWaypointSystem();
    store.addWaypoint('exit', { x: 400, z: 400 });
    const secondSystemId = useSimulationStore.getState().config.activeWaypointSystemId as string;

    store.selectWaypointSystem(firstSystemId);
    store.addWaypoint('transit', { x: 250, z: 250 });

    store.selectWaypointSystem(secondSystemId);
    const runtimeConfig = buildRuntimeSimulationConfig(useSimulationStore.getState().config);

    expect(runtimeConfig.waypoints).toHaveLength(3);
    expect(runtimeConfig.waypoints.some((waypoint) => waypoint.type === 'entry')).toBe(true);
    expect(runtimeConfig.waypoints.some((waypoint) => waypoint.type === 'transit')).toBe(true);
    expect(runtimeConfig.waypoints.some((waypoint) => waypoint.type === 'exit')).toBe(true);
  });
});

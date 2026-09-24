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

  it('keeps the selected waypoint placement mode until changed', () => {
    const store = useSimulationStore.getState();
    store.setWaypointPlacementType('entry');
    expect(useSimulationStore.getState().waypointPlacementType).toBe('entry');

    store.addWaypoint('entry', { x: 100, z: 100 });
    expect(useSimulationStore.getState().waypointPlacementType).toBe('entry');

    store.setWaypointPlacementType('exit');
    expect(useSimulationStore.getState().waypointPlacementType).toBe('exit');
  });

  it('clears blocking obstacle highlights after a successful result', () => {
    const store = useSimulationStore.getState();
    store.setInvalidObstacleHighlights({ furnitureIds: ['fixture-1'], zoneIds: ['zone-1'] });

    store.setResult({
      frames: [],
      waypoints: [],
      summary: {
        spawnedCustomers: 0,
        completedCustomers: 0,
        activeCustomers: 0,
        averageWaypointLoad: 0,
        maxWaypointLoad: 0,
        averageConfiguredRetentionSeconds: 0,
      },
    });

    expect(useSimulationStore.getState().invalidObstacleHighlights).toEqual({ furnitureIds: [], zoneIds: [], allIds: [] });
  });

  it('updates waypoint metrics without replacing the current frames', () => {
    const store = useSimulationStore.getState();
    store.setResult({
      frames: [{ timeSeconds: 1, agents: [] }],
      waypoints: [],
      summary: {
        spawnedCustomers: 1,
        completedCustomers: 0,
        activeCustomers: 1,
        averageWaypointLoad: 0,
        maxWaypointLoad: 0,
        averageConfiguredRetentionSeconds: 0,
      },
    });

    store.setResultWaypoints([{
      waypointId: 'queue-1',
      waypointLabel: 'Queue',
      waypointType: 'transit',
      retentionSeconds: 2,
      maxActiveAgents: 3,
      releasedAgents: 4,
      samples: [],
      queuedAgents: 1,
      completedWaits: 2,
      averageWaitSeconds: 2,
      maxWaitSeconds: 3,
      currentMaxWaitSeconds: 1,
    }]);

    expect(useSimulationStore.getState().result?.frames).toEqual([{ timeSeconds: 1, agents: [] }]);
    expect(useSimulationStore.getState().result?.waypoints[0]?.waypointId).toBe('queue-1');
  });

  it('clears blocking obstacle highlights on config edits', () => {
    const store = useSimulationStore.getState();
    store.setInvalidObstacleHighlights({ furnitureIds: ['fixture-1'], zoneIds: ['zone-1'] });

    store.patchConfig({ maxCustomers: 12 });

    expect(useSimulationStore.getState().invalidObstacleHighlights).toEqual({ furnitureIds: [], zoneIds: [], allIds: [] });
  });

  it('clears blocking obstacle highlights when editing a waypoint', () => {
    const store = useSimulationStore.getState();
    store.addWaypoint('entry', { x: 100, z: 100 });
    const waypointId = useSimulationStore.getState().config.waypoints[0]?.id;
    expect(waypointId).toBeTruthy();
    store.setInvalidObstacleHighlights({ furnitureIds: ['fixture-1'], zoneIds: ['zone-1'] });

    store.updateWaypoint(waypointId as string, { x: 140 });

    expect(useSimulationStore.getState().invalidObstacleHighlights).toEqual({ furnitureIds: [], zoneIds: [], allIds: [] });
  });

  it('toggles the navigation overlay and stores the walkable preview', () => {
    const store = useSimulationStore.getState();
    const preview = {
      connected: [[0, 0], [100, 0], [100, 100]] as [number, number][],
      connectedHoles: [],
      disconnected: [],
      excludedObstacles: [],
    };

    store.setShowNavigationOverlay(true);
    store.setWalkablePreview(preview);
    store.setInvalidObstacleHighlights({ furnitureIds: ['fixture-1'], zoneIds: ['zone-1'], allIds: ['fixture-1', 'zone-2'] });

    let state = useSimulationStore.getState();
    expect(state.showNavigationOverlay).toBe(true);
    expect(state.walkablePreview).toEqual(preview);
    expect(state.invalidObstacleHighlights).toEqual({ furnitureIds: ['fixture-1'], zoneIds: ['zone-1'], allIds: ['fixture-1', 'zone-2'] });

    state.reset();
    state = useSimulationStore.getState();
    expect(state.showNavigationOverlay).toBe(false);
    expect(state.walkablePreview).toBeNull();
    expect(state.invalidObstacleHighlights).toEqual({ furnitureIds: [], zoneIds: [], allIds: [] });
  });
});

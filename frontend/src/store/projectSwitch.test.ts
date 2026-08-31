import { describe, expect, it } from 'vitest';
import { useSceneStore } from './sceneStore';
import { useZoneStore } from './zoneStore';
import { usePlanogramStore } from './planogramStore';
import { useSimulationStore } from './simulationStore';
import { useProjectStore } from './projectStore';
import type { Planogram, Scene } from '../types/cad';

const scene = {
  store: { id: 's1', name: 'Store', dimensions: [1000, 300, 800], zones: [] },
  furniture: [{ id: 'f1', name: 'Gondola', position: [0, 0, 0] }],
} as unknown as Scene;

const planogram = { id: 'p1', furnitureId: 'f1', face: 'front', widthCm: 100, heightCm: 200, cells: [] } as unknown as Planogram;

describe('project switch cleanup', () => {
  it('sceneStore.reset clears scene, selection, history and clipboard', () => {
    const store = useSceneStore.getState();
    store.setScene(scene);
    store.selectFurniture('f1');
    store.toggleFurnitureSelection('f1');
    store.setClipboard({ items: [{ furniture: scene.furniture[0], planogramIds: {} }] });
    store.toggleNodeExpanded('f1');
    useSceneStore.getState().removeFurniture('f1');

    useSceneStore.getState().reset();

    const next = useSceneStore.getState();
    expect(next.scene).toBeNull();
    expect(next.selectedFurnitureId).toBeNull();
    expect(next.selectedFurnitureIds.size).toBe(0);
    expect(next.selection.type).toBeNull();
    expect(next.expandedNodes.size).toBe(0);
    expect(next.clipboard).toBeNull();
    expect(next.history).toEqual([]);
  });

  it('zoneStore.reset clears zones and marks them as not loaded', () => {
    useZoneStore.getState().setZones([]);
    useZoneStore.getState().addZone('entrance', 1000, 800);
    expect(useZoneStore.getState().zones).toHaveLength(1);
    expect(useZoneStore.getState().zonesLoaded).toBe(true);

    useZoneStore.getState().reset();

    const next = useZoneStore.getState();
    expect(next.zones).toEqual([]);
    expect(next.selectedZoneId).toBeNull();
    // zonesLoaded must go back to false so the zone auto-save stays disabled
    // until the new project's zones have been loaded.
    expect(next.zonesLoaded).toBe(false);
  });

  it('planogramStore.reset clears cached planogram details', () => {
    usePlanogramStore.getState().setPlanogramDetail(planogram);
    usePlanogramStore.getState().setActivePlanogram(planogram);
    expect(usePlanogramStore.getState().planogramDetails.size).toBe(1);

    usePlanogramStore.getState().reset();

    const next = usePlanogramStore.getState();
    expect(next.planograms).toEqual([]);
    expect(next.planogramDetails.size).toBe(0);
    expect(next.activePlanogram).toBeNull();
    expect(next.selectedCellIds.size).toBe(0);
    expect(next.requestOpenPlanogramId).toBeNull();
  });

  it('simulationStore.reset clears waypoints, result and live session', () => {
    useSimulationStore.getState().addWaypoint('entry');
    useSimulationStore.getState().setLiveSessionId('session-1');
    useSimulationStore.getState().setPlaying(true);
    expect(useSimulationStore.getState().config.waypoints).toHaveLength(1);

    useSimulationStore.getState().reset();

    const next = useSimulationStore.getState();
    expect(next.config.waypoints).toEqual([]);
    expect(next.result).toBeNull();
    expect(next.liveSessionId).toBeNull();
    expect(next.playing).toBe(false);
    expect(next.paused).toBe(false);
    expect(next.running).toBe(false);
    expect(next.selectedWaypointId).toBeNull();
    expect(next.history).toEqual([]);
  });

  it('projectStore tracks which project the in-memory state belongs to', () => {
    useProjectStore.getState().setLoadedProjectId('a');
    expect(useProjectStore.getState().loadedProjectId).toBe('a');
    useProjectStore.getState().setLoadedProjectId(null);
    expect(useProjectStore.getState().loadedProjectId).toBeNull();
  });
});

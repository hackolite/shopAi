import { useCatalogStore } from './catalogStore';
import { usePlanogramStore } from './planogramStore';
import { useProjectStore } from './projectStore';
import { useSceneStore } from './sceneStore';
import { useSimulationStore } from './simulationStore';
import { useZoneStore } from './zoneStore';

/**
 * Drops every piece of in-memory state that belongs to a project: scene,
 * zones, catalog, planograms and simulation (waypoints, live session, result).
 *
 * `loadedProjectId` is set to `null` so the auto-save effects stay disabled
 * until the newly selected project is fully loaded, and so any response still
 * in flight for the previous project can be discarded.
 *
 * It must be called *synchronously* when the user selects another project —
 * not only when the asynchronous load starts — otherwise the previous
 * project's furniture, floor grids and waypoints stay on screen (and remain
 * editable) until React has re-rendered the whole 3D scene.
 */
export function resetProjectStores(): void {
  useProjectStore.getState().setLoadedProjectId(null);
  useSceneStore.getState().reset();
  useZoneStore.getState().reset();
  usePlanogramStore.getState().reset();
  useSimulationStore.getState().reset();
  useCatalogStore.getState().setProducts([]);
}

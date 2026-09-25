import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import Inspector from './index';
import { cadApi } from '../../api/cad';
import { useSceneStore } from '../../store/sceneStore';
import { usePlanogramStore } from '../../store/planogramStore';
import { useCatalogStore } from '../../store/catalogStore';
import { useZoneStore } from '../../store/zoneStore';
import { useProjectStore } from '../../store/projectStore';
import { useSimulationStore } from '../../store/simulationStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../api/cad', () => ({
  cadApi: {
    updateFurniture: vi.fn().mockResolvedValue(undefined),
    updateStore: vi.fn().mockResolvedValue(undefined),
    getWalkablePreview: vi.fn().mockResolvedValue({
      connected: [],
      connectedHoles: [],
      disconnected: [],
      excludedObstacles: [],
      envelopeMergeGain: {
        sourceObstacleCount: 4,
        runtimeObstacleCount: 2,
        obstaclesSaved: 2,
        obstacleReductionPct: 50,
        sourceVertexCount: 20,
        runtimeVertexCount: 8,
        verticesSaved: 12,
        vertexReductionPct: 60,
      },
    }),
  },
}));

function hasText(renderer: ReactTestRenderer, text: string): boolean {
  return renderer.root.findAll((node) => typeof node.type === 'string' && node.children.join('') === text).length > 0;
}

describe('Inspector OSM zone metadata', () => {
  afterEach(() => {
    vi.clearAllMocks();
    useSceneStore.getState().reset();
    usePlanogramStore.getState().reset();
    useCatalogStore.setState({
      products: [],
      searchQuery: '',
      filteredProducts: [],
      selectedEan: null,
      favoriteEans: new Set<string>(),
      recentlyUsedEans: [],
      loading: false,
    });
    useProjectStore.setState({
      projects: [],
      currentProjectId: null,
      loadedProjectId: null,
      navigationPolygonCount: null,
      loading: false,
    });
    useSimulationStore.getState().reset();
    useZoneStore.getState().reset();
  });

  it('shows relevant OSM building metadata for the selected zone', async () => {
    useSceneStore.setState({
      scene: {
        store: {
          id: 'store-osm',
          name: 'OSM Store',
          position: [0, 0, 0],
          dimensions: { width: 1200, depth: 900, height: 1000 },
          floorColor: '#1e2230',
          wallColor: '#404060',
          zones: [],
        },
        furniture: [],
      },
      selectedFurnitureId: null,
      selectedFurnitureIds: new Set<string>(),
      selection: { type: null },
      expandedNodes: new Set<string>(),
      loading: false,
      clipboard: null,
      history: [],
    });
    usePlanogramStore.getState().reset();
    useZoneStore.setState({
      zones: [{
        id: 'building-100',
        type: 'forbidden',
        label: 'Marché central',
        x: 0,
        z: 0,
        width: 400,
        depth: 300,
        shape: 'polygon',
        color: '#2A9D8F',
        mounted: true,
        heightCm: 900,
        opacity: 0.62,
        points: [
          { x: 0, z: 0 },
          { x: 400, z: 0 },
          { x: 400, z: 300 },
        ],
        source: {
          osmWayId: '100',
          name: 'Marché central',
          buildingType: 'retail',
          buildingTypeRaw: 'retail',
          semanticSourceTag: 'building',
          semanticRawValue: 'retail',
          geometryRole: 'building',
          isLikelyBuilding: true,
          buildingConfidence: 'high',
          heightSource: 'height',
          height: '9',
          defaultHeightApplied: false,
          tags: {
            building: 'retail',
            height: '9',
            name: 'Marché central',
          },
        },
      }],
      selectedZoneId: 'building-100',
      selectedZoneIds: new Set(['building-100']),
      zoneClipboard: null,
      polygonDraft: null,
      polygonDraftError: null,
      zonesLoaded: true,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Inspector projectId={null} onOpenPlanogram={() => undefined} />);
    });

    expect(hasText(renderer, 'OSM')).toBe(true);
    expect(hasText(renderer, '100')).toBe(true);
    expect(hasText(renderer, 'Marché central')).toBe(true);
    expect(hasText(renderer, 'retail')).toBe(true);
    expect(hasText(renderer, 'building=retail')).toBe(true);
    expect(hasText(renderer, 'high')).toBe(true);
    expect(hasText(renderer, 'height')).toBe(true);
  });

  it('allows setting a forbidden zone as traversable', async () => {
    useSceneStore.setState({
      scene: {
        store: {
          id: 'store-zones',
          name: 'Zones Store',
          position: [0, 0, 0],
          dimensions: { width: 1200, depth: 900, height: 1000 },
          floorColor: '#1e2230',
          wallColor: '#404060',
          zones: [],
        },
        furniture: [],
      },
      selectedFurnitureId: null,
      selectedFurnitureIds: new Set<string>(),
      selection: { type: null },
      expandedNodes: new Set<string>(),
      loading: false,
      clipboard: null,
      history: [],
    });
    usePlanogramStore.getState().reset();
    useZoneStore.setState({
      zones: [{
        id: 'zone-traversable',
        type: 'forbidden',
        label: 'Zone libre',
        x: 100,
        z: 100,
        width: 200,
        depth: 120,
        shape: 'rectangle',
        mounted: false,
        pedestrianObstacle: true,
      }],
      selectedZoneId: 'zone-traversable',
      selectedZoneIds: new Set(['zone-traversable']),
      zoneClipboard: null,
      polygonDraft: null,
      polygonDraftError: null,
      zonesLoaded: true,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Inspector projectId="project-1" onOpenPlanogram={() => undefined} />);
    });

    const traversalSelect = renderer.root
      .findAllByType('select')
      .find((node) => node.props.value === 'obstacle' || node.props.value === 'traversable');
    expect(traversalSelect).toBeDefined();

    await act(async () => {
      traversalSelect!.props.onChange({ target: { value: 'traversable' } });
    });

    const updatedZone = useZoneStore.getState().zones.find((zone) => zone.id === 'zone-traversable');
    expect(updatedZone?.pedestrianObstacle).toBe(false);
    expect(cadApi.updateStore).toHaveBeenCalled();
  });

  it('shows navigation polygon count in project metrics', async () => {
    useSceneStore.setState({
      scene: {
        store: {
          id: 'store-project',
          name: 'Project Store',
          position: [0, 0, 0],
          dimensions: { width: 1200, depth: 900, height: 1000 },
          floorColor: '#1e2230',
          wallColor: '#404060',
          zones: [],
        },
        furniture: [],
      },
      selectedFurnitureId: null,
      selectedFurnitureIds: new Set<string>(),
      selection: { type: null },
      expandedNodes: new Set<string>(),
      loading: false,
      clipboard: null,
      history: [],
    });
    useProjectStore.getState().setNavigationPolygonCount(7);
    useZoneStore.setState({
      zones: [],
      selectedZoneId: null,
      selectedZoneIds: new Set<string>(),
      zoneClipboard: null,
      polygonDraft: null,
      polygonDraftError: null,
      zonesLoaded: true,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Inspector projectId={null} onOpenPlanogram={() => undefined} />);
    });

    expect(hasText(renderer, 'Polygones navigation')).toBe(true);
    expect(hasText(renderer, '7')).toBe(true);
  });

  it('fetches the walkable preview so envelope gain is visible in Inspector', async () => {
    useSceneStore.setState({
      scene: {
        store: {
          id: 'store-preview',
          name: 'Preview Store',
          position: [0, 0, 0],
          dimensions: { width: 1200, depth: 900, height: 1000 },
          floorColor: '#1e2230',
          wallColor: '#404060',
          zones: [],
        },
        furniture: [],
      },
      selectedFurnitureId: null,
      selectedFurnitureIds: new Set<string>(),
      selection: { type: null },
      expandedNodes: new Set<string>(),
      loading: false,
      clipboard: null,
      history: [],
    });
    useZoneStore.setState({
      zones: [],
      selectedZoneId: null,
      selectedZoneIds: new Set<string>(),
      zoneClipboard: null,
      polygonDraft: null,
      polygonDraftError: null,
      zonesLoaded: true,
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Inspector projectId="project-1" onOpenPlanogram={() => undefined} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(cadApi.getWalkablePreview).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        store: expect.objectContaining({ zones: [] }),
      }),
      expect.any(Object),
    );
    expect(hasText(renderer, '-50.0% obstacles · -60.0% sommets')).toBe(true);
    expect(hasText(renderer, '4 → 2')).toBe(true);
    expect(hasText(renderer, '20 → 8')).toBe(true);
    expect(hasText(renderer, 'Diagnostic perf')).toBe(true);
    expect(hasText(renderer, 'inactif')).toBe(true);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { selectNonBlockingZones, useZoneStore } from './zoneStore';

describe('zoneStore', () => {
  afterEach(() => {
    useZoneStore.getState().reset();
  });

  it('supports multi-selection for zones', () => {
    const store = useZoneStore.getState();
    store.addZone('forbidden', 1200, 900, { shape: 'rectangle' });
    store.addZone('forbidden', 1200, 900, { shape: 'circle' });
    const [first, second] = useZoneStore.getState().zones;

    useZoneStore.getState().selectZone(first.id);
    useZoneStore.getState().toggleZoneSelection(second.id);

    const next = useZoneStore.getState();
    expect(next.selectedZoneIds.has(first.id)).toBe(true);
    expect(next.selectedZoneIds.has(second.id)).toBe(true);
    expect(next.selectedZoneId).toBe(second.id);
  });

  it('clamps opacity and preserves mounted shape properties when duplicating zones', () => {
    const store = useZoneStore.getState();
    store.addZone('forbidden', 1200, 900, {
      shape: 'polygon',
      mounted: true,
      heightCm: 180,
      opacity: 5,
      points: [
        { x: 100, z: 100 },
        { x: 300, z: 100 },
        { x: 200, z: 300 },
      ],
    });
    const source = useZoneStore.getState().zones[0];

    store.addExistingZones([{
      ...source,
      id: 'zone-copy',
      points: source.points?.map((point) => ({ ...point })),
    }]);

    const duplicated = useZoneStore.getState().zones.find((zone) => zone.id === 'zone-copy');
    expect(duplicated?.mounted).toBe(true);
    expect(duplicated?.heightCm).toBe(180);
    expect(duplicated?.opacity).toBe(1);
    expect(duplicated?.points).toEqual(source.points);
  });

  it('removes all selected zones together', () => {
    const store = useZoneStore.getState();
    store.addZone('forbidden', 1200, 900, { shape: 'rectangle' });
    store.addZone('forbidden', 1200, 900, { shape: 'diamond' });
    const ids = useZoneStore.getState().zones.map((zone) => zone.id);

    useZoneStore.getState().selectZone(ids[0]);
    useZoneStore.getState().toggleZoneSelection(ids[1]);
    useZoneStore.getState().removeZones(ids);

    const next = useZoneStore.getState();
    expect(next.zones).toHaveLength(0);
    expect(next.selectedZoneId).toBeNull();
    expect(next.selectedZoneIds.size).toBe(0);
  });

  it('measures density only on user-drawn traversable zones', () => {
    const store = useZoneStore.getState();
    store.addZone('forbidden', 1200, 900, { shape: 'rectangle' });
    store.addZone('forbidden', 1200, 900, { shape: 'circle' });
    store.addZone('entrance', 1200, 900);
    const [blocking, traversable] = useZoneStore.getState().zones;
    useZoneStore.getState().updateZone({ ...traversable, blocksAccess: false });
    useZoneStore.getState().addExistingZones([{
      ...traversable,
      id: 'building-1',
      blocksAccess: false,
      source: { osmWayId: '1', isLikelyBuilding: true },
    }]);

    const measured = selectNonBlockingZones(useZoneStore.getState().zones);
    expect(measured.map((zone) => zone.id)).toEqual([traversable.id]);
    expect(measured.some((zone) => zone.id === blocking.id)).toBe(false);
  });
});

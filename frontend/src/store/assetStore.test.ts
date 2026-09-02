import { describe, expect, it } from 'vitest';
import { loadRatio, useAssetStore } from './assetStore';

describe('assetStore', () => {
  it('tracks planogram load progress', () => {
    useAssetStore.getState().reset();
    useAssetStore.getState().startLoading(2);
    expect(useAssetStore.getState().loading).toBe(true);

    useAssetStore.getState().markPlanogramLoaded();
    expect(useAssetStore.getState().planogramsLoaded).toBe(1);

    useAssetStore.getState().finishLoading();
    expect(useAssetStore.getState().loading).toBe(false);
  });

  it('reset clears the shared image cache and the progress counters', () => {
    useAssetStore.getState().startLoading(3);
    useAssetStore.getState().markPlanogramLoaded();
    useAssetStore.getState().productImages.set('1', {} as HTMLImageElement);

    useAssetStore.getState().reset();

    const next = useAssetStore.getState();
    expect(next.loading).toBe(false);
    expect(next.planogramsLoaded).toBe(0);
    expect(next.planogramsTotal).toBe(0);
    expect(next.imagesLoaded).toBe(0);
    expect(next.imagesTotal).toBe(0);
    expect(next.productImages.size).toBe(0);
  });

  it('suspends image downloads while the preload is paused', async () => {
    useAssetStore.getState().reset();
    useAssetStore.getState().setPreloadPaused(true);

    const pending = useAssetStore
      .getState()
      .preloadProductImages(new Map([['1', 'data:image/png;base64,AA']]));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useAssetStore.getState().imagesLoaded).toBe(0);
    expect(useAssetStore.getState().productImages.size).toBe(0);

    // Switching project must abort the suspended preload instead of leaking it
    // into the next project's cache.
    useAssetStore.getState().reset();
    await pending;
    expect(useAssetStore.getState().productImages.size).toBe(0);
  });

  it('loadRatio combines planogram and image progress', () => {
    expect(loadRatio({ planogramsLoaded: 0, planogramsTotal: 0, imagesLoaded: 0, imagesTotal: 0 })).toBe(0);
    expect(loadRatio({ planogramsLoaded: 2, planogramsTotal: 2, imagesLoaded: 1, imagesTotal: 2 })).toBeCloseTo(0.75);
    expect(loadRatio({ planogramsLoaded: 4, planogramsTotal: 2, imagesLoaded: 4, imagesTotal: 2 })).toBe(1);
  });
});

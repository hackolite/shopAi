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

  it('keeps downloading (in low priority) while throttled and aborts on reset', async () => {
    // Minimal Image stub: the node test environment has none, and a never
    // settling image keeps the preload in flight for the abort assertion.
    const previousImage = (globalThis as { Image?: unknown }).Image;
    (globalThis as { Image?: unknown }).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = '';
      set src(_value: string) { this.onerror?.(); }
    };

    useAssetStore.getState().reset();
    useAssetStore.getState().setPreloadThrottled(true);
    expect(useAssetStore.getState().preloadThrottled).toBe(true);

    const pending = useAssetStore
      .getState()
      .preloadProductImages(new Map([['1', 'data:image/png;base64,AA'], ['2', 'data:image/png;base64,BB']]));

    // The gauge total is published immediately so the bar stays visible even
    // when the downloads themselves run at low priority.
    expect(useAssetStore.getState().imagesTotal).toBe(2);

    // Switching project must abort the in-flight preload instead of leaking it
    // into the next project's cache.
    useAssetStore.getState().reset();
    await pending;
    expect(useAssetStore.getState().productImages.size).toBe(0);
    expect(useAssetStore.getState().preloadThrottled).toBe(false);

    (globalThis as { Image?: unknown }).Image = previousImage;
  });

  it('loadRatio combines planogram and image progress', () => {
    expect(loadRatio({ planogramsLoaded: 0, planogramsTotal: 0, imagesLoaded: 0, imagesTotal: 0 })).toBe(0);
    expect(loadRatio({ planogramsLoaded: 2, planogramsTotal: 2, imagesLoaded: 1, imagesTotal: 2 })).toBeCloseTo(0.75);
    expect(loadRatio({ planogramsLoaded: 4, planogramsTotal: 2, imagesLoaded: 4, imagesTotal: 2 })).toBe(1);
  });
});

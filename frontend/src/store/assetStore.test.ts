import { describe, expect, it, vi } from 'vitest';
import { clearDecodedImageCache, loadRatio, useAssetStore } from './assetStore';

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
    clearDecodedImageCache();
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

  it('persists remotely hosted product images across store resets', async () => {
    const previousImage = (globalThis as { Image?: unknown }).Image;
    const previousCaches = globalThis.caches;
    const previousFetch = globalThis.fetch;
    const stored = new Map<string, Response>();
    const cache = {
      match: async (url: string) => stored.get(url)?.clone(),
      put: async (url: string, response: Response) => { stored.set(url, response.clone()); },
    };
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: async () => cache },
    });
    const fetchMock = vi.fn(async () => new Response('product image'));
    globalThis.fetch = fetchMock;
    (globalThis as { Image?: unknown }).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = '';
      set src(_value: string) { this.onload?.(); }
    };

    try {
      const urls = new Map([['1', 'https://example.com/product.png']]);
      useAssetStore.getState().reset();
      clearDecodedImageCache();
      await useAssetStore.getState().preloadProductImages(urls);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      useAssetStore.getState().reset();
      await useAssetStore.getState().preloadProductImages(urls);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(useAssetStore.getState().productImages.size).toBe(1);
    } finally {
      useAssetStore.getState().reset();
      clearDecodedImageCache();
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: previousCaches });
      globalThis.fetch = previousFetch;
      (globalThis as { Image?: unknown }).Image = previousImage;
    }
  });

  it('reuses decoded images from memory across project switches without reloading', async () => {
    const previousImage = (globalThis as { Image?: unknown }).Image;
    let constructed = 0;
    (globalThis as { Image?: unknown }).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = '';
      constructor() { constructed++; }
      set src(_value: string) { this.onload?.(); }
    };

    try {
      const urls = new Map([['1', 'data:image/png;base64,AA']]);
      useAssetStore.getState().reset();
      clearDecodedImageCache();
      await useAssetStore.getState().preloadProductImages(urls);
      expect(constructed).toBe(1);
      expect(useAssetStore.getState().productImages.size).toBe(1);

      // Project switch wipes the per-project cache…
      useAssetStore.getState().reset();
      expect(useAssetStore.getState().productImages.size).toBe(0);

      // …but the decoded image is served instantly from the tab-lifetime cache:
      // no new Image is constructed and progress counters report it as loaded.
      await useAssetStore.getState().preloadProductImages(urls);
      expect(constructed).toBe(1);
      const state = useAssetStore.getState();
      expect(state.productImages.size).toBe(1);
      expect(state.imagesTotal).toBe(1);
      expect(state.imagesLoaded).toBe(1);
    } finally {
      useAssetStore.getState().reset();
      clearDecodedImageCache();
      (globalThis as { Image?: unknown }).Image = previousImage;
    }
  });

  it('does not download nor count an EAN twice when preloads overlap', async () => {
    const previousImage = (globalThis as { Image?: unknown }).Image;
    let constructed = 0;
    const loaders: (() => void)[] = [];
    (globalThis as { Image?: unknown }).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = '';
      constructor() { constructed++; }
      // Loading stays pending until the test releases it, so a second preload
      // for the same EAN can race the first one.
      set src(_value: string) { loaders.push(() => this.onload?.()); }
    };

    try {
      const urls = new Map([['1', 'data:image/png;base64,AA']]);
      useAssetStore.getState().reset();
      clearDecodedImageCache();
      const first = useAssetStore.getState().preloadProductImages(urls);
      // Concurrent call (e.g. an overlay safety net) while '1' is in flight:
      // it must be a no-op for both the download and the gauge total.
      const second = useAssetStore.getState().preloadProductImages(urls);
      expect(useAssetStore.getState().imagesTotal).toBe(1);
      // The image `src` is assigned after async cache lookups: wait for it.
      while (loaders.length === 0) await new Promise((r) => { setTimeout(r, 0); });
      loaders.forEach((resolve) => resolve());
      await Promise.all([first, second]);

      expect(constructed).toBe(1);
      const state = useAssetStore.getState();
      expect(state.imagesTotal).toBe(1);
      expect(state.imagesLoaded).toBe(1);
      expect(state.productImages.size).toBe(1);
      expect(state.pendingImageEans.size).toBe(0);
    } finally {
      useAssetStore.getState().reset();
      clearDecodedImageCache();
      (globalThis as { Image?: unknown }).Image = previousImage;
    }
  });

  it('loadRatio combines planogram and image progress', () => {
    expect(loadRatio({ planogramsLoaded: 0, planogramsTotal: 0, imagesLoaded: 0, imagesTotal: 0 })).toBe(0);
    expect(loadRatio({ planogramsLoaded: 2, planogramsTotal: 2, imagesLoaded: 1, imagesTotal: 2 })).toBeCloseTo(0.75);
    expect(loadRatio({ planogramsLoaded: 4, planogramsTotal: 2, imagesLoaded: 4, imagesTotal: 2 })).toBe(1);
  });
});

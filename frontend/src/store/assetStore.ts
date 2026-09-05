import { create } from 'zustand';

/** Max number of product images downloaded in parallel. */
const MAX_CONCURRENT_IMAGE_LOADS = 8;

/**
 * Concurrency used while the app is busy (live simulation running): a single
 * image at a time, so the download keeps progressing — and the loading gauge
 * keeps moving — without ever competing with the render loop.
 */
const THROTTLED_CONCURRENT_IMAGE_LOADS = 1;

/**
 * Minimum delay between two progress/cache notifications while preloading.
 * Each notification bumps `imageVersion`, which makes every planogram face
 * overlay rebuild its canvas texture on the main thread — keep them rare so
 * the preload never makes the UI feel sluggish.
 */
const PROGRESS_FLUSH_MS = 1000;

/**
 * Notification interval used in throttled mode. Each flush rebuilds every
 * planogram canvas texture, which is the expensive part: space them out.
 */
const THROTTLED_PROGRESS_FLUSH_MS = 3000;

/** Idle gap left to the main thread between two images in throttled mode. */
const THROTTLED_IDLE_GAP_MS = 120;

/** Persistent browser cache shared between sessions and project reloads. */
const PRODUCT_IMAGE_CACHE_NAME = 'shop-ai-product-images-v1';

/**
 * The Cache Storage handle is opened once and reused: opening it per image
 * adds a measurable per-image latency when preloading thousands of products.
 */
let productImageCachePromise: Promise<Cache | null> | null = null;

function openProductImageCache(): Promise<Cache | null> {
  if (!productImageCachePromise) {
    productImageCachePromise = caches.open(PRODUCT_IMAGE_CACHE_NAME).catch(() => {
      // Cache storage can be unavailable (for example in private browsing).
      productImageCachePromise = null;
      return null;
    });
  }
  return productImageCachePromise;
}

/**
 * Decoded images kept for the whole tab lifetime, keyed by URL. Unlike the
 * per-project `productImages` map (keyed by EAN and wiped on project switch),
 * this cache survives `reset()`, so reopening a project — or switching between
 * projects sharing catalog images — reuses already-decoded pixels instead of
 * re-downloading and re-decoding every image.
 */
const decodedImagesByUrl = new Map<string, HTMLImageElement>();

/** Soft cap on the decoded-image cache (oldest entries evicted first). */
const MAX_DECODED_IMAGES = 6000;

function rememberDecodedImage(url: string, img: HTMLImageElement): void {
  if (decodedImagesByUrl.size >= MAX_DECODED_IMAGES) {
    const oldest = decodedImagesByUrl.keys().next().value;
    if (oldest !== undefined) decodedImagesByUrl.delete(oldest);
  }
  decodedImagesByUrl.set(url, img);
}

/** Empties the tab-lifetime caches (decoded images + cache handle, for tests). */
export function clearDecodedImageCache(): void {
  decodedImagesByUrl.clear();
  productImageCachePromise = null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export interface LoadProgress {
  /** Number of planogram details already fetched. */
  planogramsLoaded: number;
  planogramsTotal: number;
  /** Number of product images already downloaded (or failed). */
  imagesLoaded: number;
  imagesTotal: number;
}

interface AssetState extends LoadProgress {
  /** Whether a project load (planograms + images) is still in progress. */
  loading: boolean;
  /**
   * Decoded product images keyed by EAN, shared by every 3D planogram overlay so
   * each image is downloaded once for the whole scene instead of once per face.
   * The Map is mutated in place; subscribe to `imageVersion` to react to changes.
   */
  productImages: Map<string, HTMLImageElement>;
  /** Bumped whenever `productImages` gained entries, to re-render consumers. */
  imageVersion: number;
  /**
   * EANs whose image download is currently in flight. Concurrent
   * `preloadProductImages` calls (the project-open preload and the per-overlay
   * safety nets) skip these so the same image is never downloaded — nor counted
   * in the loading gauge — twice. Mutated in place; replaced on `reset()`.
   */
  pendingImageEans: Set<string>;
  /**
   * While true, image downloads run in low-priority mode: one image at a time,
   * with an idle gap between them and rare cache notifications. The live
   * simulation owns the main thread (ticking, agent rendering, texture
   * rebuilds) and must never be slowed down by catalog images, but the download
   * still progresses so the loading gauge stays alive.
   */
  preloadThrottled: boolean;
  /**
   * Incremented on `reset()` so in-flight preloads started for a previous
   * project abort instead of filling the cache of the newly opened one.
   */
  preloadGeneration: number;
  setPreloadThrottled: (throttled: boolean) => void;
  startLoading: (planogramsTotal: number) => void;
  markPlanogramLoaded: () => void;
  finishLoading: () => void;
  /**
   * Downloads the given image URLs (keyed by EAN) into the shared cache.
   * Already-cached EANs are skipped. Resolves when all downloads have settled.
   */
  preloadProductImages: (urlsByEan: Map<string, string>) => Promise<void>;
  reset: () => void;
}

/**
 * Returns a local source for an image, preferring the persistent Cache API.
 * Data URLs are already local and must not be copied into the browser cache.
 */
async function cachedImageSource(url: string): Promise<{ source: string; revoke: boolean }> {
  if (url.startsWith('data:') || typeof caches === 'undefined') {
    return { source: url, revoke: false };
  }

  try {
    const cache = await openProductImageCache();
    if (!cache) return { source: url, revoke: false };
    let response = await cache.match(url);
    if (!response) {
      const fetched = await fetch(url);
      if (!fetched.ok || fetched.type === 'opaque') return { source: url, revoke: false };
      await cache.put(url, fetched.clone());
      response = fetched;
    }
    return { source: URL.createObjectURL(await response.blob()), revoke: true };
  } catch {
    // Cache storage can be unavailable (for example in private browsing).
    return { source: url, revoke: false };
  }
}

/** Loads one image, resolving to null when it fails (broken URL, 404, CORS…). */
async function loadImage(url: string): Promise<HTMLImageElement | null> {
  const { source, revoke } = await cachedImageSource(url);
  const img = new Image();
  // Images are served from the same backend origin; crossOrigin is set so that
  // canvas.drawImage() does not taint the canvas when running from a dev server
  // that may differ from the API origin.
  img.crossOrigin = 'anonymous';
  // Handlers must be attached before `src` so synchronous failures are caught.
  const loaded = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  img.src = source;
  try {
    if (typeof img.decode === 'function') {
      // decode() performs the (expensive) pixel decode off the main thread, so
      // the first canvas.drawImage() of this image never blocks the UI.
      await img.decode();
    } else if (!(await loaded)) {
      return null;
    }
    return img;
  } catch {
    // decode() can reject for a valid image (e.g. transient memory pressure):
    // fall back to the load result instead of dropping the image.
    return (await loaded) ? img : null;
  } finally {
    if (revoke) URL.revokeObjectURL(source);
  }
}

export const useAssetStore = create<AssetState>((set, get) => ({
  loading: false,
  planogramsLoaded: 0,
  planogramsTotal: 0,
  imagesLoaded: 0,
  imagesTotal: 0,
  productImages: new Map<string, HTMLImageElement>(),
  imageVersion: 0,
  pendingImageEans: new Set<string>(),
  preloadThrottled: false,
  preloadGeneration: 0,

  setPreloadThrottled: (throttled) => set({ preloadThrottled: throttled }),

  startLoading: (planogramsTotal) =>
    set({
      loading: true,
      planogramsLoaded: 0,
      planogramsTotal,
      imagesLoaded: 0,
      imagesTotal: 0,
    }),

  markPlanogramLoaded: () =>
    set((state) => ({ planogramsLoaded: state.planogramsLoaded + 1 })),

  finishLoading: () => set({ loading: false }),

  preloadProductImages: async (urlsByEan) => {
    const cache = get().productImages;
    const pendingEans = get().pendingImageEans;
    const pending: [string, string][] = [];
    // URLs already decoded during this tab's lifetime (e.g. a previously opened
    // project) are served instantly from memory: no download, no decode.
    let servedFromMemory = 0;
    for (const [ean, url] of urlsByEan) {
      // Skip EANs already cached or currently downloading (a concurrent
      // preload — e.g. an overlay safety net racing the project-open preload —
      // must not download or count the same image a second time).
      if (cache.has(ean) || pendingEans.has(ean)) continue;
      const decoded = decodedImagesByUrl.get(url);
      if (decoded) {
        cache.set(ean, decoded);
        servedFromMemory++;
      } else {
        pending.push([ean, url]);
        pendingEans.add(ean);
      }
    }
    set((state) => ({
      imagesTotal: state.imagesTotal + pending.length + servedFromMemory,
      imagesLoaded: state.imagesLoaded + servedFromMemory,
      imageVersion: servedFromMemory > 0 ? state.imageVersion + 1 : state.imageVersion,
    }));
    if (pending.length === 0) return;

    // Images land in the shared (mutable) cache one by one, but the store is
    // only notified at most every PROGRESS_FLUSH_MS: publishing every single
    // image would rebuild every planogram canvas texture hundreds of times.
    let settledSinceFlush = 0;
    let lastFlush = Date.now();
    const flush = () => {
      if (settledSinceFlush === 0) return;
      const count = settledSinceFlush;
      settledSinceFlush = 0;
      lastFlush = Date.now();
      set((state) => ({
        imageVersion: state.imageVersion + 1,
        imagesLoaded: state.imagesLoaded + count,
      }));
    };

    let cursor = 0;
    const generation = get().preloadGeneration;
    // `slot` is the worker's rank: in throttled mode only the first slots keep
    // downloading, the extra ones idle until the app is free again.
    const worker = async (slot: number) => {
      for (;;) {
        // Abort when the project changed under us.
        if (get().preloadGeneration !== generation) return;
        const throttled = get().preloadThrottled;
        if (throttled && slot >= THROTTLED_CONCURRENT_IMAGE_LOADS) {
          if (cursor >= pending.length) return;
          await sleep(THROTTLED_IDLE_GAP_MS);
          continue;
        }
        const index = cursor++;
        if (index >= pending.length) return;
        const [ean, url] = pending[index];
        const img = await loadImage(url);
        if (img) rememberDecodedImage(url, img);
        // Settled (success or failure): a later preload may retry failed EANs.
        pendingEans.delete(ean);
        if (get().preloadGeneration !== generation) return;
        if (img) cache.set(ean, img);
        settledSinceFlush++;
        const flushInterval = throttled ? THROTTLED_PROGRESS_FLUSH_MS : PROGRESS_FLUSH_MS;
        if (Date.now() - lastFlush >= flushInterval) flush();
        // Hand the main thread back between two decodes so the simulation
        // render loop always gets its frame budget.
        if (throttled) await sleep(THROTTLED_IDLE_GAP_MS);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_IMAGE_LOADS, pending.length) }, (_, slot) =>
        worker(slot),
      ),
    );
    if (get().preloadGeneration === generation) flush();
  },

  reset: () =>
    set((state) => ({
      loading: false,
      preloadThrottled: false,
      preloadGeneration: state.preloadGeneration + 1,
      planogramsLoaded: 0,
      planogramsTotal: 0,
      imagesLoaded: 0,
      imagesTotal: 0,
      productImages: new Map<string, HTMLImageElement>(),
      imageVersion: 0,
      pendingImageEans: new Set<string>(),
    })),
}));

/** Overall load ratio in [0,1] combining planogram fetches and image downloads. */
export function loadRatio(progress: LoadProgress): number {
  const total = progress.planogramsTotal + progress.imagesTotal;
  if (total === 0) return 0;
  const loaded = progress.planogramsLoaded + progress.imagesLoaded;
  return Math.min(1, loaded / total);
}

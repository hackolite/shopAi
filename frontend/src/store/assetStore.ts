import { create } from 'zustand';

/** Max number of product images downloaded in parallel. */
const MAX_CONCURRENT_IMAGE_LOADS = 8;

/** Minimum delay between two progress/cache notifications while preloading. */
const PROGRESS_FLUSH_MS = 250;

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

/** Loads one image, resolving to null when it fails (broken URL, 404, CORS…). */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // Images are served from the same backend origin; crossOrigin is set so that
    // canvas.drawImage() does not taint the canvas when running from a dev server
    // that may differ from the API origin.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export const useAssetStore = create<AssetState>((set, get) => ({
  loading: false,
  planogramsLoaded: 0,
  planogramsTotal: 0,
  imagesLoaded: 0,
  imagesTotal: 0,
  productImages: new Map<string, HTMLImageElement>(),
  imageVersion: 0,

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
    const pending: [string, string][] = [];
    for (const [ean, url] of urlsByEan) {
      if (!cache.has(ean)) pending.push([ean, url]);
    }
    set((state) => ({ imagesTotal: state.imagesTotal + pending.length }));
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
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= pending.length) return;
        const [ean, url] = pending[index];
        const img = await loadImage(url);
        if (img) cache.set(ean, img);
        settledSinceFlush++;
        if (Date.now() - lastFlush >= PROGRESS_FLUSH_MS) flush();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_IMAGE_LOADS, pending.length) }, worker),
    );
    flush();
  },

  reset: () =>
    set({
      loading: false,
      planogramsLoaded: 0,
      planogramsTotal: 0,
      imagesLoaded: 0,
      imagesTotal: 0,
      productImages: new Map<string, HTMLImageElement>(),
      imageVersion: 0,
    }),
}));

/** Overall load ratio in [0,1] combining planogram fetches and image downloads. */
export function loadRatio(progress: LoadProgress): number {
  const total = progress.planogramsTotal + progress.imagesTotal;
  if (total === 0) return 0;
  const loaded = progress.planogramsLoaded + progress.imagesLoaded;
  return Math.min(1, loaded / total);
}

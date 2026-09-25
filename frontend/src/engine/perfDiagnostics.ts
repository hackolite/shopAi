type WebglContextWithDebug = WebGLRenderingContext & {
  getExtension: (name: string) => WEBGL_debug_renderer_info | null;
};

interface BrowserMemory {
  jsHeapSizeLimit?: number;
  totalJSHeapSize?: number;
  usedJSHeapSize?: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: BrowserMemory;
}

interface NavigatorWithMemory extends Navigator {
  deviceMemory?: number;
  userAgentData?: {
    platform?: string;
  };
}

export interface FrontendPerfSample {
  timestamp: string;
  fps: number | null;
  frameTimeMs: number | null;
  cpuMainThreadBusyPct: number | null;
  longTaskCount: number;
  longTaskTotalMs: number;
  usedJsHeapMb: number | null;
  totalJsHeapMb: number | null;
  jsHeapLimitMb: number | null;
}

export interface FrontendPerfDiagnosticsSnapshot {
  startedAt: string;
  projectId: string | null;
  samplingIntervalMs: number;
  maxSamples: number;
  hardware: {
    logicalCpuCores: number | null;
    deviceMemoryGb: number | null;
    userAgent: string;
    platform: string | null;
    webglVendor: string | null;
    webglRenderer: string | null;
  };
  startup: {
    pageLoadMs: number | null;
    domContentLoadedMs: number | null;
    transferSizeBytes: number | null;
    encodedBodySizeBytes: number | null;
  };
  samples: FrontendPerfSample[];
}

interface StartOptions {
  projectId?: string | null;
  appendLog?: (category: string, message: string, details: Record<string, unknown>) => void;
}

const DEFAULT_SAMPLING_INTERVAL_MS = 2000;
const MAX_SAMPLES = 1800;
const EMIT_INTERVAL_SAMPLES = 15;

function mb(bytes: number | undefined): number | null {
  return typeof bytes === 'number' ? Number((bytes / (1024 * 1024)).toFixed(2)) : null;
}

function getStartupTimings() {
  const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (!navEntry) {
    return {
      pageLoadMs: null,
      domContentLoadedMs: null,
      transferSizeBytes: null,
      encodedBodySizeBytes: null,
    };
  }
  return {
    pageLoadMs: Number((navEntry.loadEventEnd - navEntry.startTime).toFixed(2)),
    domContentLoadedMs: Number((navEntry.domContentLoadedEventEnd - navEntry.startTime).toFixed(2)),
    transferSizeBytes: navEntry.transferSize ?? null,
    encodedBodySizeBytes: navEntry.encodedBodySize ?? null,
  };
}

function getWebglInfo(): { vendor: string | null; renderer: string | null } {
  const canvas = document.createElement('canvas');
  const context =
    (canvas.getContext('webgl') as WebglContextWithDebug | null)
    ?? (canvas.getContext('experimental-webgl') as WebglContextWithDebug | null);
  if (!context) return { vendor: null, renderer: null };
  const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
  if (!debugInfo) return { vendor: null, renderer: null };
  return {
    vendor: String(context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? ''),
    renderer: String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? ''),
  };
}

function boundedPush<T>(buffer: T[], value: T, max: number) {
  buffer.push(value);
  if (buffer.length > max) buffer.splice(0, buffer.length - max);
}

class FrontendPerfCollector {
  private readonly options: StartOptions;
  private readonly startedAt = new Date().toISOString();
  private readonly samples: FrontendPerfSample[] = [];
  private readonly startup = getStartupTimings();
  private readonly hardware = (() => {
    const nav = navigator as NavigatorWithMemory;
    const webgl = getWebglInfo();
    return {
      logicalCpuCores: navigator.hardwareConcurrency ?? null,
      deviceMemoryGb: nav.deviceMemory ?? null,
      userAgent: navigator.userAgent,
      platform: nav.userAgentData?.platform ?? navigator.platform ?? null,
      webglVendor: webgl.vendor,
      webglRenderer: webgl.renderer,
    };
  })();

  private projectId: string | null = null;
  private lastRafTs: number | null = null;
  private frameCount = 0;
  private rafId: number | null = null;
  private sampleTimer: number | null = null;
  private windowStart = performance.now();
  private longTaskCountWindow = 0;
  private longTaskTotalMsWindow = 0;
  private longTaskObserver: PerformanceObserver | null = null;
  private sampleCount = 0;

  constructor(options: StartOptions) {
    this.options = options;
    this.projectId = options.projectId ?? null;
  }

  setProjectId(projectId: string | null) {
    this.projectId = projectId;
  }

  start() {
    this.startRafLoop();
    this.startLongTaskObserver();
    this.sampleTimer = window.setInterval(() => this.sample(), DEFAULT_SAMPLING_INTERVAL_MS);
    this.sample();
  }

  stop() {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    if (this.sampleTimer != null) clearInterval(this.sampleTimer);
    if (this.longTaskObserver) this.longTaskObserver.disconnect();
  }

  getSnapshot(): FrontendPerfDiagnosticsSnapshot {
    return {
      startedAt: this.startedAt,
      projectId: this.projectId,
      samplingIntervalMs: DEFAULT_SAMPLING_INTERVAL_MS,
      maxSamples: MAX_SAMPLES,
      hardware: this.hardware,
      startup: this.startup,
      samples: [...this.samples],
    };
  }

  private startRafLoop() {
    const tick = (timestamp: number) => {
      if (this.lastRafTs != null && timestamp > this.lastRafTs) this.frameCount += 1;
      this.lastRafTs = timestamp;
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private startLongTaskObserver() {
    if (typeof PerformanceObserver === 'undefined') return;
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return;
    this.longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.longTaskCountWindow += 1;
        this.longTaskTotalMsWindow += entry.duration;
      }
    });
    this.longTaskObserver.observe({ type: 'longtask', buffered: true });
  }

  private sample() {
    const now = performance.now();
    const windowMs = Math.max(1, now - this.windowStart);
    const fps = Number(((this.frameCount * 1000) / windowMs).toFixed(2));
    const frameTimeMs = fps > 0 ? Number((1000 / fps).toFixed(2)) : null;
    const busyPct = Number(Math.min(100, (this.longTaskTotalMsWindow / windowMs) * 100).toFixed(2));
    const memory = (performance as PerformanceWithMemory).memory;
    const sample: FrontendPerfSample = {
      timestamp: new Date().toISOString(),
      fps: Number.isFinite(fps) ? fps : null,
      frameTimeMs,
      cpuMainThreadBusyPct: Number.isFinite(busyPct) ? busyPct : null,
      longTaskCount: this.longTaskCountWindow,
      longTaskTotalMs: Number(this.longTaskTotalMsWindow.toFixed(2)),
      usedJsHeapMb: mb(memory?.usedJSHeapSize),
      totalJsHeapMb: mb(memory?.totalJSHeapSize),
      jsHeapLimitMb: mb(memory?.jsHeapSizeLimit),
    };
    boundedPush(this.samples, sample, MAX_SAMPLES);

    this.sampleCount += 1;
    if (this.options.appendLog && this.sampleCount % EMIT_INTERVAL_SAMPLES === 0) {
      this.options.appendLog('frontend-perf', 'Frontend perf sample window', {
        projectId: this.projectId,
        samplingIntervalMs: DEFAULT_SAMPLING_INTERVAL_MS,
        ...sample,
      });
    }

    this.frameCount = 0;
    this.windowStart = now;
    this.longTaskCountWindow = 0;
    this.longTaskTotalMsWindow = 0;
  }
}

let activeCollector: FrontendPerfCollector | null = null;

export function startFrontendPerfDiagnostics(options: StartOptions): FrontendPerfCollector {
  if (activeCollector) {
    activeCollector.setProjectId(options.projectId ?? null);
    return activeCollector;
  }
  activeCollector = new FrontendPerfCollector(options);
  activeCollector.start();
  return activeCollector;
}

export function getFrontendPerfDiagnosticsSnapshot(): FrontendPerfDiagnosticsSnapshot | null {
  return activeCollector?.getSnapshot() ?? null;
}

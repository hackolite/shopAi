import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import SensorPanel from './index';
import { useProjectStore } from '../../store/projectStore';
import { useSensorStore } from '../../store/sensorStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  getLiveSensorSnapshot,
  liveSensorWebSocketUrl,
  updateSettings,
  clearLiveSensorSamples,
  ingestLiveSensorSamples,
} = vi.hoisted(() => ({
  getLiveSensorSnapshot: vi.fn(),
  liveSensorWebSocketUrl: vi.fn(),
  updateSettings: vi.fn(),
  clearLiveSensorSamples: vi.fn(),
  ingestLiveSensorSamples: vi.fn(),
}));

vi.mock('../../api/cad', () => ({
  cadApi: {
    getLiveSensorSnapshot,
    liveSensorWebSocketUrl,
    updateSettings,
    clearLiveSensorSamples,
    ingestLiveSensorSamples,
  },
}));

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function hasText(renderer: ReactTestRenderer, text: string): boolean {
  return renderer.root.findAll((node) => typeof node.type === 'string' && node.children.join('') === text).length > 0;
}

function buildSnapshot() {
  return {
    retentionSeconds: 300,
    sampleCount: 1,
    samples: [],
    metrics: [{ name: 'flux', min: 0, max: 1, count: 1 }],
    sources: ['sensor-a'],
    sourceLabels: { 'sensor-a': 'Entrée' },
    coordinateKinds: ['normalized'],
    latestTimestampMs: Date.now(),
  };
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

describe('SensorPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    getLiveSensorSnapshot.mockResolvedValue(buildSnapshot());
    liveSensorWebSocketUrl.mockReturnValue('ws://example.test/live');
    updateSettings.mockResolvedValue(undefined);
    clearLiveSensorSamples.mockResolvedValue({ deleted: 0, projectId: 'project-1' });
    ingestLiveSensorSamples.mockResolvedValue({ projectId: 'project-1', inserted: 1, snapshot: buildSnapshot() });
    useProjectStore.setState({ projects: [], currentProjectId: 'project-1', loadedProjectId: 'project-1', loading: false });
    useSensorStore.getState().reset();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('recovers when the websocket stays stuck in connecting until timeout', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SensorPanel projectId="project-1" />);
      await flushPromises();
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(getLiveSensorSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await flushPromises();
    });

    expect(hasText(renderer, 'Socket: error')).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1_200);
      await flushPromises();
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(getLiveSensorSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(hasText(renderer, 'Socket: connecting')).toBe(true);
  });
});

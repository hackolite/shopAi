import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactNode } from 'react';
import ProjectSceneThumbnail from './ProjectSceneThumbnail';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { getScene } = vi.hoisted(() => ({
  getScene: vi.fn(),
}));

vi.mock('../api/cad', () => ({
  cadApi: {
    getScene,
  },
}));

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: ReactNode }) => <div data-canvas="true">{children}</div>,
  useThree: () => ({
    camera: {
      position: { set: vi.fn() },
      lookAt: vi.fn(),
      updateProjectionMatrix: vi.fn(),
    },
  }),
}));

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function hasText(renderer: ReactTestRenderer, text: string): boolean {
  return renderer.root.findAll((node) => typeof node.type === 'string' && node.children.join('') === text).length > 0;
}

describe('ProjectSceneThumbnail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading then renders the 3D canvas when the scene loads', async () => {
    let resolveScene!: (value: {
      store: {
        id: string;
        name: string;
        position: [number, number, number];
        dimensions: { width: number; depth: number; height: number };
        floorColor: string;
        wallColor: string;
      };
      furniture: never[];
    }) => void;
    getScene.mockImplementation(() => new Promise((resolve) => {
      resolveScene = resolve;
    }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ProjectSceneThumbnail projectId="p1" projectName="Projet A" />);
    });
    expect(hasText(renderer, 'Chargement de l’aperçu 3D…')).toBe(true);

    await act(async () => {
      resolveScene({
        store: {
          id: 'store-1',
          name: 'Store',
          position: [100, 0, 50],
          dimensions: { width: 1000, depth: 800, height: 300 },
          floorColor: '#ffffff',
          wallColor: '#eeeeee',
        },
        furniture: [],
      });
      await flushPromises();
    });

    expect(getScene).toHaveBeenCalledWith('p1');
    expect(renderer.root.findAllByProps({ 'data-canvas': 'true' })).toHaveLength(1);
  });

  it('shows an error fallback when scene loading fails', async () => {
    getScene.mockRejectedValue(new Error('boom'));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ProjectSceneThumbnail projectId="p2" projectName="Projet A" />);
      await flushPromises();
    });

    expect(hasText(renderer, 'Aperçu indisponible')).toBe(true);
  });
});

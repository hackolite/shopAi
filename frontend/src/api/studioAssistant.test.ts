import { afterEach, describe, expect, it, vi } from 'vitest';
import { cadApi } from './cad';
import { defaultSimulationConfig } from '../store/simulationStore';
import type { Scene } from '../types/cad';

afterEach(() => vi.unstubAllGlobals());

describe('studio assistant API', () => {
  it('previews requests without implicitly confirming creation', async () => {
    const result = { message: 'Confirmer ?', requiresConfirmation: true, changed: false };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetch);

    expect(await cadApi.askAssistant('current', 'Crée une implantation complète Carrefour City')).toEqual(result);
    expect(fetch).toHaveBeenCalledWith('/api/cad/projects/current/assistant', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ prompt: 'Crée une implantation complète Carrefour City', confirm: false }),
    }));
  });

  it('returns the saved generated project for immediate 3D opening', async () => {
    const result = { message: 'Enregistré', requiresConfirmation: false, changed: true, projectId: 'generated' };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetch);

    expect((await cadApi.askAssistant('current', 'Carrefour City', true)).projectId).toBe('generated');
    expect(JSON.parse(fetch.mock.calls[0][1].body).confirm).toBe(true);
  });

  it('persists the actual scene and simulation rather than a settings round trip', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const scene: Scene = {
      store: {
        id: 'store', name: 'Magasin', position: [0, 0, 0],
        dimensions: { width: 1000, height: 300, depth: 1000 }, floorColor: '#ffffff', wallColor: '#ffffff',
      },
      furniture: [],
    };
    const simulation = defaultSimulationConfig();
    await cadApi.saveSnapshot('current', scene, simulation);
    expect(fetch).toHaveBeenCalledWith('/api/cad/projects/current/snapshot', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ scene, simulation }),
    }));
  });

  it('propagates failed saves and forbidden assistant requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })));
    await expect(cadApi.askAssistant('other-tenant', 'Carrefour City', true)).rejects.toThrow('[403]');
  });
});

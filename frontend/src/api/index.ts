import type { Store, Product, Voxel, SearchResult } from '../types';

const BASE_URL = '/api/projects';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () =>
    request<{ projects: string[] }>(`${BASE_URL}`),

  getStore: (projectId: string) =>
    request<Store>(`${BASE_URL}/${projectId}/store`),

  getProducts: (projectId: string) =>
    request<{ products: Product[] }>(`${BASE_URL}/${projectId}/products`),

  getPlanogram: (projectId: string) =>
    request<{ voxels: Voxel[] }>(`${BASE_URL}/${projectId}/planogram`),

  searchEan: (projectId: string, ean: string) =>
    request<SearchResult>(`${BASE_URL}/${projectId}/search?ean=${encodeURIComponent(ean)}`),

  importStore: (projectId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ message: string }>(`${BASE_URL}/${projectId}/import/store`, {
      method: 'POST',
      body: form,
    });
  },

  importPlanogram: (projectId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ message: string; ean_count: number }>(
      `${BASE_URL}/${projectId}/import/planogram`,
      { method: 'POST', body: form },
    );
  },

  importProducts: (projectId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ message: string }>(`${BASE_URL}/${projectId}/import/products`, {
      method: 'POST',
      body: form,
    });
  },
};

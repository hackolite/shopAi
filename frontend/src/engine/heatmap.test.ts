import { describe, expect, it } from 'vitest';
import { buildHeatmapPixels, heatmapColor } from './heatmap';
import type { SimulationHeatmap } from '../types/cad';

function heatmap(counts: number[], cols: number, rows: number, maxCount: number): SimulationHeatmap {
  return { cellSizeCm: 50, originXCm: 0, originZCm: 0, cols, rows, maxCount, counts };
}

describe('heatmapColor', () => {
  it('ramps from blue to red', () => {
    expect(heatmapColor(0)).toEqual([37, 99, 235]);
    expect(heatmapColor(1)).toEqual([239, 68, 68]);
  });

  it('clamps out-of-range intensities', () => {
    expect(heatmapColor(-3)).toEqual([37, 99, 235]);
    expect(heatmapColor(12)).toEqual([239, 68, 68]);
  });
});

describe('buildHeatmapPixels', () => {
  it('produces one RGBA pixel per cell', () => {
    const pixels = buildHeatmapPixels(heatmap([0, 1, 2, 3], 2, 2, 3));
    expect(pixels).toHaveLength(2 * 2 * 4);
  });

  it('leaves empty cells fully transparent', () => {
    const pixels = buildHeatmapPixels(heatmap([0, 4], 2, 1, 4));
    expect(Array.from(pixels.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(pixels[7]).toBeGreaterThan(0);
  });

  it('flips rows so the first grid row maps to the lowest Z of the plane', () => {
    // Row 0 (lowest Z) is hot, row 1 is empty.
    const pixels = buildHeatmapPixels(heatmap([5, 5, 0, 0], 2, 2, 5));
    // Texture row 0 (bottom) must be the empty one, texture row 1 the hot one.
    expect(pixels[3]).toBe(0);
    expect(pixels[2 * 4 + 3]).toBeGreaterThan(0);
  });
});

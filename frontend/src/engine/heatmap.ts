import type { SimulationHeatmap } from '../types/cad';

/**
 * Colour ramp used by the occupancy heatmap: cold blue for rarely visited
 * cells, red for the busiest ones.
 */
const HEATMAP_STOPS: { t: number; rgb: [number, number, number] }[] = [
  { t: 0.0, rgb: [37, 99, 235] },   // blue
  { t: 0.35, rgb: [16, 185, 129] }, // green
  { t: 0.65, rgb: [250, 204, 21] }, // yellow
  { t: 1.0, rgb: [239, 68, 68] },   // red
];

/** Maximum opacity of the hottest cell. */
export const HEATMAP_MAX_ALPHA = 0.75;

export function heatmapColor(intensity: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, intensity));
  for (let index = 1; index < HEATMAP_STOPS.length; index++) {
    const previous = HEATMAP_STOPS[index - 1];
    const current = HEATMAP_STOPS[index];
    if (t <= current.t) {
      const span = current.t - previous.t;
      const local = span > 0 ? (t - previous.t) / span : 0;
      return [
        Math.round(previous.rgb[0] + (current.rgb[0] - previous.rgb[0]) * local),
        Math.round(previous.rgb[1] + (current.rgb[1] - previous.rgb[1]) * local),
        Math.round(previous.rgb[2] + (current.rgb[2] - previous.rgb[2]) * local),
      ];
    }
  }
  return HEATMAP_STOPS[HEATMAP_STOPS.length - 1].rgb;
}

/**
 * Convert an occupancy grid into RGBA pixels for a `THREE.DataTexture`.
 *
 * The heatmap counts are row-major starting at the store origin (row 0 = lowest
 * Z).  A `DataTexture` maps its first row to the bottom of the plane, which —
 * once the plane is laid flat with a `-90°` rotation around X — is the highest Z
 * of the store.  Rows are therefore written in reverse so the texture lines up
 * with the store coordinates.
 */
export function buildHeatmapPixels(heatmap: SimulationHeatmap): Uint8Array {
  const { cols, rows, counts } = heatmap;
  const pixels = new Uint8Array(Math.max(0, cols * rows * 4));
  const maxCount = Math.max(1, heatmap.maxCount);
  for (let row = 0; row < rows; row++) {
    const textureRow = rows - 1 - row;
    for (let col = 0; col < cols; col++) {
      const count = counts[row * cols + col] ?? 0;
      const target = (textureRow * cols + col) * 4;
      if (count <= 0) {
        pixels[target] = 0;
        pixels[target + 1] = 0;
        pixels[target + 2] = 0;
        pixels[target + 3] = 0;
        continue;
      }
      // Square root keeps low-traffic areas readable next to hot spots.
      const intensity = Math.sqrt(count / maxCount);
      const [r, g, b] = heatmapColor(intensity);
      pixels[target] = r;
      pixels[target + 1] = g;
      pixels[target + 2] = b;
      pixels[target + 3] = Math.round(Math.min(1, 0.25 + intensity * 0.75) * HEATMAP_MAX_ALPHA * 255);
    }
  }
  return pixels;
}

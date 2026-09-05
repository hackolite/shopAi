/**
 * Large HUD pinned to the top-right of the 3D viewport showing the customer
 * journey and exposed-margin (rendement) metrics selected (« squares ») in the
 * « Waypoints & rendement » panel.
 *
 * It is drawn as a THREE sprite *inside* the WebGL canvas — unlike an HTML
 * overlay — so it is captured by `canvas.captureStream` and therefore appears
 * in the recorded video of the scene.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useCatalogStore } from '../store/catalogStore';
import { usePlanogramStore } from '../store/planogramStore';
import { useSceneStore } from '../store/sceneStore';
import { useSimulationStore } from '../store/simulationStore';
import {
  computeJourneySummary,
  journeyMetricDisplay,
  type JourneyMetricId,
  type JourneySummary,
} from '../engine/journeyMetrics';
import { buildMarginHeatmap } from '../engine/marginHeatmap';
import { computeAbsoluteYield, type AbsoluteYieldStats } from '../engine/absoluteYield';
import { yieldMetricDisplay, type YieldMetricId } from '../engine/yieldMetrics';

/** Distance (camera units) at which the HUD plane is placed in front of the camera. */
const HUD_DISTANCE = 10;
/** Screen-height fraction taken by one metric row. */
const ROW_SCREEN_FRACTION = 0.085;
/** Screen-height fraction kept between the HUD and the viewport edges. */
const MARGIN_SCREEN_FRACTION = 0.03;

/** Canvas raster size of one row (px) — large enough to stay sharp in videos. */
const ROW_HEIGHT_PX = 96;
const ROW_WIDTH_PX = 560;
const PADDING_PX = 18;

/** Yellow used by affluence / customer-journey rows (and the chrono). */
const JOURNEY_COLOR = '#fbbf24';
const JOURNEY_BORDER = 'rgba(251, 191, 36, 0.9)';
/** Blue used by every exposed-margin (rendement) row. */
const YIELD_COLOR = '#60a5fa';
const YIELD_BORDER = 'rgba(96, 165, 250, 0.9)';

/** Formats elapsed simulation seconds as MM:SS (or H:MM:SS past one hour). */
function formatChrono(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface HudRow {
  label: string;
  value: string;
  color: string;
  border: string;
}

function drawHudTexture(
  journeyMetrics: JourneyMetricId[],
  summary: JourneySummary,
  yieldMetrics: YieldMetricId[],
  yieldStats: AbsoluteYieldStats | null,
  chrono: string | null,
): THREE.CanvasTexture {
  const rows: HudRow[] = [
    ...(chrono !== null
      ? [{ label: 'Chrono', value: chrono, color: JOURNEY_COLOR, border: JOURNEY_BORDER }]
      : []),
    ...yieldMetrics.map((metricId) => ({
      ...yieldMetricDisplay(metricId, yieldStats),
      color: YIELD_COLOR,
      border: YIELD_BORDER,
    })),
    ...journeyMetrics.map((metricId) => ({
      ...journeyMetricDisplay(metricId, summary),
      color: JOURNEY_COLOR,
      border: JOURNEY_BORDER,
    })),
  ];
  const canvas = document.createElement('canvas');
  canvas.width = ROW_WIDTH_PX;
  canvas.height = ROW_HEIGHT_PX * rows.length;
  const ctx = canvas.getContext('2d')!;

  rows.forEach(({ label, value, color, border }, index) => {
    const top = index * ROW_HEIGHT_PX;
    ctx.fillStyle = 'rgba(3, 7, 18, 0.82)';
    ctx.fillRect(0, top + 2, ROW_WIDTH_PX, ROW_HEIGHT_PX - 4);
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, top + 3, ROW_WIDTH_PX - 2, ROW_HEIGHT_PX - 6);

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9ca3af';
    ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(label.toUpperCase(), PADDING_PX, top + ROW_HEIGHT_PX * 0.3);

    ctx.fillStyle = color;
    ctx.font = '700 44px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(value, PADDING_PX, top + ROW_HEIGHT_PX * 0.68);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function JourneyMetricsHud() {
  const pinnedJourneyMetrics = useSimulationStore((state) => state.pinnedJourneyMetrics);
  const pinnedYieldMetrics = useSimulationStore((state) => state.pinnedYieldMetrics);
  const customers = useSimulationStore((state) => state.analytics?.customers);
  const visitHeatmap = useSimulationStore((state) => state.analytics?.visitHeatmap);
  const timeSeconds = useSimulationStore((state) => state.analytics?.timeSeconds);
  const playing = useSimulationStore((state) => state.playing);
  // Simulation clock: last live frame time, ticking from the launch of the run
  // (and naturally frozen while the simulation is paused).
  const simTimeSeconds = useSimulationStore(
    (state) => state.result?.frames[state.result.frames.length - 1]?.timeSeconds,
  );
  const scene = useSceneStore((state) => state.scene);
  const planogramDetails = usePlanogramStore((state) => state.planogramDetails);
  const catalogProducts = useCatalogStore((state) => state.products);
  const spriteRef = useRef<THREE.Sprite>(null);

  // Whole-second chrono string so the HUD texture is only redrawn once per
  // second, not on every 100ms live tick.
  const chrono = playing ? formatChrono(simTimeSeconds ?? 0) : null;

  const summary = useMemo(() => computeJourneySummary(customers), [customers]);

  // Margin (€) exposed on the floor: derived from the assortment only, so it is
  // recomputed when the layout changes, not on every analytics tick.
  const marginHeatmap = useMemo(() => {
    if (pinnedYieldMetrics.length === 0 || !scene) return null;
    return buildMarginHeatmap(scene, planogramDetails.values(), catalogProducts);
  }, [catalogProducts, pinnedYieldMetrics.length, planogramDetails, scene]);

  const yieldStats = useMemo(
    () => computeAbsoluteYield(marginHeatmap, visitHeatmap, timeSeconds ?? 0),
    [marginHeatmap, timeSeconds, visitHeatmap],
  );

  const rowCount =
    (chrono !== null ? 1 : 0) + pinnedYieldMetrics.length + pinnedJourneyMetrics.length;
  const texture = useMemo(
    () =>
      rowCount > 0
        ? drawHudTexture(pinnedJourneyMetrics, summary, pinnedYieldMetrics, yieldStats, chrono)
        : null,
    [chrono, pinnedJourneyMetrics, pinnedYieldMetrics, rowCount, summary, yieldStats],
  );
  useEffect(() => () => { texture?.dispose(); }, [texture]);

  // Re-pin the sprite to the top-right of the frustum every frame so it stays
  // screen-fixed while the camera orbits (and inside every recorded frame).
  useFrame(({ camera }) => {
    const sprite = spriteRef.current;
    if (!sprite || !texture || !(camera instanceof THREE.PerspectiveCamera)) return;
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * HUD_DISTANCE;
    const halfW = halfH * camera.aspect;
    const rowH = ROW_SCREEN_FRACTION * 2 * halfH;
    const spriteH = rowH * rowCount;
    const spriteW = rowH * (ROW_WIDTH_PX / ROW_HEIGHT_PX);
    const margin = MARGIN_SCREEN_FRACTION * 2 * halfH;
    sprite.scale.set(spriteW, spriteH, 1);
    sprite.position
      .set(halfW - spriteW / 2 - margin, halfH - spriteH / 2 - margin, -HUD_DISTANCE)
      .applyMatrix4(camera.matrixWorld);
  });

  if (!texture) return null;

  return (
    <sprite ref={spriteRef} renderOrder={1000} raycast={() => null}>
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} />
    </sprite>
  );
}

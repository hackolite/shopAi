/**
 * Large HUD pinned to the top-right of the 3D viewport showing the customer
 * journey metrics selected (« squares ») in the « Waypoints & rendement »
 * panel.
 *
 * It is drawn as a THREE sprite *inside* the WebGL canvas — unlike an HTML
 * overlay — so it is captured by `canvas.captureStream` and therefore appears
 * in the recorded video of the scene.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useSimulationStore } from '../store/simulationStore';
import {
  computeJourneySummary,
  journeyMetricDisplay,
  type JourneyMetricId,
  type JourneySummary,
} from '../engine/journeyMetrics';

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

function drawHudTexture(metrics: JourneyMetricId[], summary: JourneySummary): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ROW_WIDTH_PX;
  canvas.height = ROW_HEIGHT_PX * metrics.length;
  const ctx = canvas.getContext('2d')!;

  metrics.forEach((metricId, index) => {
    const top = index * ROW_HEIGHT_PX;
    const { label, value } = journeyMetricDisplay(metricId, summary);

    ctx.fillStyle = 'rgba(3, 7, 18, 0.82)';
    ctx.fillRect(0, top + 2, ROW_WIDTH_PX, ROW_HEIGHT_PX - 4);
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, top + 3, ROW_WIDTH_PX - 2, ROW_HEIGHT_PX - 6);

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9ca3af';
    ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(label.toUpperCase(), PADDING_PX, top + ROW_HEIGHT_PX * 0.3);

    ctx.fillStyle = '#fbbf24';
    ctx.font = '700 44px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(value, PADDING_PX, top + ROW_HEIGHT_PX * 0.68);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function JourneyMetricsHud() {
  const pinnedJourneyMetrics = useSimulationStore((state) => state.pinnedJourneyMetrics);
  const customers = useSimulationStore((state) => state.analytics?.customers);
  const spriteRef = useRef<THREE.Sprite>(null);

  const summary = useMemo(() => computeJourneySummary(customers), [customers]);

  const texture = useMemo(
    () => (pinnedJourneyMetrics.length > 0 ? drawHudTexture(pinnedJourneyMetrics, summary) : null),
    [pinnedJourneyMetrics, summary],
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
    const spriteH = rowH * pinnedJourneyMetrics.length;
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

/**
 * Gamified pop-up shown above an agent right after it picks up a product:
 * a small bubble with a star/product icon (and the product name when short
 * enough to fit) that floats up and fades out over ~1.6s.
 *
 * Drawn as a THREE sprite (CanvasTexture) so it renders inside the WebGL
 * canvas — like `JourneyMetricsHud` — and stays visible in recorded videos.
 */
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import { PICKUP_POPUP_DURATION_MS, type PickupPopup } from '../store/simulationStore';

/** Product names longer than this are replaced by the icon alone. */
const MAX_INLINE_NAME_LENGTH = 20;
const CANVAS_WIDTH_PX = 320;
const CANVAS_HEIGHT_PX = 150;
const POPUP_WORLD_HEIGHT = 0.55;
/** How high (world units) the pop-up floats up over its lifetime. */
const RISE_DISTANCE = 0.5;
const BASE_Y = 0.55;

function drawPopupTexture(name: string | null): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH_PX;
  canvas.height = CANVAS_HEIGHT_PX;
  const ctx = canvas.getContext('2d')!;

  const showName = Boolean(name) && (name as string).length <= MAX_INLINE_NAME_LENGTH;
  const bubbleTop = 10;
  const bubbleHeight = 96;
  const centerX = CANVAS_WIDTH_PX / 2;

  // Speech-bubble backdrop.
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.95)';
  ctx.lineWidth = 4;
  const radius = 24;
  const bubbleWidth = CANVAS_WIDTH_PX - 24;
  const left = 12;
  ctx.beginPath();
  ctx.moveTo(left + radius, bubbleTop);
  ctx.arcTo(left + bubbleWidth, bubbleTop, left + bubbleWidth, bubbleTop + bubbleHeight, radius);
  ctx.arcTo(left + bubbleWidth, bubbleTop + bubbleHeight, left, bubbleTop + bubbleHeight, radius);
  ctx.arcTo(left, bubbleTop + bubbleHeight, left, bubbleTop, radius);
  ctx.arcTo(left, bubbleTop, left + bubbleWidth, bubbleTop, radius);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Little tail pointing down toward the agent.
  ctx.beginPath();
  ctx.moveTo(centerX - 14, bubbleTop + bubbleHeight - 2);
  ctx.lineTo(centerX, bubbleTop + bubbleHeight + 22);
  ctx.lineTo(centerX + 14, bubbleTop + bubbleHeight - 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#facc15';
  ctx.font = `${showName ? 40 : 52}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText('⭐', centerX, bubbleTop + (showName ? 30 : bubbleHeight / 2));

  if (showName) {
    ctx.fillStyle = '#f8fafc';
    ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(name as string, centerX, bubbleTop + bubbleHeight - 20);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function PopupSprite({
  popup,
  agentPoses,
}: {
  popup: PickupPopup;
  agentPoses: MutableRefObject<Map<number, { x: number; z: number }>>;
}) {
  const spriteRef = useRef<THREE.Sprite>(null);
  const texture = useMemo(() => drawPopupTexture(popup.name), [popup.name]);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame(() => {
    const sprite = spriteRef.current;
    if (!sprite) return;
    const elapsed = performance.now() - popup.createdAt;
    const progress = Math.min(1, Math.max(0, elapsed / PICKUP_POPUP_DURATION_MS));
    const pose = agentPoses.current.get(popup.agentId);
    const x = pose?.x ?? popup.xCm * CM_TO_UNIT;
    const z = pose?.z ?? popup.zCm * CM_TO_UNIT;
    sprite.position.set(x, BASE_Y + progress * RISE_DISTANCE, z);
    const fadeStart = 0.6;
    const opacity = progress <= fadeStart ? 1 : 1 - (progress - fadeStart) / (1 - fadeStart);
    (sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, opacity);
    const scale = 0.85 + 0.15 * Math.min(1, elapsed / 180);
    sprite.scale.set(POPUP_WORLD_HEIGHT * (CANVAS_WIDTH_PX / CANVAS_HEIGHT_PX) * scale, POPUP_WORLD_HEIGHT * scale, 1);
  });

  return (
    <sprite ref={spriteRef} renderOrder={1200} raycast={() => null}>
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} />
    </sprite>
  );
}

export function PickupPopups({
  popups,
  agentPoses,
}: {
  popups: PickupPopup[];
  agentPoses: MutableRefObject<Map<number, { x: number; z: number }>>;
}) {
  if (popups.length === 0) return null;
  return (
    <>
      {popups.map((popup) => (
        <PopupSprite key={popup.id} popup={popup} agentPoses={agentPoses} />
      ))}
    </>
  );
}

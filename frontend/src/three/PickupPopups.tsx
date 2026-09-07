/**
 * Gamified pop-up shown above an agent right after it picks up a product:
 * a small bubble with a star/product icon and the product name (brand
 * included when known) — always shown, wrapped/truncated onto a few lines
 * when long rather than dropped — that floats up and fades out slowly,
 * over ~5s.
 *
 * Drawn as a THREE sprite (CanvasTexture) so it renders inside the WebGL
 * canvas — like `JourneyMetricsHud` — and stays visible in recorded videos.
 */
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import { PICKUP_POPUP_DURATION_MS, type PickupPopup } from '../store/simulationStore';

const CANVAS_WIDTH_PX = 320;
const CANVAS_HEIGHT_PX = 150;
const POPUP_WORLD_HEIGHT = 0.55;
/** How high (world units) the pop-up floats up over its lifetime. */
const RISE_DISTANCE = 0.5;
const BASE_Y = 0.55;

/** The product-name text used to be rendered at 22px in a 150px-tall canvas
 * scaled to `POPUP_WORLD_HEIGHT` world units — unreadably small in-world.
 * The pop-up bubble now grows to fit a much bigger label instead of just
 * shrinking the font: this is the label's world-space text height the
 * layout below targets (`NAME_SIZE_MULTIPLIER` times the original one). */
const NAME_SIZE_MULTIPLIER = 5;
const BASE_NAME_FONT_PX = 22;
const TARGET_NAME_WORLD_TEXT_HEIGHT =
  (BASE_NAME_FONT_PX / CANVAS_HEIGHT_PX) * POPUP_WORLD_HEIGHT * NAME_SIZE_MULTIPLIER;

/** Raster size used to draw the (much bigger) product name; the pop-up's
 * world-space scale is derived from this so the rendered text always ends up
 * at `TARGET_NAME_WORLD_TEXT_HEIGHT`, whatever canvas size wrapping needs. */
const NAME_FONT_PX = 64;
const NAME_LINE_HEIGHT_PX = Math.round(NAME_FONT_PX * 1.2);
const MAX_NAME_LINES = 3;
const NAME_CANVAS_WIDTH_PX = 480;
const NAME_STAR_FONT_PX = 56;

/** Greedily wraps `text` into at most `maxLines` lines that fit `maxWidth`.
 * Returns `null` when the text cannot fit within that budget (caller falls
 * back to truncating with an ellipsis). */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) return null;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length <= maxLines ? lines : null;
}

/** Same greedy wrap as `wrapText`, but always returns exactly `maxLines`
 * lines, truncating the last one with an ellipsis if the text overflows. */
function wrapTextTruncated(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

/** Speech-bubble backdrop with a little tail pointing down toward the agent. */
function drawBubbleBackdrop(ctx: CanvasRenderingContext2D, canvasWidth: number, bubbleTop: number, bubbleHeight: number): void {
  const centerX = canvasWidth / 2;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.95)';
  ctx.lineWidth = 4;
  const radius = 24;
  const bubbleWidth = canvasWidth - 24;
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
  ctx.beginPath();
  ctx.moveTo(centerX - 14, bubbleTop + bubbleHeight - 2);
  ctx.lineTo(centerX, bubbleTop + bubbleHeight + 22);
  ctx.lineTo(centerX + 14, bubbleTop + bubbleHeight - 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fill();
}

/** Renders the pop-up texture. Returns the texture together with the actual
 * canvas aspect ratio and the world height to apply so the label (when
 * shown) always renders at `TARGET_NAME_WORLD_TEXT_HEIGHT`. */
function drawPopupTexture(name: string | null): { texture: THREE.CanvasTexture; aspect: number; worldHeight: number } {
  const showName = Boolean(name);

  if (!showName) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH_PX;
    canvas.height = CANVAS_HEIGHT_PX;
    const ctx = canvas.getContext('2d')!;
    const centerX = CANVAS_WIDTH_PX / 2;
    const bubbleTop = 10;
    const bubbleHeight = 96;
    drawBubbleBackdrop(ctx, CANVAS_WIDTH_PX, bubbleTop, bubbleHeight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#facc15';
    ctx.font = '52px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('⭐', centerX, bubbleTop + bubbleHeight / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return { texture, aspect: CANVAS_WIDTH_PX / CANVAS_HEIGHT_PX, worldHeight: POPUP_WORLD_HEIGHT };
  }

  // Name shown: the bubble grows to fit a much bigger label instead of
  // cramming it into the fixed icon-only canvas.
  const canvasWidth = NAME_CANVAS_WIDTH_PX;
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d')!;
  const textMaxWidth = canvasWidth - 64;
  measureCtx.font = `600 ${NAME_FONT_PX}px ui-sans-serif, system-ui, sans-serif`;
  const lines =
    wrapText(measureCtx, name as string, textMaxWidth, MAX_NAME_LINES) ??
    wrapTextTruncated(measureCtx, name as string, textMaxWidth, MAX_NAME_LINES);

  const bubbleTop = 14;
  const starAreaHeight = 74;
  const namePaddingTop = 12;
  const namePaddingBottom = 20;
  const tailHeight = 24;
  const bubbleHeight = starAreaHeight + namePaddingTop + lines.length * NAME_LINE_HEIGHT_PX + namePaddingBottom;
  const canvasHeight = Math.ceil(bubbleTop * 2 + bubbleHeight + tailHeight);

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d')!;
  const centerX = canvasWidth / 2;
  drawBubbleBackdrop(ctx, canvasWidth, bubbleTop, bubbleHeight);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#facc15';
  ctx.font = `${NAME_STAR_FONT_PX}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText('⭐', centerX, bubbleTop + starAreaHeight / 2);

  ctx.fillStyle = '#f8fafc';
  ctx.font = `600 ${NAME_FONT_PX}px ui-sans-serif, system-ui, sans-serif`;
  let lineY = bubbleTop + starAreaHeight + namePaddingTop + NAME_LINE_HEIGHT_PX / 2;
  for (const line of lines) {
    ctx.fillText(line, centerX, lineY);
    lineY += NAME_LINE_HEIGHT_PX;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const worldHeight = (TARGET_NAME_WORLD_TEXT_HEIGHT * canvasHeight) / NAME_FONT_PX;
  return { texture, aspect: canvasWidth / canvasHeight, worldHeight };
}

function PopupSprite({
  popup,
  agentPoses,
}: {
  popup: PickupPopup;
  agentPoses: MutableRefObject<Map<number, { x: number; z: number }>>;
}) {
  const spriteRef = useRef<THREE.Sprite>(null);
  const { texture, aspect, worldHeight } = useMemo(() => drawPopupTexture(popup.name), [popup.name]);
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
    sprite.scale.set(worldHeight * aspect * scale, worldHeight * scale, 1);
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

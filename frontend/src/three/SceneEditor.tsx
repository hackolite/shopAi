import { Suspense, useState, useRef, useEffect, useLayoutEffect, useCallback, createContext, useContext, useMemo } from 'react';
import type React from 'react';
import { Canvas, useThree, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Html, TransformControls, Grid, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useSceneStore } from '../store/sceneStore';
import { useUIStore } from '../store/uiStore';
import { usePlanogramStore } from '../store/planogramStore';
import { useCatalogStore } from '../store/catalogStore';
import { useZoneStore } from '../store/zoneStore';
import type { FloorZone, Planogram } from '../types/cad';
import { cadApi } from '../api/cad';
import { CM_TO_UNIT } from '../constants';
import type { ActiveTool } from '../store/uiStore';
import type { FurnitureInstance, StoreConfig } from '../types/cad';

// ─── Grid / snap constants ─────────────────────────────────────────────────────
/** Snap grid step in centimetres (1 m). */
const SNAP_CM   = 100;
/** Snap grid step in Three.js units (1 unit = 100 cm → 1 m = 1 unit). */
const SNAP_UNIT = SNAP_CM * CM_TO_UNIT;
/** Minimum furniture dimension allowed after a resize (cm). */
const MIN_DIM_CM = 20;
/** Round a centimetre value to the nearest snap grid step. */
const snapToCm = (v: number) => Math.round(v / SNAP_CM) * SNAP_CM;
/**
 * How much larger (multiplier) the grid plane is than the store footprint,
 * so it visually extends past the walls on all sides.
 */
const GRID_SIZE_MULTIPLIER = 1.4;
/**
 * Fade-out distance multiplier for the Grid component relative to the store's
 * longest dimension.  1.8× keeps the grid visible even at a high camera angle.
 */
const GRID_FADE_MULTIPLIER = 1.8;
/** Y offset of the Grid plane above the floor slab (avoids Z-fighting). */
const GRID_Y_OFFSET = 0.005;
/** Shared up-vector reused across components to avoid per-render allocations. */
const UP_VEC3 = new THREE.Vector3(0, 1, 0);

// ─── Resize handle appearance ─────────────────────────────────────────────────
const HANDLE_SIZE    = 0.12;
const HANDLE_COLOR   = '#ffcc00';
const HANDLE_HOVER   = '#ffffff';
const HANDLE_EMISSIVE = '#664400';

/** Debounce delay (ms) before persisting zone changes to the backend. */
const ZONE_AUTOSAVE_DEBOUNCE_MS = 800;
/** Video bitrate (bps) used when recording the 3D scene. */
const RECORDING_BITRATE = 8_000_000;

// ─── Camera state persistence across Canvas remounts ──────────────────────────
// When viewMode switches between '3d' and 'planogram', the SceneEditor Canvas
// unmounts and remounts, which resets the THREE.js camera to its initial
// position [25,15,35].  We save the camera position + OrbitControls target
// here (updated every frame) so they can be restored on the next mount.
let _persistedCameraState: {
  position: [number, number, number];
  target: [number, number, number];
} | null = null;

/** Default OrbitControls look-at point (store centre). */
const DEFAULT_ORBIT_TARGET: [number, number, number] = [25, 0, 15];

// ─── Mesh registry context ───────────────────────────────────────────────────
type RegisterFn = (id: string, group: THREE.Group | null) => void;
const MeshRegistryCtx = createContext<RegisterFn>(() => {});

// ─── Resize-drag context (disables OrbitControls while a resize is in progress)
const ResizeDragCtx = createContext<(dragging: boolean) => void>(() => {});

// ─── Color map ────────────────────────────────────────────────────────────────
const FURNITURE_COLORS: Record<string, string> = {
  gondola_single:    '#dde2e8',
  gondola_double:    '#d4dae2',
  fridge:            '#b8d4e8',
  fridge_horizontal: '#a8c8e0',
  register:          '#c4905a',
  wall:              '#9b9b9b',
  floor_grid:        '#7c3aed',
};

function getFurnitureColor(type: string): string {
  return FURNITURE_COLORS[type] ?? '#c8cdd3';
}

/** Tools that allow selecting furniture by clicking on it. */
const SELECTABLE_TOOLS = new Set<ActiveTool>(['select', 'translate', 'rotate', 'scale']);

// ─── Category colors for planogram face overlay ───────────────────────────────
const PLANO_CATEGORY_COLORS: Record<string, string> = {
  'Épicerie':  '#F5C518',
  'Boissons':  '#2196F3',
  'Frais':     '#4CAF50',
  'Hygiène':   '#9C27B0',
  'Bébé':      '#FF9800',
  'Promotion': '#F44336',
};

/** Small Z offset to prevent z-fighting between the overlay plane and the box face. */
const OVERLAY_Z_OFFSET = 0.002;
/** Opacity of the planogram face overlay. */
const OVERLAY_OPACITY  = 0.85;

/** Canvas pixel resolution (along the longer axis) for planogram face textures. */
const OVERLAY_CANVAS_PX = 320;

// ─── Shared drag-plane hit-test utility ──────────────────────────────────────
/**
 * Projects client-space screen coordinates onto a world-space plane using a
 * raycaster and writes the intersection point into `out`.
 *
 * @returns true if the ray intersects the plane, false otherwise.
 *
 * This utility is used by every resize/drag component (StoreBoundaryResizeHandles,
 * FurnitureResizeHandles, FloorZoneMesh, FloorZoneResizeHandles) to avoid
 * duplicating the same NDC-conversion + ray-cast logic in each.
 */
function getWorldHitPoint(
  gl: { domElement: HTMLElement },
  raycaster: THREE.Raycaster,
  camera: THREE.Camera,
  plane: THREE.Plane,
  clientX: number,
  clientY: number,
  ndc: THREE.Vector2,
  out: THREE.Vector3,
): boolean {
  const rect = gl.domElement.getBoundingClientRect();
  ndc.set(
    ((clientX - rect.left) / rect.width)  *  2 - 1,
    -((clientY - rect.top) / rect.height) *  2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(plane, out) !== null;
}

/** Returns per-column widths in cm, falling back to equal distribution. */
function getEffectiveColWidths(p: { cols: number; widthCm: number; colWidthsCm?: number[] }): number[] {
  return p.colWidthsCm?.length === p.cols
    ? p.colWidthsCm
    : Array(p.cols).fill(p.widthCm / p.cols);
}

/** Returns per-row heights in cm, falling back to equal distribution. */
function getEffectiveRowHeights(p: { rows: number; heightCm: number; rowHeightsCm?: number[] }): number[] {
  return p.rowHeightsCm?.length === p.rows
    ? p.rowHeightsCm
    : Array(p.rows).fill(p.heightCm / p.rows);
}

/**
 * Per-face Euler rotation [rx, ry, rz] (XYZ order) that places the proximity
 * half-disc flat on the floor with the curved arc extending away from the gondola
 * face toward the customer.
 *
 * Derivation: circleGeometry lies in the XY plane (normal = +Z, arc midpoint = +Y).
 * The Euler XYZ matrix Rx(rx)·Ry(ry)·Rz(rz) was solved analytically so that:
 *  - the circle's normal (+Z) maps to ±Y  → disc is horizontal
 *  - the arc midpoint (+Y) maps to the outward aisle direction per face
 *
 *  front → arc in local +Z  |  back → arc in local -Z
 *  right → arc in local +X  |  left → arc in local -X
 */
const SEMI_ROT: Record<'front' | 'back' | 'right' | 'left', [number, number, number]> = {
  front: [ Math.PI / 2, 0,             0           ],
  back:  [ Math.PI / 2, 0,             Math.PI     ],
  right: [-Math.PI / 2, 0,            -Math.PI / 2 ],
  left:  [-Math.PI / 2, 0,             Math.PI / 2 ],
};

// ─── 3D text sprite (captured by canvas.captureStream unlike Html overlays) ───
function makeTextTexture(text: string, isSelected = false): THREE.CanvasTexture {
  const fontSize = 16;
  const padding  = 8;

  const tmp    = document.createElement('canvas');
  const tmpCtx = tmp.getContext('2d')!;
  tmpCtx.font  = `${fontSize}px ui-monospace, monospace`;
  const textWidth = Math.ceil(tmpCtx.measureText(text).width);

  const cw = textWidth + padding * 2;
  const ch = fontSize + padding * 2;

  const canvas = document.createElement('canvas');
  canvas.width  = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, cw, ch);

  ctx.fillStyle = '#ffffff';
  ctx.font      = `${fontSize}px ui-monospace, monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padding, ch / 2);

  if (isSelected) {
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth   = 2;
    ctx.strokeRect(1, 1, cw - 2, ch - 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

interface TextSprite3DProps {
  text: string;
  position: [number, number, number];
  isSelected?: boolean;
  scale?: number;
}

function TextSprite3D({ text, position, isSelected = false, scale = 1 }: TextSprite3DProps) {
  const texture = useMemo(() => makeTextTexture(text, isSelected), [text, isSelected]);
  useEffect(() => () => { texture.dispose(); }, [texture]);

  const aspectRatio = texture.image.width / texture.image.height;
  const spriteH = 0.35 * scale;
  const spriteW = spriteH * aspectRatio;

  return (
    <sprite position={position} scale={[spriteW, spriteH, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

// ─── Planogram face overlay ───────────────────────────────────────────────────
type OverlayFace = 'front' | 'back' | 'left' | 'right' | 'top';

/** Renders a canvas-based texture showing product category colors on any gondola face. */
function PlanogramFaceOverlay({
  planogramId,
  W,
  H,
  D,
  face,
}: {
  planogramId: string;
  W: number;
  H: number;
  D: number;
  face: OverlayFace;
}) {
  const { planogramDetails } = usePlanogramStore();
  const setSelection    = useSceneStore((state) => state.setSelection);
  const selType         = useSceneStore((state) => state.selection.type);
  const selPlanogramId  = useSceneStore((state) => state.selection.planogramId);
  const selCellIds      = useSceneStore((state) => state.selection.cellIds);
  const selectedCellId  = selType === 'planogram_cell' && selPlanogramId === planogramId && selCellIds?.length === 1
    ? selCellIds[0]
    : null;
  const setRequestOpenPlanogramId = usePlanogramStore((state) => state.setRequestOpenPlanogramId);
  const { products } = useCatalogStore();
  const planogram = planogramDetails.get(planogramId);

  // Preload product images so they can be drawn into the canvas texture.
  const [loadedImages, setLoadedImages] = useState<Map<string, HTMLImageElement>>(new Map());

  useEffect(() => {
    const productByEan = new Map(products.map((p) => [p.ean, p]));
    const urlsByEan = new Map<string, string>();
    if (planogram) {
      for (const cell of planogram.cells) {
        const prod = productByEan.get(cell.ean);
        if (prod?.imageUrl && !urlsByEan.has(prod.ean)) {
          urlsByEan.set(prod.ean, prod.imageUrl);
        }
      }
    }

    if (urlsByEan.size === 0) {
      setLoadedImages(new Map());
      return;
    }

    let cancelled = false;
    const newImages = new Map<string, HTMLImageElement>();
    let pending = urlsByEan.size;
    const settle = () => {
      pending--;
      if (!cancelled && pending === 0) setLoadedImages(new Map(newImages));
    };
    for (const [ean, url] of urlsByEan) {
      const img = new Image();
      // Images are served from the same backend origin; crossOrigin is set so that
      // canvas.drawImage() does not taint the canvas when running from a dev server
      // that may differ from the API origin.
      img.crossOrigin = 'anonymous';
      img.onload  = () => { newImages.set(ean, img); settle(); };
      img.onerror = () => settle();
      img.src = url;
    }
    return () => { cancelled = true; };
  }, [planogram, products]);

  const texture = useMemo(() => {
    if (!planogram) return null;
    const productByEan = new Map(products.map((p) => [p.ean, p]));

    // Use proportional canvas dimensions based on physical cm sizes
    const colWidths  = getEffectiveColWidths(planogram);
    const rowHeights = getEffectiveRowHeights(planogram);
    const aspect = planogram.heightCm / planogram.widthCm;
    const canvasW = OVERLAY_CANVAS_PX;
    const canvasH = Math.max(1, Math.round(OVERLAY_CANVAS_PX * aspect));

    // Compute canvas pixel bounds for a cell, respecting per-cell width/height overrides.
    // x is determined by the widths of cells to the left in the same row;
    // y is determined by the heights of cells above in the same column.
    const getCellRectPx = (row: number, col: number) => {
      const cellWCm = planogram.cellWidthOverrides?.[`${row}-${col}`] ?? colWidths[col];
      const cellHCm = planogram.cellHeightOverrides?.[`${row}-${col}`] ?? rowHeights[row];
      let xCm = 0;
      for (let c = 0; c < col; c++) {
        xCm += planogram.cellWidthOverrides?.[`${row}-${c}`] ?? colWidths[c];
      }
      let yCm = 0;
      for (let r = 0; r < row; r++) {
        yCm += planogram.cellHeightOverrides?.[`${r}-${col}`] ?? rowHeights[r];
      }
      return {
        x: Math.round((xCm / planogram.widthCm) * canvasW),
        y: Math.round((yCm / planogram.heightCm) * canvasH),
        w: Math.max(1, Math.round((cellWCm / planogram.widthCm) * canvasW) - 2),
        h: Math.max(1, Math.round((cellHCm / planogram.heightCm) * canvasH) - 2),
      };
    };

    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, canvasW);
    canvas.height = Math.max(1, canvasH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#1c2030';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const cell of planogram.cells) {
      const prod  = productByEan.get(cell.ean);
      const color = prod ? (PLANO_CATEGORY_COLORS[prod.category] ?? '#888888') : '#444455';
      ctx.fillStyle = color;
      const { x: cx, y: cy, w: cw, h: ch } = getCellRectPx(cell.row, cell.col);
      ctx.fillRect(cx + 1, cy + 1, cw, ch);
      // Draw product image on top of the colour block when available
      const img = prod ? loadedImages.get(prod.ean) : null;
      if (img) {
        ctx.drawImage(img, cx + 1, cy + 1, cw, ch);
      }
    }

    // Highlight the selected cell with a bright yellow outline + tint
    if (selectedCellId) {
      const selCell = planogram.cells.find((c) => c.id === selectedCellId);
      if (selCell) {
        const { x: cx, y: cy, w: cw, h: ch } = getCellRectPx(selCell.row, selCell.col);
        ctx.fillStyle = 'rgba(255,230,0,0.35)';
        ctx.fillRect(cx + 1, cy + 1, cw, ch);
        ctx.strokeStyle = '#ffe000';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx + 1, cy + 1, cw, ch);
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    // The back overlay plane is rotated π about Y (see position/rotation below). We
    // deliberately keep the texture un-flipped so the back reads as a true MIRROR of
    // the front: data column 0 renders at the plane's local −X, which the π rotation
    // maps to the gondola's +X end. Seen from the back aisle this places column 0 on
    // the back viewer's left, and a column inserted at the start of the back
    // planogram (its left) therefore lands on the same physical (+X) end of the
    // gondola as a column appended to the front — keeping the two faces coherent.
    return tex;
  }, [planogram, products, selectedCellId, loadedImages]);

  useEffect(() => {
    return () => { texture?.dispose(); };
  }, [texture]);

  const handleClick = useCallback((event: ThreeEvent<MouseEvent>) => {
    if (!planogram) return;

    // Ctrl+click (or Cmd+click on Mac) → open the planogram in the editor
    if (event.nativeEvent.ctrlKey || event.nativeEvent.metaKey) {
      event.stopPropagation();
      setRequestOpenPlanogramId(planogram.id);
      return;
    }

    if (!event.uv) return;

    // Map UV coordinates to column/row using proportional physical sizes so that
    // clicking on a resized (wider/narrower) column correctly identifies it.
    const colWidths  = getEffectiveColWidths(planogram);
    const rowHeights = getEffectiveRowHeights(planogram);

    // Determine the row first so we can use per-row cell widths when mapping the
    // UV X coordinate to a column.  After gondola operations (add/remove column,
    // fuse, split) each row may have a different number of columns with non-uniform
    // widths recorded in cellWidthOverrides; using the global equal-width fallback
    // would map clicks to wrong (or non-existent) cells.
    const uvY = Math.min(1, Math.max(0, 1 - event.uv.y)); // flip: UV.y=1 is top, row 0 is top
    let row = planogram.rows - 1;
    let cumH = 0;
    for (let i = 0; i < rowHeights.length; i++) {
      cumH += rowHeights[i] / planogram.heightCm;
      if (uvY <= cumH) { row = i; break; }
    }

    // Use per-row column widths (cellWidthOverrides keyed as "{row}-{col}") with a
    // fallback to the global colWidths so legacy planograms without overrides still work.
    // The click's UV.x is in the plane's own UV space (independent of the plane's world
    // rotation) and the back texture is no longer flipped, so the same mapping applies
    // to every face: UV.x runs left→right over the columns exactly as drawn.
    const uvX = Math.min(1, Math.max(0, event.uv.x));
    const rowColCount = planogram.rowColCounts?.[row] ?? planogram.cols;
    let col = rowColCount - 1;
    let cumW = 0;
    for (let c = 0; c < rowColCount; c++) {
      const cellW = planogram.cellWidthOverrides?.[`${row}-${c}`] ?? colWidths[c] ?? (planogram.widthCm / rowColCount);
      cumW += cellW / planogram.widthCm;
      if (uvX <= cumW) { col = c; break; }
    }

    const cell = planogram.cells.find((item) => item.row === row && item.col === col);
    if (!cell) return;
    event.stopPropagation();

    // Second click on the same cell → deselect and hide the proximity disc
    if (
      selType === 'planogram_cell' &&
      selPlanogramId === planogram.id &&
      selCellIds?.includes(cell.id)
    ) {
      setSelection({ type: null });
      return;
    }

    setSelection({
      type: 'planogram_cell',
      ean: cell.ean,
      furnitureId: planogram.furnitureId,
      planogramId: planogram.id,
      cellIds: [cell.id],
    });
  }, [planogram, selType, selPlanogramId, selCellIds, setSelection, setRequestOpenPlanogramId]);

  if (!texture || !planogram) return null;

  // Overlay plane is sized to the planogram's physical dimensions (not the gondola face),
  // so that products always render at the same scale regardless of gondola size changes.
  const planoW = planogram.widthCm  * CM_TO_UNIT;
  const planoH = planogram.heightCm * CM_TO_UNIT;

  // Top-align vertically: when the planogram is shorter than the gondola the plane is
  // shifted upward so row 0 always starts at the top of the face.
  const yOffset = (H - planoH) / 2;

  // Left-align horizontally: shift the overlay toward the gondola's local -X edge so
  // that the overlay's left edge sits at the local -X edge of the face (rather than
  // being centred). Front and top place data column 0 at that -X edge. The back plane
  // is rotated π about Y and its texture is left un-flipped (see texture memo), so it
  // is a mirror: its data column 0 lands at the gondola's +X end while its overlay
  // still spans from the same local -X edge.
  // For front/back/top faces the horizontal axis is the gondola's X axis (face width = W).
  // For left/right faces the horizontal axis is the gondola's Z axis (face width = D).
  const xOffFrontBack = (planoW - W) / 2; // negative → shift toward -X (left)
  const zOffSide      = (D - planoW) / 2; // positive → shift toward +Z (gondola front = viewer left)

  // Compute position and rotation for each face (top- and left-aligned on the gondola face)
  let position: [number, number, number];
  let rotation: [number, number, number];

  switch (face) {
    case 'front':
      position = [xOffFrontBack, yOffset,  D / 2 + OVERLAY_Z_OFFSET];
      rotation = [0, 0, 0];
      break;
    case 'back':
      // The back plane is rotated π about Y so it faces the opposite aisle. The texture
      // is NOT flipped (see texture memo), so the back reads as a true mirror of the
      // front: data column 0 lands at the plane's local −X which the π rotation maps to
      // the gondola's +X end. A column appended to the front (its right, +X) and a
      // column inserted at the start of the back planogram (its left) therefore both
      // appear on the same physical (+X) end of the gondola.
      position = [xOffFrontBack, yOffset, -(D / 2 + OVERLAY_Z_OFFSET)];
      rotation = [0, Math.PI, 0];
      break;
    case 'left':
      // Rotation [0, -π/2, 0]: overlay local +x → gondola local +z.
      // zOffSide centres the overlay starting from the +Z (front) side of the gondola,
      // which is "left" from the customer's perspective walking along the aisle.
      position = [-(W / 2 + OVERLAY_Z_OFFSET), yOffset, zOffSide];
      rotation = [0, -Math.PI / 2, 0];
      break;
    case 'right':
      // Rotation [0, +π/2, 0]: overlay local +x → gondola local -z.
      // Same front-of-gondola left-alignment as the left face.
      position = [ W / 2 + OVERLAY_Z_OFFSET, yOffset, zOffSide];
      rotation = [0, Math.PI / 2, 0];
      break;
    case 'top':
      position = [xOffFrontBack, H / 2 + OVERLAY_Z_OFFSET, 0];
      rotation = [-Math.PI / 2, 0, 0];
      break;
    default: {
      const _exhaustive: never = face;
      throw new Error(`Unhandled face: ${_exhaustive}`);
    }
  }

  return (
    <mesh position={position} rotation={rotation} onClick={handleClick}>
      <planeGeometry args={[planoW, planoH]} />
      <meshBasicMaterial map={texture} transparent opacity={OVERLAY_OPACITY} depthWrite={false} />
    </mesh>
  );
}

// ─── Furniture Mesh ───────────────────────────────────────────────────────────
interface FurnitureMeshProps {
  furniture: FurnitureInstance;
}

function FurnitureMesh({ furniture }: FurnitureMeshProps) {
  const [hovered, setHovered] = useState(false);
  const { selectedFurnitureId, selectedFurnitureIds, selectFurniture, toggleFurnitureSelection, selection } = useSceneStore();
  const { activeTool } = useUIStore();
  const registerGroup = useContext(MeshRegistryCtx);
  const groupRef = useRef<THREE.Group>(null!);

  const isSelected  = selectedFurnitureId === furniture.id || selectedFurnitureIds.has(furniture.id);
  // Used only for material appearance (roughness/metalness), not for overlay logic.
  const isGondolaStyle = furniture.type.startsWith('gondola');

  const W  = furniture.dimensions.width  * CM_TO_UNIT;
  const H  = furniture.dimensions.height * CM_TO_UNIT;
  const D  = furniture.dimensions.depth  * CM_TO_UNIT;
  const px = furniture.position[0] * CM_TO_UNIT;
  const py = furniture.position[1] * CM_TO_UNIT;
  const pz = furniture.position[2] * CM_TO_UNIT;
  const ry = furniture.rotation[1] * (Math.PI / 180);

  const baseColor = getFurnitureColor(furniture.type);
  const color = isSelected ? '#4a9eff' : hovered ? '#a8c8ff' : baseColor;

  const { selectZone } = useZoneStore();
  const { planogramDetails } = usePlanogramStore();

  // Detect product selection on this gondola (planogram cell click)
  const isProductSelected =
    selection.type === 'planogram_cell' && selection.furnitureId === furniture.id;

  // Determine which face of the gondola the selected planogram belongs to, so
  // the semi-circle can be oriented correctly (flat edge = gondola face, arc = aisle).
  const selectedFace = isProductSelected && selection.planogramId
    ? (Object.entries(furniture.faces) as [string, string | null][])
        .find(([, pid]) => pid === selection.planogramId)?.[0] ?? 'front'
    : 'front';

  // Per-face Euler rotation is defined at module level as SEMI_ROT.
  // Fallback semi-circle config (gondola centre) used when planogram data is unavailable.
  const defaultSemiCircleConfig: Record<string, { pos: [number, number, number]; rot: [number, number, number] }> = {
    front: { pos: [0,      -H / 2 + 0.02,  D / 2], rot: SEMI_ROT.front },
    back:  { pos: [0,      -H / 2 + 0.02, -D / 2], rot: SEMI_ROT.back  },
    right: { pos: [ W / 2, -H / 2 + 0.02, 0     ], rot: SEMI_ROT.right },
    left:  { pos: [-W / 2, -H / 2 + 0.02, 0     ], rot: SEMI_ROT.left  },
  };

  // Compute per-cell semi-circle config when a product cell is selected.
  // Memoised so that unrelated state changes (e.g. another furniture moving) do
  // not trigger a repeat O(n) cell lookup.
  type SemiConfig = Record<string, { pos: [number, number, number]; rot: [number, number, number] }>;

  const computedSemiCircleConfig = useMemo<SemiConfig | null>(() => {
    if (!isProductSelected || !selection.planogramId || !selection.cellIds?.length) return null;
    const planogram = planogramDetails.get(selection.planogramId);
    const cell = planogram?.cells.find((c) => c.id === selection.cellIds![0]);
    if (!planogram || !cell) return null;

    // t ∈ [0,1]: normalised centre of the cell column using actual physical widths
    // so that resized columns place the proximity disc at the correct position.
    // Use per-row cellWidthOverrides (set for every box by gondolaToLegacyPlanogram)
    // so that columns created/modified by add-col, fuse, or split are placed correctly.
    const colWidths = getEffectiveColWidths(planogram);
    const rowColCount = planogram.rowColCounts?.[cell.row] ?? planogram.cols;
    let cumW = 0;
    for (let i = 0; i < cell.col; i++) {
      cumW += planogram.cellWidthOverrides?.[`${cell.row}-${i}`] ?? colWidths[i] ?? (planogram.widthCm / rowColCount);
    }
    const cellW = planogram.cellWidthOverrides?.[`${cell.row}-${cell.col}`] ?? colWidths[cell.col] ?? (planogram.widthCm / rowColCount);
    const t = (cumW + cellW / 2) / planogram.widthCm;

    const cellXf =  t * W - W / 2;  // front: col 0 → local −X
    const cellXb =  W / 2 - t * W;  // back: mirror of front → col 0 → local +X
    const cellZr = D / 2 - t * D;   // right: col=0 → local +Z
    const cellZl = t * D - D / 2;   // left: mirrored in Z relative to right
    return {
      front: { pos: [cellXf,  -H / 2 + 0.02,  D / 2]  as [number, number, number], rot: SEMI_ROT.front },
      back:  { pos: [cellXb,  -H / 2 + 0.02, -D / 2]  as [number, number, number], rot: SEMI_ROT.back  },
      right: { pos: [ W / 2,  -H / 2 + 0.02,  cellZr] as [number, number, number], rot: SEMI_ROT.right },
      left:  { pos: [-W / 2,  -H / 2 + 0.02,  cellZl] as [number, number, number], rot: SEMI_ROT.left  },
    };
  // Deps explanation: W, H, D are included intentionally — resizing the furniture shifts
  // the disc positions so the config must be recomputed when dimensions change.
  // `selection.cellIds` is an array whose reference changes on every selection update;
  // using it directly is correct because any selection change should retrigger the lookup.
  }, [isProductSelected, selection.planogramId, selection.cellIds, planogramDetails, W, H, D]);

  const semiCircleConfig: SemiConfig = computedSemiCircleConfig ?? defaultSemiCircleConfig;
  const scc = semiCircleConfig[selectedFace] ?? semiCircleConfig.front;

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    // Ctrl/Cmd+click → toggle this furniture in the multi-selection group.
    if (e.nativeEvent.ctrlKey || e.nativeEvent.metaKey) {
      toggleFurnitureSelection(furniture.id);
      return;
    }
    if (!SELECTABLE_TOOLS.has(activeTool)) return;
    selectFurniture(furniture.id);
    selectZone(null);
  };

  // Callback ref keeps the registry entry fresh on every re-render and handles unmount
  const setGroupRef = useCallback((node: THREE.Group | null) => {
    groupRef.current = node!;
    registerGroup(furniture.id, node);
  }, [furniture.id, registerGroup]);

  if (!furniture.visible) return null;

  return (
    <group
      ref={setGroupRef}
      position={[px + W / 2, py + H / 2, pz + D / 2]}
      rotation={[0, ry, 0]}
      onClick={handleClick}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
    >
      {/* Register: floor highlight showing customer passage zone */}
      {furniture.type === 'register' && (
        <group>
          {/* Amber glow under the register footprint */}
          <mesh position={[0, -H / 2 + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[W + 0.5, D + 0.5]} />
            <meshBasicMaterial color="#f59e0b" transparent opacity={0.5} depthWrite={false} />
          </mesh>
          {/* Customer passage lane extending from the front face (+Z local) */}
          <mesh position={[0, -H / 2 + 0.01, D / 2 + 1.5]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[W, 3.0]} />
            <meshBasicMaterial color="#f59e0b" transparent opacity={0.22} depthWrite={false} />
          </mesh>
        </group>
      )}

      {/* Main body — simple box for all furniture types */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[W, H, D]} />
        <meshStandardMaterial
          color={color}
          emissive={isSelected ? '#1a3a6a' : hovered ? '#1a1a3a' : '#000000'}
          emissiveIntensity={isSelected ? 0.35 : hovered ? 0.12 : 0}
          roughness={isGondolaStyle ? 0.4 : 0.55}
          metalness={isGondolaStyle ? 0.5 : 0.25}
        />
      </mesh>

      {/* Top face cap — colored to match the floor rectangle for easy furniture-type recognition.
          Hidden when a planogram is assigned to the top face (the overlay covers it instead).
          Raised by OVERLAY_Z_OFFSET to avoid z-fighting with the box's top face. */}
      {!furniture.faces.top && (() => {
        const topFill = getUnmountedColor(furniture.type).fill;
        return (
          <mesh position={[0, H / 2 + OVERLAY_Z_OFFSET, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[W, D]} />
            <meshStandardMaterial
              color={isSelected ? '#4a9eff' : topFill}
              emissive={isSelected ? '#1a3a6a' : '#000000'}
              emissiveIntensity={isSelected ? 0.35 : 0}
              roughness={0.45}
              metalness={0.2}
            />
          </mesh>
        );
      })()}

      {/* Floor grid: interior row/col lines on the top face */}
      {furniture.type === 'floor_grid' && (() => {
        const topPlanogramId = furniture.faces.top ?? null;
        const topPlanogram   = topPlanogramId ? planogramDetails.get(topPlanogramId) : null;
        const rows      = topPlanogram?.rows ?? 3;
        const cols      = topPlanogram?.cols ?? 4;
        const gridY     = H / 2 + 0.005;
        const gridColor = isSelected ? '#ffffff' : '#c084fc';
        const lines: JSX.Element[] = [];
        for (let c = 1; c < cols; c++) {
          const gx = c * (W / cols) - W / 2;
          lines.push(
            <Line
              key={`fg-col${c}`}
              points={[[gx, gridY, -D / 2], [gx, gridY, D / 2]] as [number, number, number][]}
              color={gridColor}
              lineWidth={1}
            />,
          );
        }
        for (let r = 1; r < rows; r++) {
          const gz = r * (D / rows) - D / 2;
          lines.push(
            <Line
              key={`fg-row${r}`}
              points={[[-W / 2, gridY, gz], [W / 2, gridY, gz]] as [number, number, number][]}
              color={gridColor}
              lineWidth={1}
            />,
          );
        }
        return <group>{lines}</group>;
      })()}

      {/* Customer proximity semi-circle — 2 m radius, shown when a product cell on this
          gondola is selected. Flat edge = gondola face; arc extends into the aisle. */}
      {isProductSelected && (
        <mesh position={scc.pos} rotation={scc.rot}>
          <circleGeometry args={[2, 64, 0, Math.PI]} />
          <meshBasicMaterial color="#ff69b4" transparent opacity={0.28} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}

      {/* Planogram face overlays — rendered for any furniture face that has an assigned planogram */}
      {(['front', 'back', 'left', 'right', 'top'] as const).map((face) => {
        const planogramId = furniture.faces[face];
        return planogramId ? (
          <PlanogramFaceOverlay key={face} planogramId={planogramId} W={W} H={H} D={D} face={face} />
        ) : null;
      })}

      {/* Name label — rendered as a 3D sprite so it is captured by canvas.captureStream */}
      <TextSprite3D
        text={furniture.name}
        position={[0, H / 2 + 0.3, 0]}
        isSelected={isSelected}
      />
    </group>
  );
}

// ─── TransformProxy (translate / rotate only) ─────────────────────────────────
interface TransformProxyProps {
  furniture: FurnitureInstance;
  transformTarget: THREE.Group;
  mode: 'translate' | 'rotate';
  projectId: string | null;
}

function TransformProxy({ furniture, transformTarget, mode, projectId }: TransformProxyProps) {
  const { updateFurniture } = useSceneStore();

  const handleMouseUp = useCallback(() => {
    const obj = transformTarget;
    if (!obj) return;

    if (mode === 'translate') {
      const W = furniture.dimensions.width  * CM_TO_UNIT;
      const H = furniture.dimensions.height * CM_TO_UNIT;
      const D = furniture.dimensions.depth  * CM_TO_UNIT;
      const newPos: [number, number, number] = [
        snapToCm((obj.position.x - W / 2) / CM_TO_UNIT),
        0,
        snapToCm((obj.position.z - D / 2) / CM_TO_UNIT),
      ];
      obj.position.set(newPos[0] * CM_TO_UNIT + W / 2, H / 2, newPos[2] * CM_TO_UNIT + D / 2);
      const updated = { ...furniture, position: newPos };
      updateFurniture(updated);
      if (projectId) cadApi.updateFurniture(projectId, furniture.id, updated).catch(console.error);
    }

    if (mode === 'rotate') {
      // Use the quaternion to extract the Y-rotation angle instead of reading
      // obj.rotation.y directly.  Three.js represents the 180° quaternion
      // (0,1,0,0) back as Euler (π, 0, π) in XYZ order, so rotation.y reads
      // as 0 at exactly 180°, which would silently save the wrong value.
      // `2 * atan2(q.y, q.w)` recovers the correct angle for any pure-Y rotation.
      const q = obj.quaternion;
      const rotYRad = 2 * Math.atan2(q.y, q.w);
      const newRotY = rotYRad * (180 / Math.PI);
      const snappedRotY = Math.round(newRotY / 90) * 90;
      // Reset to a clean Euler so R3F reconciliation doesn't fight the (π,0,π) state.
      obj.rotation.set(0, snappedRotY * (Math.PI / 180), 0);
      const updated = {
        ...furniture,
        rotation: [furniture.rotation[0], snappedRotY, furniture.rotation[2]] as [number, number, number],
      };
      updateFurniture(updated);
      if (projectId) cadApi.updateFurniture(projectId, furniture.id, updated).catch(console.error);
    }
  }, [furniture, transformTarget, mode, projectId, updateFurniture]);

  return (
    <TransformControls
      object={transformTarget}
      mode={mode}
      translationSnap={SNAP_UNIT}
      rotationSnap={Math.PI / 2}
      onMouseUp={handleMouseUp}
    />
  );
}

interface HandleMeshProps {
  position: [number, number, number];
  axis: 'width' | 'depth';
  sign: 1 | -1;
  cursor: string;
  onStartDrag: (axis: 'width' | 'depth', sign: 1 | -1, clientX: number, clientY: number, pointerId: number) => void;
}

function HandleMesh({ position, axis, sign, cursor, onStartDrag }: HandleMeshProps) {
  const [hovered, setHovered] = useState(false);
  const { gl } = useThree();

  return (
    <mesh
      position={position}
      onPointerDown={(e) => {
        e.stopPropagation();
        gl.domElement.setPointerCapture(e.nativeEvent.pointerId);
        onStartDrag(axis, sign, e.clientX, e.clientY, e.nativeEvent.pointerId);
      }}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true);  document.body.style.cursor = cursor; }}
      onPointerOut={()  => { setHovered(false); document.body.style.cursor = 'auto'; }}
    >
      <boxGeometry args={[HANDLE_SIZE, HANDLE_SIZE, HANDLE_SIZE]} />
      <meshStandardMaterial color={hovered ? HANDLE_HOVER : HANDLE_COLOR} emissive={hovered ? HANDLE_EMISSIVE : '#000'} emissiveIntensity={0.4} />
    </mesh>
  );
}

function StoreFloor({ store }: { store: StoreConfig }) {
  const { selectFurniture } = useSceneStore();
  const { selectZone } = useZoneStore();
  const storeOriginX = (store.position?.[0] ?? 0) * CM_TO_UNIT;
  const storeOriginZ = (store.position?.[2] ?? 0) * CM_TO_UNIT;
  const w = store.dimensions.width  * CM_TO_UNIT;
  const d = store.dimensions.depth  * CM_TO_UNIT;
  const size = Math.ceil(Math.max(w, d) * GRID_SIZE_MULTIPLIER);

  const handleFloorClick = () => {
    selectFurniture(null);
    selectZone(null);
  };

  return (
    <group>
      {/* Floor slab — clicking deselects */}
      <mesh position={[storeOriginX + w / 2, -0.05, storeOriginZ + d / 2]} receiveShadow onClick={handleFloorClick}>
        <boxGeometry args={[w, 0.1, d]} />
        <meshStandardMaterial color={store.floorColor || '#1e2230'} />
      </mesh>

      {/* Fine grid: 1 m cells, 5 m sections */}
      <Grid
        position={[storeOriginX + w / 2, GRID_Y_OFFSET, storeOriginZ + d / 2]}
        args={[size, size]}
        cellSize={SNAP_UNIT}
        cellThickness={1.2}
        cellColor="#2e4d6e"
        sectionSize={5.0}
        sectionThickness={0.9}
        sectionColor="#2a4a6a"
        fadeDistance={Math.max(w, d) * GRID_FADE_MULTIPLIER}
        fadeStrength={1.2}
        infiniteGrid={false}
      />
    </group>
  );
}

// ─── Store boundary (yellow perimeter outline) ─────────────────────────────────
/** Half-thickness of the invisible hit-box used to make each wall edge clickable. */
const BOUNDARY_HIT_HALF = 0.25;

function StoreBoundary({
  store,
  isSelected,
  onSelect,
}: {
  store: StoreConfig;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const originX = (store.position?.[0] ?? 0) * CM_TO_UNIT;
  const originZ = (store.position?.[2] ?? 0) * CM_TO_UNIT;
  const w = store.dimensions.width  * CM_TO_UNIT;
  const d = store.dimensions.depth  * CM_TO_UNIT;
  const y = GRID_Y_OFFSET + 0.012;

  const lineColor = isSelected ? '#ffe566' : hovered ? '#fde047' : '#facc15';

  const corners: [number, number, number][] = [
    [originX,     y, originZ    ],
    [originX + w, y, originZ    ],
    [originX + w, y, originZ + d],
    [originX,     y, originZ + d],
    [originX,     y, originZ    ],
  ];

  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(true);
    document.body.style.cursor = 'pointer';
  };
  const handlePointerOut = () => {
    setHovered(false);
    document.body.style.cursor = 'auto';
  };
  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect();
  };

  // Four invisible hit-area boxes — one per wall edge.
  // They sit flat on Y, centred on each edge.
  const hitBoxes: { centerX: number; centerZ: number; sx: number; sz: number }[] = [
    { centerX: originX + w / 2, centerZ: originZ,         sx: w, sz: BOUNDARY_HIT_HALF * 2 }, // south
    { centerX: originX + w / 2, centerZ: originZ + d,     sx: w, sz: BOUNDARY_HIT_HALF * 2 }, // north
    { centerX: originX,         centerZ: originZ + d / 2, sx: BOUNDARY_HIT_HALF * 2, sz: d }, // west
    { centerX: originX + w,     centerZ: originZ + d / 2, sx: BOUNDARY_HIT_HALF * 2, sz: d }, // east
  ];

  return (
    <>
      <Line points={corners} color={lineColor} lineWidth={isSelected ? 4 : hovered ? 3.5 : 3} />
      {hitBoxes.map((hb, i) => (
        <mesh
          key={i}
          position={[hb.centerX, y, hb.centerZ]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          onClick={handleClick}
        >
          <planeGeometry args={[hb.sx, hb.sz]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </>
  );
}

/** Minimum store dimension (cm) allowed after a resize. */
const MIN_STORE_DIM_CM = 500;
/** Y level of the store boundary resize handles. */
const BOUNDARY_HANDLE_Y = GRID_Y_OFFSET + 0.06;

// ─── Store boundary resize handles ────────────────────────────────────────────
function StoreBoundaryResizeHandles({ store, projectId }: { store: StoreConfig; projectId: string | null }) {
  const { updateStore } = useSceneStore();
  const { gl, raycaster, camera } = useThree();
  const setResizeDragging = useContext(ResizeDragCtx);

  const originX = (store.position?.[0] ?? 0) * CM_TO_UNIT;
  const originZ = (store.position?.[2] ?? 0) * CM_TO_UNIT;
  const W  = store.dimensions.width  * CM_TO_UNIT;
  const D  = store.dimensions.depth  * CM_TO_UNIT;

  const isDragging    = useRef(false);
  const dragAxis      = useRef<'width' | 'depth'>('width');
  const dragSign      = useRef<1 | -1>(1);
  const dragStart     = useRef(new THREE.Vector3());
  const pointerIdRef  = useRef(-1);
  const baseStoreRef  = useRef<StoreConfig>(store);
  const curStoreRef   = useRef<StoreConfig>(store);
  curStoreRef.current = store;

  const _ndc   = useRef(new THREE.Vector2());
  const _hit   = useRef(new THREE.Vector3());
  const _delta = useRef(new THREE.Vector3());
  const dragPlane = useMemo(() => new THREE.Plane(UP_VEC3, 0), []);

  const startDrag = useCallback((
    axis: 'width' | 'depth',
    sign: 1 | -1,
    clientX: number,
    clientY: number,
    pointerId: number,
  ) => {
    if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, dragStart.current)) return;
    baseStoreRef.current = curStoreRef.current;
    isDragging.current   = true;
    dragAxis.current     = axis;
    dragSign.current     = sign;
    pointerIdRef.current = pointerId;
    setResizeDragging(true);
  }, [gl, raycaster, camera, dragPlane, setResizeDragging]);

  useEffect(() => {
    let rafId = 0;

    const onMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const base  = baseStoreRef.current;
        const bW    = base.dimensions.width  * CM_TO_UNIT;
        const bD    = base.dimensions.depth  * CM_TO_UNIT;
        const bPosX = base.position?.[0] ?? 0;
        const bPosZ = base.position?.[2] ?? 0;

        if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, _hit.current)) return;
        const delta = _delta.current.copy(_hit.current).sub(dragStart.current);
        const sign  = dragSign.current;

        const newDims = { ...base.dimensions };
        const newPos: [number, number, number] = [bPosX, 0, bPosZ];

        if (dragAxis.current === 'width') {
          // move > 0 when dragging outward (expanding the dragged edge).
          const move = delta.x * sign;
          const newW = Math.max(MIN_STORE_DIM_CM * CM_TO_UNIT, bW + move);
          newDims.width = newW / CM_TO_UNIT;
          if (sign === -1) {
            // Left handle: shift origin left so right edge stays fixed.
            const dW = newW - bW;
            newPos[0] = bPosX - dW / CM_TO_UNIT;
          }
        } else {
          const move = delta.z * sign;
          const newD = Math.max(MIN_STORE_DIM_CM * CM_TO_UNIT, bD + move);
          newDims.depth = newD / CM_TO_UNIT;
          if (sign === -1) {
            // Near handle: shift origin near so far edge stays fixed.
            const dD = newD - bD;
            newPos[2] = bPosZ - dD / CM_TO_UNIT;
          }
        }

        updateStore({ ...base, dimensions: newDims, position: newPos });
      });
    };

    const onUp = () => {
      if (!isDragging.current) return;
      cancelAnimationFrame(rafId);
      isDragging.current = false;
      setResizeDragging(false);

      if (pointerIdRef.current >= 0) {
        try { gl.domElement.releasePointerCapture(pointerIdRef.current); } catch { /* ignore */ }
        pointerIdRef.current = -1;
      }

      const cur   = curStoreRef.current;
      const base  = baseStoreRef.current;
      const sign  = dragSign.current;
      const snapDim = (v: number) => snapToCm(Math.max(MIN_STORE_DIM_CM, v));

      const snappedW = snapDim(cur.dimensions.width);
      const snappedD = snapDim(cur.dimensions.depth);
      const snappedPos: [number, number, number] = [
        cur.position?.[0] ?? 0,
        0,
        cur.position?.[2] ?? 0,
      ];

      // Re-align the non-dragged edge after snapping for sign=-1 handles.
      if (sign === -1) {
        const bPosX = base.position?.[0] ?? 0;
        const bPosZ = base.position?.[2] ?? 0;
        if (dragAxis.current === 'width') {
          // right edge = bPosX + base.dims.width must stay fixed.
          snappedPos[0] = bPosX + base.dimensions.width - snappedW;
        } else {
          snappedPos[2] = bPosZ + base.dimensions.depth - snappedD;
        }
      }

      const snapped: StoreConfig = {
        ...cur,
        position: snappedPos,
        dimensions: { ...cur.dimensions, width: snappedW, depth: snappedD },
      };

      updateStore(snapped);
      if (projectId) cadApi.updateStore(projectId, snapped).catch(console.error);
    };

    gl.domElement.addEventListener('pointermove', onMove);
    gl.domElement.addEventListener('pointerup',   onUp);
    return () => {
      cancelAnimationFrame(rafId);
      gl.domElement.removeEventListener('pointermove', onMove);
      gl.domElement.removeEventListener('pointerup',   onUp);
    };
  }, [gl, raycaster, camera, dragPlane, updateStore, projectId, setResizeDragging]);

  useEffect(() => () => { document.body.style.cursor = 'auto'; }, []);

  // Four handles: one per edge of the store boundary.
  // Each handle moves only its own edge; the opposite edge stays fixed.
  const handles: { axis: 'width' | 'depth'; sign: 1 | -1; posX: number; posZ: number; cursor: string }[] = [
    { axis: 'width',  sign:  1, posX: originX + W,     posZ: originZ + D / 2, cursor: 'ew-resize' }, // right edge
    { axis: 'width',  sign: -1, posX: originX,         posZ: originZ + D / 2, cursor: 'ew-resize' }, // left edge
    { axis: 'depth',  sign:  1, posX: originX + W / 2, posZ: originZ + D,     cursor: 'ns-resize' }, // far edge
    { axis: 'depth',  sign: -1, posX: originX + W / 2, posZ: originZ,         cursor: 'ns-resize' }, // near edge
  ];

  return (
    <group>
      {handles.map(({ axis, sign, posX, posZ, cursor }) => (
        <HandleMesh
          key={`store-${axis}${sign}`}
          position={[posX, BOUNDARY_HANDLE_Y, posZ]}
          axis={axis}
          sign={sign}
          cursor={cursor}
          onStartDrag={startDrag}
        />
      ))}
    </group>
  );
}


// ─── Planogram resize helpers ─────────────────────────────────────────────────

/**
 * Return a copy of `planogram` with all horizontal measurements scaled to
 * `newWidthCm`.  Scales colWidthsCm, cellWidthOverrides, and the gondola
 * separator positions proportionally so the layout is preserved.
 */
function scalePlanogramWidth(planogram: Planogram, newWidthCm: number): Planogram {
  if (planogram.widthCm <= 0 || Math.abs(newWidthCm - planogram.widthCm) < 0.01) return planogram;
  const scale = newWidthCm / planogram.widthCm;

  const colWidthsCm = planogram.colWidthsCm?.map(w => Math.round(w * scale * 10) / 10);
  const cellWidthOverrides = planogram.cellWidthOverrides
    ? Object.fromEntries(
        Object.entries(planogram.cellWidthOverrides).map(([k, v]) => [k, Math.round(v * scale * 10) / 10]),
      )
    : undefined;

  let gondola = planogram.gondola;
  if (gondola) {
    gondola = {
      ...gondola,
      width_cm: newWidthCm,
      shelves: gondola.shelves.map(shelf => ({
        ...shelf,
        separators: shelf.separators.map(sep => ({
          ...sep,
          position_cm: Math.round(sep.position_cm * scale * 10) / 10,
        })),
      })),
    };
  }

  return { ...planogram, widthCm: newWidthCm, colWidthsCm, cellWidthOverrides, gondola };
}

/**
 * After a furniture resize, update all linked planogram dimensions to stay in
 * sync with the new furniture footprint.  Only planograms whose physical width
 * has changed (>0.5 cm difference) are updated.
 *
 * Mapping: front/back/top planograms ↔ furniture width;
 *          left/right planograms      ↔ furniture depth.
 */
function syncPlanogramFacesOnResize(
  furniture: FurnitureInstance,
  projectId: string,
  planogramDetails: Map<string, Planogram>,
  syncPlanogram: (p: Planogram) => void,
): void {
  const { width, depth } = furniture.dimensions;
  for (const [faceId, planogramId] of Object.entries(furniture.faces)) {
    if (!planogramId) continue;
    const planogram = planogramDetails.get(planogramId);
    if (!planogram) continue;
    const isDepthAxis = faceId === 'left' || faceId === 'right';
    const newWidthCm = isDepthAxis ? depth : width;
    if (Math.abs(newWidthCm - planogram.widthCm) < 0.5) continue;
    const scaled = scalePlanogramWidth(planogram, newWidthCm);
    syncPlanogram(scaled);
    cadApi.updatePlanogram(projectId, planogramId, scaled).catch(console.error);
  }
}


// ─── Furniture resize handles (width / depth) ─────────────────────────────────
/** Furniture types that can be resized via 3D drag handles in scale mode. */
const RESIZABLE_FURNITURE_TYPES = new Set(['wall', 'partition', 'register']);
/** Y level of the furniture resize handles (same as boundary handles). */
const FURNITURE_HANDLE_Y = GRID_Y_OFFSET + 0.06;

interface FurnitureResizeHandlesProps {
  furniture: FurnitureInstance;
  projectId: string | null;
}

function FurnitureResizeHandles({ furniture, projectId }: FurnitureResizeHandlesProps) {
  const { updateFurniture } = useSceneStore();
  const { planogramDetails, syncPlanogram } = usePlanogramStore();
  const { gl, raycaster, camera } = useThree();
  const setResizeDragging = useContext(ResizeDragCtx);

  const ry  = furniture.rotation[1] * (Math.PI / 180);
  const px  = furniture.position[0] * CM_TO_UNIT;
  const pz  = furniture.position[2] * CM_TO_UNIT;
  const W   = furniture.dimensions.width  * CM_TO_UNIT;
  const D   = furniture.dimensions.depth  * CM_TO_UNIT;

  const isDragging      = useRef(false);
  const dragAxis        = useRef<'width' | 'depth'>('width');
  const dragSign        = useRef<1 | -1>(1);
  const dragStart       = useRef(new THREE.Vector3());
  const pointerIdRef    = useRef(-1);
  const baseFurnitureRef = useRef<FurnitureInstance>(furniture);
  const curFurnitureRef  = useRef<FurnitureInstance>(furniture);
  curFurnitureRef.current = furniture;

  // Keep planogram state fresh so the effect closure always reads the latest values.
  const planogramDetailsRef = useRef(planogramDetails);
  planogramDetailsRef.current = planogramDetails;
  const syncPlanogramRef = useRef(syncPlanogram);
  syncPlanogramRef.current = syncPlanogram;

  const _ndc    = useRef(new THREE.Vector2());
  const _hit    = useRef(new THREE.Vector3());
  const _delta  = useRef(new THREE.Vector3());
  const dragPlane = useMemo(() => new THREE.Plane(UP_VEC3, 0), []);

  const startDrag = useCallback((
    axis: 'width' | 'depth',
    sign: 1 | -1,
    clientX: number,
    clientY: number,
    pointerId: number,
  ) => {
    if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, dragStart.current)) return;
    baseFurnitureRef.current = curFurnitureRef.current;
    isDragging.current   = true;
    dragAxis.current     = axis;
    dragSign.current     = sign;
    pointerIdRef.current = pointerId;
    setResizeDragging(true);
  }, [gl, raycaster, camera, dragPlane, setResizeDragging]);

  useEffect(() => {
    let rafId = 0;

    const onMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const base  = baseFurnitureRef.current;
        const bW    = base.dimensions.width  * CM_TO_UNIT;
        const bD    = base.dimensions.depth  * CM_TO_UNIT;
        const bPosX = base.position[0];
        const bPosZ = base.position[2];

        if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, _hit.current)) return;
        const delta = _delta.current.copy(_hit.current).sub(dragStart.current);
        const sign  = dragSign.current;

        const newDims = { ...base.dimensions };
        const newPos: [number, number, number] = [bPosX, base.position[1], bPosZ];

        if (dragAxis.current === 'width') {
          const move = delta.x * sign;
          const newW = Math.max(MIN_DIM_CM * CM_TO_UNIT, bW + move);
          newDims.width = newW / CM_TO_UNIT;
          if (sign === -1) {
            newPos[0] = bPosX - (newW - bW) / CM_TO_UNIT;
          }
        } else {
          const move = delta.z * sign;
          const newD = Math.max(MIN_DIM_CM * CM_TO_UNIT, bD + move);
          newDims.depth = newD / CM_TO_UNIT;
          if (sign === -1) {
            newPos[2] = bPosZ - (newD - bD) / CM_TO_UNIT;
          }
        }

        updateFurniture({ ...base, dimensions: newDims, position: newPos });
      });
    };

    const onUp = () => {
      if (!isDragging.current) return;
      cancelAnimationFrame(rafId);
      isDragging.current = false;
      setResizeDragging(false);

      if (pointerIdRef.current >= 0) {
        try { gl.domElement.releasePointerCapture(pointerIdRef.current); } catch { /* ignore */ }
        pointerIdRef.current = -1;
      }

      const cur  = curFurnitureRef.current;
      const sign = dragSign.current;
      const base = baseFurnitureRef.current;

      const snappedW = snapToCm(Math.max(MIN_DIM_CM, cur.dimensions.width));
      const snappedD = snapToCm(Math.max(MIN_DIM_CM, cur.dimensions.depth));
      const snappedPos: [number, number, number] = [...cur.position];

      if (sign === -1) {
        if (dragAxis.current === 'width') {
          snappedPos[0] = base.position[0] + base.dimensions.width - snappedW;
        } else {
          snappedPos[2] = base.position[2] + base.dimensions.depth - snappedD;
        }
      }

      const snapped: FurnitureInstance = {
        ...cur,
        position: snappedPos,
        dimensions: { ...cur.dimensions, width: snappedW, depth: snappedD },
      };
      updateFurniture(snapped);
      if (projectId) {
        cadApi.updateFurniture(projectId, snapped.id, snapped).catch(console.error);
        syncPlanogramFacesOnResize(snapped, projectId, planogramDetailsRef.current, syncPlanogramRef.current);
      }
    };

    gl.domElement.addEventListener('pointermove', onMove);
    gl.domElement.addEventListener('pointerup',   onUp);
    return () => {
      cancelAnimationFrame(rafId);
      gl.domElement.removeEventListener('pointermove', onMove);
      gl.domElement.removeEventListener('pointerup',   onUp);
    };
  }, [gl, raycaster, camera, dragPlane, updateFurniture, projectId, setResizeDragging]);

  useEffect(() => () => { document.body.style.cursor = 'auto'; }, []);

  // Handle positions in world space — account for furniture rotation (Y axis).
  const cosR = Math.cos(ry);
  const sinR = Math.sin(ry);
  // Local (unrotated) handle offsets relative to the furniture's origin corner (px, pz).
  // We work in the local frame (half-W, half-D from centre) then rotate into world space.
  const cx = px + W / 2;
  const cz = pz + D / 2;

  // Rotate a local-space point around the centre.
  const rotLocal = (lx: number, lz: number): [number, number] => {
    const rx2 = lx * cosR - lz * sinR;
    const rz2 = lx * sinR + lz * cosR;
    return [cx + rx2, cz + rz2];
  };

  const [rhPosX, rhPosZ] = rotLocal( W / 2, 0);      // right edge
  const [lhPosX, lhPosZ] = rotLocal(-W / 2, 0);      // left edge
  const [fhPosX, fhPosZ] = rotLocal(0,  D / 2);      // far edge
  const [nhPosX, nhPosZ] = rotLocal(0, -D / 2);      // near edge

  const handles: { axis: 'width' | 'depth'; sign: 1 | -1; hx: number; hz: number; cursor: string }[] = [
    { axis: 'width',  sign:  1, hx: rhPosX, hz: rhPosZ, cursor: 'ew-resize' },
    { axis: 'width',  sign: -1, hx: lhPosX, hz: lhPosZ, cursor: 'ew-resize' },
    { axis: 'depth',  sign:  1, hx: fhPosX, hz: fhPosZ, cursor: 'ns-resize' },
    { axis: 'depth',  sign: -1, hx: nhPosX, hz: nhPosZ, cursor: 'ns-resize' },
  ];

  return (
    <group>
      {handles.map(({ axis, sign, hx, hz, cursor }) => (
        <HandleMesh
          key={`furn-${furniture.id}-${axis}${sign}`}
          position={[hx, FURNITURE_HANDLE_Y, hz]}
          axis={axis}
          sign={sign}
          cursor={cursor}
          onStartDrag={startDrag}
        />
      ))}
    </group>
  );
}


// ─── Floor zone appearance constants ──────────────────────────────────────────
const ZONE_COLORS: Record<string, { fill: string; border: string }> = {
  entrance: { fill: '#22c55e', border: '#16a34a' },
  exit:     { fill: '#f97316', border: '#ea580c' },
  supply:   { fill: '#a855f7', border: '#7c3aed' },
};
const ZONE_HANDLE_Y = GRID_Y_OFFSET + 0.06;

// ─── Floor zone mesh (movable) ────────────────────────────────────────────────
function FloorZoneMesh({ zone }: { zone: FloorZone }) {
  const { selectZone, updateZone, selectedZoneId } = useZoneStore();
  const { selectFurniture } = useSceneStore();
  const { activeTool } = useUIStore();
  const { gl, raycaster, camera } = useThree();
  const [hovered, setHovered] = useState(false);

  const isSelected = selectedZoneId === zone.id;
  const W = zone.width  * CM_TO_UNIT;
  const D = zone.depth  * CM_TO_UNIT;
  const cx = zone.x * CM_TO_UNIT + W / 2;
  const cz = zone.z * CM_TO_UNIT + D / 2;
  const y  = GRID_Y_OFFSET + 0.016;

  const color = ZONE_COLORS[zone.type] ?? ZONE_COLORS.entrance;

  // Drag state (same pattern as ResizeHandles / FurnitureMesh)
  const isDragging   = useRef(false);
  const dragStart    = useRef(new THREE.Vector3());
  const baseZoneRef  = useRef<FloorZone>(zone);
  const curZoneRef   = useRef<FloorZone>(zone);
  curZoneRef.current = zone;

  const _ndc  = useRef(new THREE.Vector2());
  const _hit  = useRef(new THREE.Vector3());
  const dragPlane = useMemo(() => new THREE.Plane(UP_VEC3, 0), []);

  useEffect(() => {
    let rafId = 0;

    const onMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const base = baseZoneRef.current;
        if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, _hit.current)) return;
        const dx = _hit.current.x - dragStart.current.x;
        const dz = _hit.current.z - dragStart.current.z;
        updateZone({ ...base, x: base.x + dx / CM_TO_UNIT, z: base.z + dz / CM_TO_UNIT });
      });
    };

    const onUp = () => {
      if (!isDragging.current) return;
      cancelAnimationFrame(rafId);
      isDragging.current = false;
      const cur = curZoneRef.current;
      updateZone({ ...cur, x: snapToCm(cur.x), z: snapToCm(cur.z) });
    };

    gl.domElement.addEventListener('pointermove', onMove);
    gl.domElement.addEventListener('pointerup',   onUp);
    return () => {
      cancelAnimationFrame(rafId);
      gl.domElement.removeEventListener('pointermove', onMove);
      gl.domElement.removeEventListener('pointerup',   onUp);
    };
  }, [gl, raycaster, camera, dragPlane, updateZone]);

  useEffect(() => () => { document.body.style.cursor = 'auto'; }, []);

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (activeTool === 'measure') return;
    e.stopPropagation();
    selectZone(zone.id);
    selectFurniture(null);
    if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, e.clientX, e.clientY, _ndc.current, dragStart.current)) return;
    baseZoneRef.current = curZoneRef.current;
    isDragging.current  = true;
    gl.domElement.setPointerCapture(e.nativeEvent.pointerId);
  };

  // Prevent the click from bubbling to the floor's deselect handler so the
  // zone selection highlight persists after a simple click (not just drag).
  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (activeTool === 'measure') return;
    e.stopPropagation();
  };

  const bx = zone.x * CM_TO_UNIT;
  const bz = zone.z * CM_TO_UNIT;
  const lineY = y + 0.001;

  const borderPts: [number, number, number][] = [
    [bx,      lineY, bz],
    [bx + W,  lineY, bz],
    [bx + W,  lineY, bz + D],
    [bx,      lineY, bz + D],
    [bx,      lineY, bz],
  ];

  // Build interior grid lines for supply zones.
  const supplyGridLines: JSX.Element[] = [];
  if (zone.type === 'supply') {
    const rows = Math.max(1, zone.rows ?? 1);
    const cols = Math.max(1, zone.cols ?? 1);
    const gridLineY = lineY + 0.001;
    const gridColor = isSelected ? '#ffffff' : color.border;
    for (let c = 1; c < cols; c++) {
      const gx = bx + (W / cols) * c;
      supplyGridLines.push(
        <Line
          key={`col${c}`}
          points={[[gx, gridLineY, bz], [gx, gridLineY, bz + D]] as [number, number, number][]}
          color={gridColor}
          lineWidth={1}
        />,
      );
    }
    for (let r = 1; r < rows; r++) {
      const gz = bz + (D / rows) * r;
      supplyGridLines.push(
        <Line
          key={`row${r}`}
          points={[[bx, gridLineY, gz], [bx + W, gridLineY, gz]] as [number, number, number][]}
          color={gridColor}
          lineWidth={1}
        />,
      );
    }
  }

  return (
    <group>
      {/* Semi-transparent fill plane */}
      <mesh
        position={[cx, y, cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        onPointerOver={(e) => {
          if (activeTool === 'measure') return;
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'move';
        }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <planeGeometry args={[W, D]} />
        <meshBasicMaterial
          color={color.fill}
          transparent
          opacity={isSelected ? 0.55 : hovered ? 0.45 : 0.32}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Border outline */}
      <Line
        points={borderPts}
        color={isSelected ? '#ffffff' : color.border}
        lineWidth={isSelected ? 3 : 2}
      />

      {/* Interior grid lines (supply zones only) */}
      {supplyGridLines}

      {/* Label — 3D sprite so it is captured by canvas.captureStream */}
      <TextSprite3D
        text={zone.label}
        position={[cx, y + 0.12, cz]}
        scale={1.2}
      />
    </group>
  );
}

// ─── Floor zone resize handles ────────────────────────────────────────────────
function FloorZoneResizeHandles({ zone }: { zone: FloorZone }) {
  const { updateZone } = useZoneStore();
  const { gl, raycaster, camera } = useThree();
  const setResizeDragging = useContext(ResizeDragCtx);

  const W  = zone.width  * CM_TO_UNIT;
  const D  = zone.depth  * CM_TO_UNIT;
  const px = zone.x * CM_TO_UNIT;
  const pz = zone.z * CM_TO_UNIT;

  const isDragging    = useRef(false);
  const dragAxis      = useRef<'width' | 'depth'>('width');
  const dragSign      = useRef<1 | -1>(1);
  const dragStart     = useRef(new THREE.Vector3());
  const pointerIdRef  = useRef(-1);
  const baseZoneRef   = useRef<FloorZone>(zone);
  const curZoneRef    = useRef<FloorZone>(zone);
  curZoneRef.current  = zone;

  const _ndc   = useRef(new THREE.Vector2());
  const _hit   = useRef(new THREE.Vector3());
  const _delta = useRef(new THREE.Vector3());
  const dragPlane = useMemo(() => new THREE.Plane(UP_VEC3, 0), []);

  const startDrag = useCallback((
    axis: 'width' | 'depth',
    sign: 1 | -1,
    clientX: number,
    clientY: number,
    pointerId: number,
  ) => {
    if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, dragStart.current)) return;
    baseZoneRef.current  = curZoneRef.current;
    isDragging.current   = true;
    dragAxis.current     = axis;
    dragSign.current     = sign;
    pointerIdRef.current = pointerId;
    setResizeDragging(true);
  }, [gl, raycaster, camera, dragPlane, setResizeDragging]);

  useEffect(() => {
    let rafId = 0;

    const onMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const base = baseZoneRef.current;
        const bW   = base.width  * CM_TO_UNIT;
        const bD   = base.depth  * CM_TO_UNIT;

        if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, _hit.current)) return;
        const delta = _delta.current.copy(_hit.current).sub(dragStart.current);
        const sign  = dragSign.current;

        let newWidth = base.width;
        let newDepth = base.depth;
        let newX     = base.x;
        let newZ     = base.z;

        if (dragAxis.current === 'width') {
          const move = delta.x * sign;
          const nW   = Math.max(MIN_DIM_CM * CM_TO_UNIT, bW + move);
          const dW   = nW - bW;
          newWidth   = nW / CM_TO_UNIT;
          if (sign === -1) newX = base.x - dW / CM_TO_UNIT;
        } else {
          const move = delta.z * sign;
          const nD   = Math.max(MIN_DIM_CM * CM_TO_UNIT, bD + move);
          const dD   = nD - bD;
          newDepth   = nD / CM_TO_UNIT;
          if (sign === -1) newZ = base.z - dD / CM_TO_UNIT;
        }

        updateZone({ ...base, x: newX, z: newZ, width: newWidth, depth: newDepth });
      });
    };

    const onUp = () => {
      if (!isDragging.current) return;
      cancelAnimationFrame(rafId);
      isDragging.current = false;
      setResizeDragging(false);

      if (pointerIdRef.current >= 0) {
        try { gl.domElement.releasePointerCapture(pointerIdRef.current); } catch { /* ignore */ }
        pointerIdRef.current = -1;
      }

      const cur      = curZoneRef.current;
      const snapDim  = (v: number) => snapToCm(Math.max(MIN_DIM_CM, v));
      updateZone({
        ...cur,
        x:     snapToCm(cur.x),
        z:     snapToCm(cur.z),
        width: snapDim(cur.width),
        depth: snapDim(cur.depth),
      });
    };

    gl.domElement.addEventListener('pointermove', onMove);
    gl.domElement.addEventListener('pointerup',   onUp);
    return () => {
      cancelAnimationFrame(rafId);
      gl.domElement.removeEventListener('pointermove', onMove);
      gl.domElement.removeEventListener('pointerup',   onUp);
    };
  }, [gl, raycaster, camera, dragPlane, updateZone, setResizeDragging]);

  useEffect(() => () => { document.body.style.cursor = 'auto'; }, []);

  const cx = px + W / 2;
  const cz = pz + D / 2;

  const handles: { axis: 'width' | 'depth'; sign: 1 | -1; hx: number; hz: number; cursor: string }[] = [
    { axis: 'width',  sign:  1, hx: cx + W / 2, hz: cz,         cursor: 'ew-resize' },
    { axis: 'width',  sign: -1, hx: cx - W / 2, hz: cz,         cursor: 'ew-resize' },
    { axis: 'depth',  sign:  1, hx: cx,          hz: cz + D / 2, cursor: 'ns-resize' },
    { axis: 'depth',  sign: -1, hx: cx,          hz: cz - D / 2, cursor: 'ns-resize' },
  ];

  return (
    <group>
      {handles.map(({ axis, sign, hx, hz, cursor }) => (
        <HandleMesh
          key={`${axis}${sign}`}
          position={[hx, ZONE_HANDLE_Y, hz]}
          axis={axis}
          sign={sign}
          cursor={cursor}
          onStartDrag={startDrag}
        />
      ))}
    </group>
  );
}

// ─── Floor zone layer (renders all zones + selected zone handles) ─────────────
function FloorZoneLayer() {
  const { zones, selectedZoneId } = useZoneStore();

  const selectedZone = selectedZoneId
    ? zones.find((z) => z.id === selectedZoneId) ?? null
    : null;

  return (
    <>
      {zones.map((zone) => (
        <FloorZoneMesh key={zone.id} zone={zone} />
      ))}
      {selectedZone && (
        <FloorZoneResizeHandles zone={selectedZone} />
      )}
    </>
  );
}

// ─── Unmounted furniture floor rectangles ─────────────────────────────────────

/** Color config for unmounted furniture floor rectangles. */
const UNMOUNTED_COLORS: Record<string, { fill: string; border: string }> = {
  gondola_single:    { fill: '#3B82F6', border: '#2563EB' },
  gondola_double:    { fill: '#8B5CF6', border: '#6D28D9' },
  fridge:            { fill: '#06B6D4', border: '#0891B2' },
  fridge_horizontal: { fill: '#0EA5E9', border: '#0284C7' },
  pallet:            { fill: '#F59E0B', border: '#D97706' },
  display:           { fill: '#EC4899', border: '#DB2777' },
  register:          { fill: '#10B981', border: '#059669' },
  wall:              { fill: '#6B7280', border: '#4B5563' },
  partition:         { fill: '#9CA3AF', border: '#6B7280' },
  floor_grid:        { fill: '#A855F7', border: '#7C3AED' },
};

function getUnmountedColor(type: string): { fill: string; border: string } {
  return UNMOUNTED_COLORS[type] ?? { fill: '#64748B', border: '#475569' };
}

/** Y position of the semi-transparent fill plane for unmounted furniture. */
const UNMOUNTED_MESH_Y    = GRID_Y_OFFSET + 0.016;
/** Small Z offset between the fill plane and its border outline to prevent z-fighting. */
const UNMOUNTED_LINE_Y    = UNMOUNTED_MESH_Y + 0.001;
/** Vertical offset of the name label above the floor rectangle. */
const UNMOUNTED_LABEL_Y   = UNMOUNTED_MESH_Y + 0.12;
/** Y level of the unmounted furniture resize handles. */
const UNMOUNTED_HANDLE_Y  = GRID_Y_OFFSET + 0.06;
/** Height multiplier and base offset used to compute the BEV camera elevation. */
const BEV_HEIGHT_SCALE    = 1.2;
const BEV_HEIGHT_BASE     = 5;
/** Maximum polar angle (radians) for OrbitControls in BEV mode — nearly 0 = straight down. */
const BEV_MAX_POLAR_ANGLE = 0.01;

/**
 * Renders an unmounted furniture item as a draggable/selectable floor rectangle,
 * similar to how FloorZoneMesh renders a zone.
 */
function UnmountedFurnitureMesh({ furniture, projectId }: { furniture: FurnitureInstance; projectId: string | null }) {
  const { selectedFurnitureId, selectFurniture, updateFurniture } = useSceneStore();
  const { selectZone } = useZoneStore();
  const { activeTool } = useUIStore();
  const { gl, raycaster, camera } = useThree();
  const [hovered, setHovered] = useState(false);

  const isSelected = selectedFurnitureId === furniture.id;
  const W = furniture.dimensions.width  * CM_TO_UNIT;
  const D = furniture.dimensions.depth  * CM_TO_UNIT;
  const cx = furniture.position[0] * CM_TO_UNIT + W / 2;
  const cz = furniture.position[2] * CM_TO_UNIT + D / 2;

  const color = getUnmountedColor(furniture.type);

  const isDragging   = useRef(false);
  const dragStart    = useRef(new THREE.Vector3());
  const baseFurnRef  = useRef<FurnitureInstance>(furniture);
  const curFurnRef   = useRef<FurnitureInstance>(furniture);
  curFurnRef.current = furniture;

  const _ndc  = useRef(new THREE.Vector2());
  const _hit  = useRef(new THREE.Vector3());
  const dragPlane = useMemo(() => new THREE.Plane(UP_VEC3, 0), []);

  useEffect(() => {
    let rafId = 0;

    const onMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const base = baseFurnRef.current;
        if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, _hit.current)) return;
        const dx = _hit.current.x - dragStart.current.x;
        const dz = _hit.current.z - dragStart.current.z;
        updateFurniture({ ...base, position: [base.position[0] + dx / CM_TO_UNIT, base.position[1], base.position[2] + dz / CM_TO_UNIT] });
      });
    };

    const onUp = () => {
      if (!isDragging.current) return;
      cancelAnimationFrame(rafId);
      isDragging.current = false;
      const cur = curFurnRef.current;
      const snapped: FurnitureInstance = {
        ...cur,
        position: [snapToCm(cur.position[0]), cur.position[1], snapToCm(cur.position[2])],
      };
      updateFurniture(snapped);
      if (projectId) cadApi.updateFurniture(projectId, snapped.id, snapped).catch(console.error);
    };

    gl.domElement.addEventListener('pointermove', onMove);
    gl.domElement.addEventListener('pointerup',   onUp);
    return () => {
      cancelAnimationFrame(rafId);
      gl.domElement.removeEventListener('pointermove', onMove);
      gl.domElement.removeEventListener('pointerup',   onUp);
    };
  }, [gl, raycaster, camera, dragPlane, updateFurniture, projectId]);

  useEffect(() => () => { document.body.style.cursor = 'auto'; }, []);

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (activeTool === 'measure') return;
    e.stopPropagation();
    selectFurniture(furniture.id);
    selectZone(null);
    if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, e.clientX, e.clientY, _ndc.current, dragStart.current)) return;
    baseFurnRef.current = curFurnRef.current;
    isDragging.current  = true;
    gl.domElement.setPointerCapture(e.nativeEvent.pointerId);
  };

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (activeTool === 'measure') return;
    e.stopPropagation();
  };

  const bx = furniture.position[0] * CM_TO_UNIT;
  const bz = furniture.position[2] * CM_TO_UNIT;

  const borderPts: [number, number, number][] = [
    [bx,      UNMOUNTED_LINE_Y, bz],
    [bx + W,  UNMOUNTED_LINE_Y, bz],
    [bx + W,  UNMOUNTED_LINE_Y, bz + D],
    [bx,      UNMOUNTED_LINE_Y, bz + D],
    [bx,      UNMOUNTED_LINE_Y, bz],
  ];

  if (!furniture.visible) return null;

  return (
    <group>
      {/* Semi-transparent fill plane */}
      <mesh
        position={[cx, UNMOUNTED_MESH_Y, cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        onPointerOver={(e) => {
          if (activeTool === 'measure') return;
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'move';
        }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <planeGeometry args={[W, D]} />
        <meshBasicMaterial
          color={color.fill}
          transparent
          opacity={isSelected ? 0.65 : hovered ? 0.5 : 0.35}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Border outline */}
      <Line
        points={borderPts}
        color={isSelected ? '#ffffff' : color.border}
        lineWidth={isSelected ? 3 : 2}
      />

      {/* Name label */}
      <TextSprite3D
        text={furniture.name}
        position={[cx, UNMOUNTED_LABEL_Y, cz]}
        isSelected={isSelected}
        scale={1.2}
      />
    </group>
  );
}

// ─── Unmounted furniture resize handles ───────────────────────────────────────
function UnmountedFurnitureResizeHandles({ furniture, projectId }: { furniture: FurnitureInstance; projectId: string | null }) {
  const { updateFurniture } = useSceneStore();
  const { planogramDetails, syncPlanogram } = usePlanogramStore();
  const { gl, raycaster, camera } = useThree();
  const setResizeDragging = useContext(ResizeDragCtx);

  const W  = furniture.dimensions.width  * CM_TO_UNIT;
  const D  = furniture.dimensions.depth  * CM_TO_UNIT;
  const px = furniture.position[0] * CM_TO_UNIT;
  const pz = furniture.position[2] * CM_TO_UNIT;

  const isDragging    = useRef(false);
  const dragAxis      = useRef<'width' | 'depth'>('width');
  const dragSign      = useRef<1 | -1>(1);
  const dragStart     = useRef(new THREE.Vector3());
  const pointerIdRef  = useRef(-1);
  const baseFurnRef   = useRef<FurnitureInstance>(furniture);
  const curFurnRef    = useRef<FurnitureInstance>(furniture);
  curFurnRef.current  = furniture;

  // Keep planogram state fresh so the effect closure always reads the latest values.
  const planogramDetailsRef = useRef(planogramDetails);
  planogramDetailsRef.current = planogramDetails;
  const syncPlanogramRef = useRef(syncPlanogram);
  syncPlanogramRef.current = syncPlanogram;

  const _ndc   = useRef(new THREE.Vector2());
  const _hit   = useRef(new THREE.Vector3());
  const _delta = useRef(new THREE.Vector3());
  const dragPlane = useMemo(() => new THREE.Plane(UP_VEC3, 0), []);

  const startDrag = useCallback((
    axis: 'width' | 'depth',
    sign: 1 | -1,
    clientX: number,
    clientY: number,
    pointerId: number,
  ) => {
    if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, dragStart.current)) return;
    baseFurnRef.current  = curFurnRef.current;
    isDragging.current   = true;
    dragAxis.current     = axis;
    dragSign.current     = sign;
    pointerIdRef.current = pointerId;
    setResizeDragging(true);
  }, [gl, raycaster, camera, dragPlane, setResizeDragging]);

  useEffect(() => {
    let rafId = 0;

    const onMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const base = baseFurnRef.current;
        const bW   = base.dimensions.width  * CM_TO_UNIT;
        const bD   = base.dimensions.depth  * CM_TO_UNIT;

        if (!getWorldHitPoint(gl, raycaster, camera, dragPlane, clientX, clientY, _ndc.current, _hit.current)) return;
        const delta = _delta.current.copy(_hit.current).sub(dragStart.current);
        const sign  = dragSign.current;

        let newWidth = base.dimensions.width;
        let newDepth = base.dimensions.depth;
        let newX     = base.position[0];
        let newZ     = base.position[2];

        if (dragAxis.current === 'width') {
          const move = delta.x * sign;
          const nW   = Math.max(MIN_DIM_CM * CM_TO_UNIT, bW + move);
          const dW   = nW - bW;
          newWidth   = nW / CM_TO_UNIT;
          if (sign === -1) newX = base.position[0] - dW / CM_TO_UNIT;
        } else {
          const move = delta.z * sign;
          const nD   = Math.max(MIN_DIM_CM * CM_TO_UNIT, bD + move);
          const dD   = nD - bD;
          newDepth   = nD / CM_TO_UNIT;
          if (sign === -1) newZ = base.position[2] - dD / CM_TO_UNIT;
        }

        updateFurniture({ ...base, position: [newX, base.position[1], newZ], dimensions: { ...base.dimensions, width: newWidth, depth: newDepth } });
      });
    };

    const onUp = () => {
      if (!isDragging.current) return;
      cancelAnimationFrame(rafId);
      isDragging.current = false;
      setResizeDragging(false);

      if (pointerIdRef.current >= 0) {
        try { gl.domElement.releasePointerCapture(pointerIdRef.current); } catch { /* ignore */ }
        pointerIdRef.current = -1;
      }

      const cur      = curFurnRef.current;
      const snapDim  = (v: number) => snapToCm(Math.max(MIN_DIM_CM, v));
      const snapped: FurnitureInstance = {
        ...cur,
        position:   [snapToCm(cur.position[0]), cur.position[1], snapToCm(cur.position[2])],
        dimensions: { ...cur.dimensions, width: snapDim(cur.dimensions.width), depth: snapDim(cur.dimensions.depth) },
      };
      updateFurniture(snapped);
      if (projectId) {
        cadApi.updateFurniture(projectId, snapped.id, snapped).catch(console.error);
        syncPlanogramFacesOnResize(snapped, projectId, planogramDetailsRef.current, syncPlanogramRef.current);
      }
    };

    gl.domElement.addEventListener('pointermove', onMove);
    gl.domElement.addEventListener('pointerup',   onUp);
    return () => {
      cancelAnimationFrame(rafId);
      gl.domElement.removeEventListener('pointermove', onMove);
      gl.domElement.removeEventListener('pointerup',   onUp);
    };
  }, [gl, raycaster, camera, dragPlane, updateFurniture, projectId, setResizeDragging]);

  useEffect(() => () => { document.body.style.cursor = 'auto'; }, []);

  const cx = px + W / 2;
  const cz = pz + D / 2;

  const handles: { axis: 'width' | 'depth'; sign: 1 | -1; hx: number; hz: number; cursor: string }[] = [
    { axis: 'width',  sign:  1, hx: cx + W / 2, hz: cz,         cursor: 'ew-resize' },
    { axis: 'width',  sign: -1, hx: cx - W / 2, hz: cz,         cursor: 'ew-resize' },
    { axis: 'depth',  sign:  1, hx: cx,          hz: cz + D / 2, cursor: 'ns-resize' },
    { axis: 'depth',  sign: -1, hx: cx,          hz: cz - D / 2, cursor: 'ns-resize' },
  ];

  return (
    <group>
      {handles.map(({ axis, sign, hx, hz, cursor }) => (
        <HandleMesh
          key={`${axis}${sign}`}
          position={[hx, UNMOUNTED_HANDLE_Y, hz]}
          axis={axis}
          sign={sign}
          cursor={cursor}
          onStartDrag={startDrag}
        />
      ))}
    </group>
  );
}

// ─── Measure tool types ────────────────────────────────────────────────────────
interface MeasureLine {
  id: string;
  start: THREE.Vector3;
  end: THREE.Vector3;
}

// ─── Clickable line hit area (invisible box along the line) ───────────────────
function MeasureLineHit({
  line,
  isSelected,
  onSelect,
}: {
  line: MeasureLine;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const dx = line.end.x - line.start.x;
  const dz = line.end.z - line.start.z;
  const length = Math.sqrt(dx * dx + dz * dz);
  if (length < 0.001) return null;

  const center = line.start.clone().add(line.end).multiplyScalar(0.5);
  // Rotate box X-axis to point along the line direction in the XZ plane.
  const angle = Math.atan2(dz, dx);

  return (
    <mesh
      position={center}
      rotation={[0, -angle, 0]}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = 'auto';
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      {/* Invisible wide hit area */}
      <boxGeometry args={[length, 0.08, 0.18]} />
      <meshBasicMaterial transparent opacity={hovered ? 0.15 : 0} color={isSelected ? '#ff4444' : '#facc15'} depthWrite={false} />
    </mesh>
  );
}

// ─── Multi-line SketchUp-style measure tool ────────────────────────────────────
function MeasureTool({ store }: { store: StoreConfig }) {
  const { activeTool } = useUIStore();
  const [lines, setLines] = useState<MeasureLine[]>([]);
  const [drawStart, setDrawStart] = useState<THREE.Vector3 | null>(null);
  const [previewEnd, setPreviewEnd] = useState<THREE.Vector3 | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);

  // Reset all state when leaving measure tool
  useEffect(() => {
    if (activeTool !== 'measure') {
      setLines([]);
      setDrawStart(null);
      setPreviewEnd(null);
      setSelectedLineId(null);
    }
  }, [activeTool]);

  // Keyboard: Delete removes selected line; Escape cancels drawing or deselects
  useEffect(() => {
    if (activeTool !== 'measure') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedLineId) {
          setLines((prev) => prev.filter((l) => l.id !== selectedLineId));
          setSelectedLineId(null);
        }
      } else if (e.key === 'Escape') {
        if (drawStart) {
          setDrawStart(null);
          setPreviewEnd(null);
        } else {
          setSelectedLineId(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool, selectedLineId, drawStart]);

  if (activeTool !== 'measure') return null;

  const storeOriginX = (store.position?.[0] ?? 0) * CM_TO_UNIT;
  const storeOriginZ = (store.position?.[2] ?? 0) * CM_TO_UNIT;
  const w = store.dimensions.width * CM_TO_UNIT;
  const d = store.dimensions.depth * CM_TO_UNIT;

  const snapToGrid = (v: THREE.Vector3) => {
    const snapped = v.clone();
    snapped.x = Math.round(snapped.x / SNAP_UNIT) * SNAP_UNIT;
    snapped.z = Math.round(snapped.z / SNAP_UNIT) * SNAP_UNIT;
    snapped.y = GRID_Y_OFFSET + 0.03;
    return snapped;
  };

  const handleFloorClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const point = snapToGrid(event.point.clone());

    if (!drawStart) {
      // First click: start a new line
      setDrawStart(point);
      setSelectedLineId(null);
    } else {
      // Second click: finalise the line
      if (drawStart.distanceTo(point) > 0.001) {
        setLines((prev) => [...prev, { id: crypto.randomUUID(), start: drawStart, end: point }]);
      }
      setDrawStart(null);
      setPreviewEnd(null);
    }
  };

  const handleFloorPointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!drawStart) return;
    const point = snapToGrid(event.point.clone());
    setPreviewEnd(point);
  };

  const LABEL_STYLE: React.CSSProperties = {
    background: 'rgba(0,0,0,0.75)',
    padding: '2px 6px',
    borderRadius: '3px',
    fontSize: '12px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  };

  return (
    <>
      {/* Invisible floor plane — receives all floor interactions */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[storeOriginX + w / 2, GRID_Y_OFFSET + 0.02, storeOriginZ + d / 2]}
        onClick={handleFloorClick}
        onPointerMove={handleFloorPointerMove}
      >
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Finished measurement lines */}
      {lines.map((line) => {
        const isSelected = line.id === selectedLineId;
        const dist = line.start.distanceTo(line.end);
        const mid = line.start.clone().add(line.end).multiplyScalar(0.5);
        const lineColor = isSelected ? '#ff4444' : '#facc15';
        return (
          <group key={line.id}>
            <Line points={[line.start, line.end]} color={lineColor} lineWidth={isSelected ? 3 : 2} />
            <MeasureLineHit
              line={line}
              isSelected={isSelected}
              onSelect={() => setSelectedLineId(isSelected ? null : line.id)}
            />
            {/* Start / end endpoint dots */}
            <mesh position={line.start}>
              <sphereGeometry args={[0.04, 8, 8]} />
              <meshBasicMaterial color={lineColor} />
            </mesh>
            <mesh position={line.end}>
              <sphereGeometry args={[0.04, 8, 8]} />
              <meshBasicMaterial color={lineColor} />
            </mesh>
            <Html position={mid} center>
              <div style={{ ...LABEL_STYLE, color: lineColor, border: `1px solid ${isSelected ? 'rgba(255,68,68,0.33)' : 'rgba(250,204,21,0.33)'}`, cursor: 'default' }}>
                {dist.toFixed(2)} m
                {isSelected && <span style={{ marginLeft: 4, opacity: 0.7 }}>[Del]</span>}
              </div>
            </Html>
          </group>
        );
      })}

      {/* Preview line while drawing (from drawStart to mouse position) */}
      {drawStart && previewEnd && (() => {
        const dist = drawStart.distanceTo(previewEnd);
        const mid = drawStart.clone().add(previewEnd).multiplyScalar(0.5);
        return (
          <>
            <Line points={[drawStart, previewEnd]} color="#facc15" lineWidth={2} dashed dashSize={0.2} gapSize={0.1} />
            <Html position={mid} center>
              <div style={{ ...LABEL_STYLE, color: '#facc15', border: '1px solid rgba(250,204,21,0.35)' }}>
                {dist.toFixed(2)} m
              </div>
            </Html>
          </>
        );
      })()}

      {/* Start-point dot while drawing */}
      {drawStart && (
        <mesh position={drawStart}>
          <sphereGeometry args={[0.06, 8, 8]} />
          <meshBasicMaterial color="#facc15" />
        </mesh>
      )}
    </>
  );
}

// ─── Camera fly-to furniture (triggered when switching from planogram → 3D) ─────
function CameraFlyToFurniture() {
  const { camera, controls } = useThree();
  const flyToFurnitureId    = useUIStore((s) => s.flyToFurnitureId);
  const flyToFurnitureFace  = useUIStore((s) => s.flyToFurnitureFace);
  const setFlyToFurnitureId = useUIStore((s) => s.setFlyToFurnitureId);
  const scene               = useSceneStore((s) => s.scene);

  useEffect(() => {
    if (!flyToFurnitureId || !scene || !controls) return;
    const furniture = scene.furniture.find((f) => f.id === flyToFurnitureId);
    if (!furniture) return;

    const W  = furniture.dimensions.width  * CM_TO_UNIT;
    const H  = furniture.dimensions.height * CM_TO_UNIT;
    const D  = furniture.dimensions.depth  * CM_TO_UNIT;
    const cx = furniture.position[0] * CM_TO_UNIT + W / 2;
    const cy = furniture.position[1] * CM_TO_UNIT + H / 2;
    const cz = furniture.position[2] * CM_TO_UNIT + D / 2;

    const target = new THREE.Vector3(cx, cy, cz);
    const dist   = Math.max(W, H, D) * 1.5 + 5;

    // Compute face direction in local furniture space, then rotate to world space
    const ryRad = (furniture.rotation[1] ?? 0) * (Math.PI / 180);
    let localDirX = 0;
    let localDirZ = 0;
    switch (flyToFurnitureFace) {
      case 'front':  localDirZ =  1; break;
      case 'back':   localDirZ = -1; break;
      case 'right':  localDirX =  1; break;
      case 'left':   localDirX = -1; break;
      default:
        // No face info — keep original diagonal fallback
        localDirX = 0.7; localDirZ = 0.7;
    }
    // Apply Y-rotation: R_y × [localDirX, 0, localDirZ]
    const worldDirX = Math.cos(ryRad) * localDirX + Math.sin(ryRad) * localDirZ;
    const worldDirZ = -Math.sin(ryRad) * localDirX + Math.cos(ryRad) * localDirZ;

    const offset = new THREE.Vector3(
      cx + worldDirX * dist,
      cy + dist * 0.4,
      cz + worldDirZ * dist,
    );

    camera.position.copy(offset);
    camera.lookAt(target);
    // @ts-expect-error drei controls
    controls?.target?.copy(target);
    // @ts-expect-error drei controls
    controls?.update?.();

    setFlyToFurnitureId(null);
  }, [flyToFurnitureId, flyToFurnitureFace, scene, camera, controls, setFlyToFurnitureId]);

  return null;
}


/**
 * Persists the THREE.js camera position and OrbitControls target every frame
 * into a module-level variable, and restores them on mount.  This ensures that
 * switching from 3D→planogram→3D view keeps the user's exact camera viewpoint
 * instead of jumping back to the Canvas default position [25,15,35].
 */
function CameraStateSync({ savedPosition }: { savedPosition?: [number, number, number] | null }) {
  const { camera, get } = useThree();

  // Restore the camera position before the first paint so there is no visible
  // jump.  OrbitControls picks up its internal spherical coordinates from
  // camera.position on its very first update() call, so setting position here
  // is sufficient.
  // The empty dependency array is intentional: this effect must run exactly
  // once on mount to restore the saved state; re-running it when savedPosition
  // or camera changes would fight OrbitControls and cause jumps.
  useLayoutEffect(() => {
    if (!savedPosition) return;
    camera.position.set(savedPosition[0], savedPosition[1], savedPosition[2]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the latest camera state on every frame so we always have the most
  // recent position/target regardless of when the Canvas unmounts.
  useFrame(() => {
    const ctrl = get().controls as { target?: THREE.Vector3 } | null;
    _persistedCameraState = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: ctrl?.target
        ? [ctrl.target.x, ctrl.target.y, ctrl.target.z]
        : DEFAULT_ORBIT_TARGET,
    };
  });

  return null;
}

/**
 * When BEV mode is activated, snaps the camera to a top-down position above the
 * store centre. The OrbitControls maxPolarAngle restriction (set in SceneContent)
 * then prevents the user from rotating away from the top-down view.
 */
function BEVCameraController({ store }: { store: import('../types/cad').StoreConfig }) {
  const { camera, controls } = useThree();
  const bevMode = useUIStore((s) => s.bevMode);
  const prevBev = useRef(false);

  useEffect(() => {
    if (bevMode && !prevBev.current) {
      const w = store.dimensions.width  * CM_TO_UNIT;
      const d = store.dimensions.depth  * CM_TO_UNIT;
      const ox = (store.position?.[0] ?? 0) * CM_TO_UNIT;
      const oz = (store.position?.[2] ?? 0) * CM_TO_UNIT;
      const cx = ox + w / 2;
      const cz = oz + d / 2;
      // Place camera directly above the store centre at a height that shows the whole footprint.
      const height = Math.max(w, d) * BEV_HEIGHT_SCALE + BEV_HEIGHT_BASE;
      camera.position.set(cx, height, cz);
      camera.lookAt(cx, 0, cz);
      // @ts-expect-error drei controls
      controls?.target?.set(cx, 0, cz);
      // @ts-expect-error drei controls
      controls?.update?.();
    }
    prevBev.current = bevMode;
  }, [bevMode, store, camera, controls]);

  return null;
}


function SceneContent({ projectId }: { projectId: string | null }) {
  const { scene, selectedFurnitureId, selectFurniture } = useSceneStore();
  const { activeTool, bevMode } = useUIStore();
  const { selectedZoneId, removeZone, selectZone } = useZoneStore();

  const meshGroupsRef   = useRef<Map<string, THREE.Group>>(new Map());
  const [transformTarget, setTransformTarget] = useState<THREE.Group | null>(null);
  const [isResizeDragging, setIsResizeDragging] = useState(false);
  // Whether the yellow store boundary is currently selected by the user.
  const [storeBoundarySelected, setStoreBoundarySelected] = useState(false);

  // Stable initial orbit target — computed once on mount from persisted state so
  // the same array reference is used on every re-render.  R3F skips re-applying
  // a prop when its reference hasn't changed, which prevents OrbitControls from
  // resetting the target back to this value after the user has panned/orbited.
  const initialOrbitTarget = useRef<[number, number, number]>(
    _persistedCameraState?.target ?? DEFAULT_ORBIT_TARGET
  );

  const registerGroup = useCallback<RegisterFn>((id, group) => {
    if (group) {
      meshGroupsRef.current.set(id, group);
    } else {
      meshGroupsRef.current.delete(id);
    }
    if (id === selectedFurnitureId) {
      setTransformTarget(group);
    }
  }, [selectedFurnitureId]);

  useEffect(() => {
    const grp = selectedFurnitureId ? (meshGroupsRef.current.get(selectedFurnitureId) ?? null) : null;
    setTransformTarget(grp);
  }, [selectedFurnitureId]);

  // Deselect the boundary whenever furniture or a zone is explicitly selected.
  useEffect(() => {
    if (selectedFurnitureId || selectedZoneId) setStoreBoundarySelected(false);
  }, [selectedFurnitureId, selectedZoneId]);

  // Delete selected zone with the Delete/Backspace key
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedZoneId && !selectedFurnitureId) {
        removeZone(selectedZoneId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedZoneId, selectedFurnitureId, removeZone]);

  if (!scene) return null;

  // Selected mounted furniture (has TransformProxy + FurnitureResizeHandles)
  const selectedFurniture = selectedFurnitureId
    ? (scene.furniture.find(f => f.id === selectedFurnitureId && f.mounted !== false) ?? null)
    : null;

  // Selected unmounted furniture (has UnmountedFurnitureResizeHandles)
  const selectedUnmounted = selectedFurnitureId
    ? (scene.furniture.find(f => f.id === selectedFurnitureId && f.mounted === false) ?? null)
    : null;

  // Clicking the store boundary deselects furniture/zones and selects the boundary.
  const handleSelectBoundary = () => {
    selectFurniture(null);
    selectZone(null);
    setStoreBoundarySelected(true);
  };

  // Show transform controls whenever furniture is selected.
  // 'select' and 'translate' both use translate mode; 'rotate' uses rotate mode.
  // Scale mode shows 3D resize handles for resizable furniture types (wall, partition, register).
  const hasSelection        = selectedFurniture != null && transformTarget != null;
  const showTransform       = hasSelection && activeTool !== 'scale' && activeTool !== 'measure';
  // Show furniture resize handles in scale mode for resizable furniture types.
  const showFurnitureResize =
    activeTool === 'scale' &&
    selectedFurniture != null &&
    RESIZABLE_FURNITURE_TYPES.has(selectedFurniture.type);
  // Show boundary handles when the boundary is explicitly selected (any non-measure tool),
  // OR passively in scale mode when nothing else is selected (backward compat).
  const showBoundaryHandles =
    activeTool !== 'measure' &&
    (storeBoundarySelected || (activeTool === 'scale' && !selectedFurnitureId && !selectedZoneId));
  const tMode: 'translate' | 'rotate' = activeTool === 'rotate' ? 'rotate' : 'translate';

  return (
    <ResizeDragCtx.Provider value={setIsResizeDragging}>
      <MeshRegistryCtx.Provider value={registerGroup}>
        <ambientLight intensity={0.55} />
        <directionalLight position={[15, 25, 15]} intensity={0.9} castShadow shadow-mapSize={[2048, 2048]} />
        <pointLight position={[25, 8, 15]} intensity={0.35} color="#cce8ff" />
        <pointLight position={[0,  8, 0]}  intensity={0.2}  color="#fff8e7" />

        <StoreFloor store={scene.store} />
        <StoreBoundary
          store={scene.store}
          isSelected={storeBoundarySelected}
          onSelect={handleSelectBoundary}
        />
        <FloorZoneLayer />
        <MeasureTool store={scene.store} />

        {/* Mounted furniture rendered as full 3D objects */}
        {scene.furniture.filter((f) => f.mounted !== false).map((f) => (
          <FurnitureMesh key={f.id} furniture={f} />
        ))}

        {/* Unmounted furniture rendered as draggable floor rectangles */}
        {scene.furniture.filter((f) => f.mounted === false).map((f) => (
          <UnmountedFurnitureMesh key={f.id} furniture={f} projectId={projectId} />
        ))}

        {/* Resize handles for the selected unmounted furniture */}
        {selectedUnmounted && (
          <UnmountedFurnitureResizeHandles furniture={selectedUnmounted} projectId={projectId} />
        )}

        {showTransform && (
          <TransformProxy
            furniture={selectedFurniture}
            transformTarget={transformTarget}
            mode={tMode}
            projectId={projectId}
          />
        )}

        {showFurnitureResize && (
          <FurnitureResizeHandles furniture={selectedFurniture} projectId={projectId} />
        )}

        {showBoundaryHandles && (
          <StoreBoundaryResizeHandles store={scene.store} projectId={projectId} />
        )}

        {/*
          Orbit controls: fully disabled while any resize drag is in progress so
          that the camera does not spin / pan at the same time.  Rotation is also
          disabled whenever furniture or a zone is selected, or in BEV mode.
        */}
        <OrbitControls
          makeDefault
          target={initialOrbitTarget.current}
          enabled={!isResizeDragging}
          enableRotate={!isResizeDragging && !selectedFurnitureId && !selectedZoneId && !bevMode}
          maxPolarAngle={bevMode ? BEV_MAX_POLAR_ANGLE : Math.PI}
        />
        {/* Saves/restores camera state across Canvas remounts (3D↔planogram mode switch). */}
        <CameraStateSync savedPosition={_persistedCameraState?.position} />
        <BEVCameraController store={scene.store} />
        <CameraFlyToFurniture />
      </MeshRegistryCtx.Provider>
    </ResizeDragCtx.Provider>
  );
}

// ─── SceneEditor ─────────────────────────────────────────────────────────────
function SceneEditor({ projectId }: { projectId: string | null }) {
  const { scene } = useSceneStore();
  const { zones, zonesLoaded } = useZoneStore();

  // Keep a stable ref to the latest scene so the save timer closure is always fresh.
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // ── Video recording ───────────────────────────────────────────────────────
  const canvasWrapperRef    = useRef<HTMLDivElement>(null);
  const mediaRecorderRef    = useRef<MediaRecorder | null>(null);
  const recordChunksRef     = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);

  const startRecording = useCallback(() => {
    const canvas = canvasWrapperRef.current?.querySelector('canvas');
    if (!canvas) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: MediaStream = (canvas as any).captureStream(60);
    const mimeType = ['video/webm; codecs=vp9', 'video/webm; codecs=vp8', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const mr = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: RECORDING_BITRATE,
    });
    recordChunksRef.current = [];
    mr.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(recordChunksRef.current, { type: 'video/webm' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `scene_${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };
    mr.start();
    mediaRecorderRef.current = mr;
    setRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  }, []);

  // Auto-save zones whenever they change after the initial load from the backend.
  useEffect(() => {
    if (!zonesLoaded || !projectId) return;
    const timer = setTimeout(() => {
      const s = sceneRef.current;
      if (s) cadApi.updateStore(projectId, { ...s.store, zones }).catch(console.error);
    }, ZONE_AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [zones, zonesLoaded, projectId]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-gray-950">
        <p className="text-gray-500 text-sm">No project selected</p>
      </div>
    );
  }

  return (
    <div ref={canvasWrapperRef} className="relative w-full h-full">
      {!scene && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-gray-950">
          <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-gray-500 text-sm">Loading scene…</p>
        </div>
      )}
      <Canvas camera={{ position: [25, 15, 35], fov: 50 }} shadows style={{ width: '100%', height: '100%' }}>
        <color attach="background" args={['#111827']} />
        <Suspense fallback={null}>
          <SceneContent projectId={projectId} />
          <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
            <GizmoViewport axisColors={['#e84545', '#52b788', '#4a9eff']} />
          </GizmoHelper>
        </Suspense>
      </Canvas>

      {/* ── Video recording controls ────────────────────────────────────── */}
      <div className="absolute top-2 right-2 z-20 flex items-center gap-2">
        {recording ? (
          <>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-950/90 border border-red-700 text-red-300 text-xs font-semibold select-none">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
              On Air
            </span>
            <button
              onClick={stopRecording}
              title="Arrêter l'enregistrement"
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-gray-800 text-white text-xs font-medium hover:bg-gray-700 transition-colors border border-gray-600"
            >
              ⏹ Stop
            </button>
          </>
        ) : (
          <button
            onClick={startRecording}
            title="Enregistrer une vidéo de la scène 3D"
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-gray-800 text-gray-300 text-xs font-medium hover:bg-red-900 hover:text-white transition-colors border border-gray-700"
          >
            ⏺ Enregistrer
          </button>
        )}
      </div>

      {/* Hint overlay */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-none">
        <span className="px-2 py-1 rounded text-xs text-gray-500 bg-black/40">
          Clic → sélectionner une cellule &nbsp;·&nbsp; <kbd className="font-mono">Ctrl</kbd>+Clic → ouvrir le planogramme
        </span>
      </div>
    </div>
  );
}

export { SceneEditor };

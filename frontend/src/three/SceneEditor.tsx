import { Suspense, useState, useRef, useEffect, useCallback, createContext, useContext, useMemo } from 'react';
import type React from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Html, TransformControls, Grid, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useSceneStore } from '../store/sceneStore';
import { useUIStore } from '../store/uiStore';
import { usePlanogramStore } from '../store/planogramStore';
import { useCatalogStore } from '../store/catalogStore';
import { useZoneStore } from '../store/zoneStore';
import type { FloorZone } from '../types/cad';
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

/**
 * Angle thresholds (radians) used to decide whether a handle's drag axis
 * appears more horizontal (EW) or vertical (NS) on screen.
 * 45° = π/4, 135° = 3π/4.
 */
const ANGLE_45_DEG  = Math.PI / 4;
const ANGLE_135_DEG = 3 * Math.PI / 4;

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
  const setSelection = useSceneStore((state) => state.setSelection);
  const selection    = useSceneStore((state) => state.selection);
  const setRequestOpenPlanogramId = usePlanogramStore((state) => state.setRequestOpenPlanogramId);
  const { products } = useCatalogStore();
  const planogram = planogramDetails.get(planogramId);

  // ID of the selected cell within THIS planogram (null if selection is elsewhere)
  const selectedCellId =
    selection.type === 'planogram_cell' &&
    selection.planogramId === planogramId &&
    selection.cellIds?.length === 1
      ? selection.cellIds[0]
      : null;

  const texture = useMemo(() => {
    if (!planogram) return null;
    const productByEan = new Map(products.map((p) => [p.ean, p]));
    const cellPx = 10;
    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, planogram.cols * cellPx);
    canvas.height = Math.max(1, planogram.rows * cellPx);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#1c2030';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const cell of planogram.cells) {
      const prod  = productByEan.get(cell.ean);
      const color = prod ? (PLANO_CATEGORY_COLORS[prod.category] ?? '#888888') : '#444455';
      ctx.fillStyle = color;
      ctx.fillRect(cell.col * cellPx + 1, cell.row * cellPx + 1, cellPx - 2, cellPx - 2);
    }

    // Highlight the selected cell with a bright yellow outline + tint
    if (selectedCellId) {
      const selCell = planogram.cells.find((c) => c.id === selectedCellId);
      if (selCell) {
        ctx.fillStyle = 'rgba(255,230,0,0.35)';
        ctx.fillRect(selCell.col * cellPx + 1, selCell.row * cellPx + 1, cellPx - 2, cellPx - 2);
        ctx.strokeStyle = '#ffe000';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(selCell.col * cellPx + 1, selCell.row * cellPx + 1, cellPx - 2, cellPx - 2);
      }
    }

    return new THREE.CanvasTexture(canvas);
  }, [planogram, products, selectedCellId]);

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
    const col = Math.min(planogram.cols - 1, Math.max(0, Math.floor(event.uv.x * planogram.cols)));
    const row = Math.min(planogram.rows - 1, Math.max(0, Math.floor((1 - event.uv.y) * planogram.rows)));
    const cell = planogram.cells.find((item) => item.row === row && item.col === col);
    if (!cell) return;
    event.stopPropagation();
    setSelection({
      type: 'planogram_cell',
      ean: cell.ean,
      furnitureId: planogram.furnitureId,
      planogramId: planogram.id,
      cellIds: [cell.id],
    });
  }, [planogram, setSelection, setRequestOpenPlanogramId]);

  if (!texture) return null;

  // Compute position, rotation, and plane size for each face
  let position: [number, number, number];
  let rotation: [number, number, number];
  let faceW: number;
  let faceH: number;

  switch (face) {
    case 'front':
      position = [0, 0,  D / 2 + OVERLAY_Z_OFFSET];
      rotation = [0, 0, 0];
      faceW = W; faceH = H;
      break;
    case 'back':
      position = [0, 0, -(D / 2 + OVERLAY_Z_OFFSET)];
      rotation = [0, Math.PI, 0];
      faceW = W; faceH = H;
      break;
    case 'left':
      position = [-(W / 2 + OVERLAY_Z_OFFSET), 0, 0];
      rotation = [0, -Math.PI / 2, 0];
      faceW = D; faceH = H;
      break;
    case 'right':
      position = [ W / 2 + OVERLAY_Z_OFFSET, 0, 0];
      rotation = [0, Math.PI / 2, 0];
      faceW = D; faceH = H;
      break;
    case 'top':
      position = [0, H / 2 + OVERLAY_Z_OFFSET, 0];
      rotation = [-Math.PI / 2, 0, 0];
      faceW = W; faceH = D;
      break;
    default: {
      const _exhaustive: never = face;
      throw new Error(`Unhandled face: ${_exhaustive}`);
    }
  }

  return (
    <mesh position={position} rotation={rotation} onClick={handleClick}>
      <planeGeometry args={[faceW * 0.97, faceH * 0.97]} />
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
  const { selectedFurnitureId, selectFurniture, selection } = useSceneStore();
  const { activeTool } = useUIStore();
  const registerGroup = useContext(MeshRegistryCtx);
  const groupRef = useRef<THREE.Group>(null!);

  const isSelected  = selectedFurnitureId === furniture.id;
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

  // Compute the horizontal offset of the selected cell within its face so the
  // semi-circle is centred under the product, not the whole gondola.
  // Default to 0 (gondola centre) when planogram data is unavailable.
  let semiCircleConfig: Record<string, { pos: [number, number, number]; yRot: number }> = {
    front: { pos: [0,      -H / 2 + 0.02,  D / 2], yRot: 0            },
    back:  { pos: [0,      -H / 2 + 0.02, -D / 2], yRot: Math.PI      },
    right: { pos: [ W / 2, -H / 2 + 0.02, 0     ], yRot:  Math.PI / 2 },
    left:  { pos: [-W / 2, -H / 2 + 0.02, 0     ], yRot: -Math.PI / 2 },
  };

  if (isProductSelected && selection.planogramId && selection.cellIds?.length) {
    const planogram = planogramDetails.get(selection.planogramId);
    const cell = planogram?.cells.find((c) => c.id === selection.cellIds![0]);
    if (planogram && cell) {
      // t ∈ [0,1]: normalised column position from the left edge viewed from outside.
      const t = (cell.col + 0.5) / planogram.cols;
      // Front face: col=0 → left → local -X direction.
      const cellXf =  t * W - W / 2;
      // Back face is mirrored in X compared with the front face.
      const cellXb = W / 2 - t * W;
      // Right face: col=0 → local +Z side (viewed from +X, left = +Z).
      const cellZr = D / 2 - t * D;
      // Left face is mirrored in Z compared with the right face.
      const cellZl = t * D - D / 2;
      semiCircleConfig = {
        front: { pos: [cellXf,  -H / 2 + 0.02,  D / 2], yRot: 0            },
        back:  { pos: [cellXb,  -H / 2 + 0.02, -D / 2], yRot: Math.PI      },
        right: { pos: [ W / 2,  -H / 2 + 0.02,  cellZr], yRot:  Math.PI / 2 },
        left:  { pos: [-W / 2,  -H / 2 + 0.02,  cellZl], yRot: -Math.PI / 2 },
      };
    }
  }

  const scc = semiCircleConfig[selectedFace] ?? semiCircleConfig.front;

  const handleClick = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
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

      {/* Customer proximity semi-circle — 2 m radius, shown when a product cell on this
          gondola is selected. Flat edge = gondola face; arc extends into the aisle. */}
      {isProductSelected && (
        <mesh position={scc.pos} rotation={[Math.PI / 2, scc.yRot, 0]}>
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
      const newRotY = (obj.rotation.y * 180) / Math.PI;
      const snappedRotY = Math.round(newRotY / 90) * 90;
      obj.rotation.y = snappedRotY * (Math.PI / 180);
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

// ─── Resize handles (scale mode — one handle per face, drags from that side) ──
interface ResizeHandlesProps {
  furniture: FurnitureInstance;
  projectId: string | null;
}

function ResizeHandles({ furniture, projectId }: ResizeHandlesProps) {
  const { updateFurniture } = useSceneStore();
  const { gl, raycaster, camera } = useThree();

  const W  = furniture.dimensions.width  * CM_TO_UNIT;
  const H  = furniture.dimensions.height * CM_TO_UNIT;
  const D  = furniture.dimensions.depth  * CM_TO_UNIT;
  const ry = furniture.rotation[1] * (Math.PI / 180);
  const px = furniture.position[0] * CM_TO_UNIT;
  const pz = furniture.position[2] * CM_TO_UNIT;

  // Drag state — all refs so event listeners stay stable.
  const isDragging    = useRef(false);
  const dragAxis      = useRef<'width' | 'depth'>('width');
  const dragSign      = useRef<1 | -1>(1);
  const dragStart     = useRef(new THREE.Vector3());
  const pointerIdRef  = useRef(-1);
  const baseFurRef    = useRef<FurnitureInstance>(furniture);
  /** Tracks the latest intermediate furniture value during a drag. */
  const currentFurRef = useRef<FurnitureInstance>(furniture);
  currentFurRef.current = furniture;

  // Pre-allocated vectors reused every pointermove to reduce GC pressure.
  const _lx    = useRef(new THREE.Vector3());
  const _lz    = useRef(new THREE.Vector3());
  const _hit   = useRef(new THREE.Vector3());
  const _delta = useRef(new THREE.Vector3());
  const _ndc   = useRef(new THREE.Vector2());

  /** Horizontal Y=0 plane used for raycasting during a drag. */
  const dragPlane = useMemo(() => new THREE.Plane(UP_VEC3, 0), []);

  /** Write the world-space hit point on the drag plane into `out`; returns false if ray is parallel. */
  const getHitPoint = useCallback((clientX: number, clientY: number, out: THREE.Vector3): boolean => {
    const rect = gl.domElement.getBoundingClientRect();
    _ndc.current.set(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      -((clientY - rect.top)  / rect.height) *  2 + 1,
    );
    raycaster.setFromCamera(_ndc.current, camera);
    return raycaster.ray.intersectPlane(dragPlane, out) !== null;
  }, [gl, raycaster, camera, dragPlane]);

  /** Called from each handle's pointerDown handler. */
  const startDrag = useCallback((
    axis: 'width' | 'depth',
    sign: 1 | -1,
    clientX: number,
    clientY: number,
    pointerId: number,
  ) => {
    if (!getHitPoint(clientX, clientY, dragStart.current)) return; // ray parallel to plane — ignore
    baseFurRef.current   = currentFurRef.current;
    isDragging.current   = true;
    dragAxis.current     = axis;
    dragSign.current     = sign;
    pointerIdRef.current = pointerId;
  }, [getHitPoint]);

  useEffect(() => {
    let rafId = 0;

    const onMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      // Capture coords synchronously; compute and update inside rAF to throttle.
      const { clientX, clientY } = e;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const base = baseFurRef.current;
        const bW  = base.dimensions.width  * CM_TO_UNIT;
        const bD  = base.dimensions.depth  * CM_TO_UNIT;
        const bRy = base.rotation[1] * (Math.PI / 180);

        // Local axes of the furniture in world space (reused vectors).
        const lx = _lx.current.set( Math.cos(bRy), 0, Math.sin(bRy));
        const lz = _lz.current.set(-Math.sin(bRy), 0, Math.cos(bRy));

        const bCx = base.position[0] * CM_TO_UNIT + bW / 2;
        const bCz = base.position[2] * CM_TO_UNIT + bD / 2;

        if (!getHitPoint(clientX, clientY, _hit.current)) return; // ray parallel — skip frame
        const delta = _delta.current.copy(_hit.current).sub(dragStart.current);
        const sign  = dragSign.current;

        const newDims = { ...base.dimensions };
        const newPos  = [...base.position] as [number, number, number];

        if (dragAxis.current === 'width') {
          // How much the dragged face moved (positive = outward).
          const move = delta.dot(lx) * sign;
          const newW = Math.max(MIN_DIM_CM * CM_TO_UNIT, bW + move);
          const dW   = newW - bW;
          // Shift center along the local X axis toward the dragged side.
          const newCx = bCx + Math.cos(bRy) * dW / 2 * sign;
          const newCz = bCz + Math.sin(bRy) * dW / 2 * sign;
          newDims.width = newW / CM_TO_UNIT;
          newPos[0]     = (newCx - newW / 2) / CM_TO_UNIT;
          newPos[2]     = (newCz - bD  / 2)  / CM_TO_UNIT;
        } else {
          const move = delta.dot(lz) * sign;
          const newD = Math.max(MIN_DIM_CM * CM_TO_UNIT, bD + move);
          const dD   = newD - bD;
          const newCx = bCx + (-Math.sin(bRy)) * dD / 2 * sign;
          const newCz = bCz +   Math.cos(bRy)  * dD / 2 * sign;
          newDims.depth = newD / CM_TO_UNIT;
          newPos[0]     = (newCx - bW  / 2) / CM_TO_UNIT;
          newPos[2]     = (newCz - newD / 2) / CM_TO_UNIT;
        }

        updateFurniture({ ...base, dimensions: newDims, position: newPos });
      });
    };

    const onUp = () => {
      if (!isDragging.current) return;
      cancelAnimationFrame(rafId);
      isDragging.current = false;

      // Release pointer capture explicitly.
      if (pointerIdRef.current >= 0) {
        try {
          gl.domElement.releasePointerCapture(pointerIdRef.current);
        } catch (err) {
          console.warn('releasePointerCapture failed:', err);
        }
        pointerIdRef.current = -1;
      }

      // Snap final position and dimensions to the grid.
      // Clamp to minimum first so the snapped value can never fall below it.
      const cur = currentFurRef.current;
      const snapDim = (v: number) => snapToCm(Math.max(MIN_DIM_CM, v));
      const snapped: FurnitureInstance = {
        ...cur,
        position: [snapToCm(cur.position[0]), cur.position[1], snapToCm(cur.position[2])],
        dimensions: {
          ...cur.dimensions,
          width: snapDim(cur.dimensions.width),
          depth: snapDim(cur.dimensions.depth),
        },
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
  }, [gl, getHitPoint, updateFurniture, projectId]);

  // Ensure cursor is reset when this component unmounts (e.g. tool switch or deselect).
  useEffect(() => () => { document.body.style.cursor = 'auto'; }, []);

  // ── Render four face handles (+W, -W, +D, -D) ──
  const centerX = px + W / 2;
  const centerZ = pz + D / 2;

  // Choose resize cursor based on the handle's approximate screen-space orientation.
  // The width axis (local X) is along world [cos(ry), 0, sin(ry)]; depth is 90° offset.
  // ANGLE_45_DEG / ANGLE_135_DEG split the rotation into quadrants where width appears
  // more horizontal (EW) vs vertical (NS) on a top-down view.
  const ryMod180 = Math.abs(ry % Math.PI);
  const widthIsEW = ryMod180 < ANGLE_45_DEG || ryMod180 > ANGLE_135_DEG;

  const handles: { axis: 'width' | 'depth'; sign: 1 | -1; lx: number; lz: number }[] = [
    { axis: 'width', sign:  1, lx:  Math.cos(ry),  lz:  Math.sin(ry) },
    { axis: 'width', sign: -1, lx: -Math.cos(ry),  lz: -Math.sin(ry) },
    { axis: 'depth', sign:  1, lx: -Math.sin(ry),  lz:  Math.cos(ry) },
    { axis: 'depth', sign: -1, lx:  Math.sin(ry),  lz: -Math.cos(ry) },
  ];

  return (
    <group>
      {handles.map(({ axis, sign, lx: hlx, lz: hlz }) => {
        const halfDim = axis === 'width' ? W / 2 : D / 2;
        const hx = centerX + hlx * halfDim;
        const hz = centerZ + hlz * halfDim;
        // 'width' axis is EW when widthIsEW; depth is always the opposite.
        const cursor = (axis === 'width') === widthIsEW ? 'ew-resize' : 'ns-resize';
        return (
          <HandleMesh
            key={`${axis}${sign}`}
            position={[hx, H / 2, hz]}
            axis={axis}
            sign={sign}
            cursor={cursor}
            onStartDrag={startDrag}
          />
        );
      })}
    </group>
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

// ─── Store Floor + fine grid ───────────────────────────────────────────────────
function StoreFloor({ store }: { store: StoreConfig }) {
  const { selectFurniture } = useSceneStore();
  const { selectZone } = useZoneStore();
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
      <mesh position={[w / 2, -0.05, d / 2]} receiveShadow onClick={handleFloorClick}>
        <boxGeometry args={[w, 0.1, d]} />
        <meshStandardMaterial color={store.floorColor || '#1e2230'} />
      </mesh>

      {/* Fine grid: 1 m cells, 5 m sections */}
      <Grid
        position={[w / 2, GRID_Y_OFFSET, d / 2]}
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

  const w = store.dimensions.width  * CM_TO_UNIT;
  const d = store.dimensions.depth  * CM_TO_UNIT;
  const y = GRID_Y_OFFSET + 0.012;

  const lineColor = isSelected ? '#ffe566' : hovered ? '#fde047' : '#facc15';

  const corners: [number, number, number][] = [
    [0, y, 0],
    [w, y, 0],
    [w, y, d],
    [0, y, d],
    [0, y, 0],
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
  const hitBoxes: { px: number; pz: number; sx: number; sz: number }[] = [
    { px: w / 2, pz: 0,     sx: w, sz: BOUNDARY_HIT_HALF * 2 }, // south
    { px: w / 2, pz: d,     sx: w, sz: BOUNDARY_HIT_HALF * 2 }, // north
    { px: 0,     pz: d / 2, sx: BOUNDARY_HIT_HALF * 2, sz: d }, // west
    { px: w,     pz: d / 2, sx: BOUNDARY_HIT_HALF * 2, sz: d }, // east
  ];

  return (
    <>
      <Line points={corners} color={lineColor} lineWidth={isSelected ? 4 : hovered ? 3.5 : 3} />
      {hitBoxes.map((hb, i) => (
        <mesh
          key={i}
          position={[hb.px, y, hb.pz]}
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

  const getHitPoint = useCallback((clientX: number, clientY: number, out: THREE.Vector3): boolean => {
    const rect = gl.domElement.getBoundingClientRect();
    _ndc.current.set(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      -((clientY - rect.top) / rect.height) *  2 + 1,
    );
    raycaster.setFromCamera(_ndc.current, camera);
    return raycaster.ray.intersectPlane(dragPlane, out) !== null;
  }, [gl, raycaster, camera, dragPlane]);

  const startDrag = useCallback((
    axis: 'width' | 'depth',
    sign: 1 | -1,
    clientX: number,
    clientY: number,
    pointerId: number,
  ) => {
    if (!getHitPoint(clientX, clientY, dragStart.current)) return;
    baseStoreRef.current = curStoreRef.current;
    isDragging.current   = true;
    dragAxis.current     = axis;
    dragSign.current     = sign;
    pointerIdRef.current = pointerId;
    setResizeDragging(true);
  }, [getHitPoint, setResizeDragging]);

  useEffect(() => {
    let rafId = 0;

    const onMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const base = baseStoreRef.current;
        const bW   = base.dimensions.width  * CM_TO_UNIT;
        const bD   = base.dimensions.depth  * CM_TO_UNIT;

        if (!getHitPoint(clientX, clientY, _hit.current)) return;
        const delta = _delta.current.copy(_hit.current).sub(dragStart.current);
        const sign  = dragSign.current;

        const newDims = { ...base.dimensions };

        if (dragAxis.current === 'width') {
          const move = delta.x * sign;
          newDims.width = Math.max(MIN_STORE_DIM_CM, (bW + move) / CM_TO_UNIT);
        } else {
          const move = delta.z * sign;
          newDims.depth = Math.max(MIN_STORE_DIM_CM, (bD + move) / CM_TO_UNIT);
        }

        updateStore({ ...base, dimensions: newDims });
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

      const cur = curStoreRef.current;
      const snapDim = (v: number) => snapToCm(Math.max(MIN_STORE_DIM_CM, v));
      const snapped: StoreConfig = {
        ...cur,
        dimensions: {
          ...cur.dimensions,
          width: snapDim(cur.dimensions.width),
          depth: snapDim(cur.dimensions.depth),
        },
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
  }, [gl, getHitPoint, updateStore, projectId, setResizeDragging]);

  useEffect(() => () => { document.body.style.cursor = 'auto'; }, []);

  // Two handles: right edge and far edge only.
  // The left and near edges cannot be resized independently because StoreConfig
  // has no origin position — dragging them would move the opposite edge instead.
  const handles: { axis: 'width' | 'depth'; sign: 1 | -1; hx: number; hz: number; cursor: string }[] = [
    { axis: 'width',  sign:  1, hx: W,     hz: D / 2, cursor: 'ew-resize' }, // right edge
    { axis: 'depth',  sign:  1, hx: W / 2, hz: D,     cursor: 'ns-resize' }, // far edge
  ];

  return (
    <group>
      {handles.map(({ axis, sign, hx, hz, cursor }) => (
        <HandleMesh
          key={`store-${axis}${sign}`}
          position={[hx, BOUNDARY_HANDLE_Y, hz]}
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

  const getHitPoint = useCallback((clientX: number, clientY: number, out: THREE.Vector3): boolean => {
    const rect = gl.domElement.getBoundingClientRect();
    _ndc.current.set(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      -((clientY - rect.top) / rect.height) *  2 + 1,
    );
    raycaster.setFromCamera(_ndc.current, camera);
    return raycaster.ray.intersectPlane(dragPlane, out) !== null;
  }, [gl, raycaster, camera, dragPlane]);

  useEffect(() => {
    let rafId = 0;

    const onMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const base = baseZoneRef.current;
        if (!getHitPoint(clientX, clientY, _hit.current)) return;
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
  }, [gl, getHitPoint, updateZone]);

  useEffect(() => () => { document.body.style.cursor = 'auto'; }, []);

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (activeTool === 'measure') return;
    e.stopPropagation();
    selectZone(zone.id);
    selectFurniture(null);
    if (!getHitPoint(e.clientX, e.clientY, dragStart.current)) return;
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

  const getHitPoint = useCallback((clientX: number, clientY: number, out: THREE.Vector3): boolean => {
    const rect = gl.domElement.getBoundingClientRect();
    _ndc.current.set(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      -((clientY - rect.top) / rect.height) *  2 + 1,
    );
    raycaster.setFromCamera(_ndc.current, camera);
    return raycaster.ray.intersectPlane(dragPlane, out) !== null;
  }, [gl, raycaster, camera, dragPlane]);

  const startDrag = useCallback((
    axis: 'width' | 'depth',
    sign: 1 | -1,
    clientX: number,
    clientY: number,
    pointerId: number,
  ) => {
    if (!getHitPoint(clientX, clientY, dragStart.current)) return;
    baseZoneRef.current  = curZoneRef.current;
    isDragging.current   = true;
    dragAxis.current     = axis;
    dragSign.current     = sign;
    pointerIdRef.current = pointerId;
    setResizeDragging(true);
  }, [getHitPoint, setResizeDragging]);

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

        if (!getHitPoint(clientX, clientY, _hit.current)) return;
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
  }, [gl, getHitPoint, updateZone, setResizeDragging]);

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
        position={[w / 2, GRID_Y_OFFSET + 0.02, d / 2]}
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

// ─── Scene Content ────────────────────────────────────────────────────────────
function SceneContent({ projectId }: { projectId: string | null }) {
  const { scene, selectedFurnitureId, selectFurniture } = useSceneStore();
  const { activeTool } = useUIStore();
  const { selectedZoneId, removeZone, selectZone } = useZoneStore();

  const meshGroupsRef   = useRef<Map<string, THREE.Group>>(new Map());
  const [transformTarget, setTransformTarget] = useState<THREE.Group | null>(null);
  const [isResizeDragging, setIsResizeDragging] = useState(false);
  // Whether the yellow store boundary is currently selected by the user.
  const [storeBoundarySelected, setStoreBoundarySelected] = useState(false);

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

  const selectedFurniture = selectedFurnitureId
    ? scene.furniture.find(f => f.id === selectedFurnitureId) ?? null
    : null;

  // Clicking the store boundary deselects furniture/zones and selects the boundary.
  const handleSelectBoundary = () => {
    selectFurniture(null);
    selectZone(null);
    setStoreBoundarySelected(true);
  };

  // Show transform controls whenever furniture is selected.
  // 'select' and 'translate' both use translate mode; 'rotate' uses rotate mode.
  // 'scale' uses the custom ResizeHandles component instead.
  const hasSelection        = selectedFurniture != null && transformTarget != null;
  const showResizeHandles   = hasSelection && activeTool === 'scale';
  const showTransform       = hasSelection && activeTool !== 'scale' && activeTool !== 'measure';
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

        {scene.furniture.map((f) => (
          <FurnitureMesh key={f.id} furniture={f} />
        ))}

        {showTransform && (
          <TransformProxy
            furniture={selectedFurniture}
            transformTarget={transformTarget}
            mode={tMode}
            projectId={projectId}
          />
        )}

        {showResizeHandles && (
          <ResizeHandles furniture={selectedFurniture} projectId={projectId} />
        )}

        {showBoundaryHandles && (
          <StoreBoundaryResizeHandles store={scene.store} projectId={projectId} />
        )}

        {/*
          Orbit controls: fully disabled while any resize drag is in progress so
          that the camera does not spin / pan at the same time.  Rotation is also
          disabled whenever furniture or a zone is selected.
        */}
        <OrbitControls
          makeDefault
          target={[25, 0, 15]}
          enabled={!isResizeDragging}
          enableRotate={!isResizeDragging && !selectedFurnitureId && !selectedZoneId}
        />
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
      videoBitsPerSecond: 8_000_000,
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

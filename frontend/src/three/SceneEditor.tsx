import { Suspense, useState, useRef, useEffect, useCallback, createContext, useContext, useMemo } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Html, TransformControls, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { useSceneStore } from '../store/sceneStore';
import { useUIStore } from '../store/uiStore';
import { usePlanogramStore } from '../store/planogramStore';
import { useCatalogStore } from '../store/catalogStore';
import { cadApi } from '../api/cad';
import { CM_TO_UNIT } from '../constants';
import type { ActiveTool } from '../store/uiStore';
import type { FurnitureInstance, StoreConfig } from '../types/cad';

// ─── Grid / snap constants ─────────────────────────────────────────────────────
/** Snap grid step in centimetres (10 cm). */
const SNAP_CM   = 10;
/** Snap grid step in Three.js units (1 unit = 100 cm → 10 cm = 0.1 units). */
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
/** Shared up-vector reused across components to avoid per-render allocations. */
const UP_VEC3 = new THREE.Vector3(0, 1, 0);

// ─── Mesh registry context ───────────────────────────────────────────────────
type RegisterFn = (id: string, group: THREE.Group | null) => void;
const MeshRegistryCtx = createContext<RegisterFn>(() => {});

// ─── Color map ────────────────────────────────────────────────────────────────
const FURNITURE_COLORS: Record<string, string> = {
  gondola_single: '#dde2e8',
  gondola_double: '#d4dae2',
  end_gondola:    '#cdd4dc',
  fridge:         '#b8d4e8',
  register:       '#c4905a',
  wall:           '#9b9b9b',
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

// ─── Planogram face overlay ───────────────────────────────────────────────────
/** Renders a canvas-based texture showing product category colors on a gondola face. */
function PlanogramFaceOverlay({
  planogramId,
  W,
  H,
  D,
  side,
}: {
  planogramId: string;
  W: number;
  H: number;
  D: number;
  /** +1 = front face (+Z), -1 = back face (-Z) */
  side: 1 | -1;
}) {
  const { planogramDetails } = usePlanogramStore();
  const { products } = useCatalogStore();
  const planogram = planogramDetails.get(planogramId);

  const texture = useMemo(() => {
    if (!planogram || planogram.cells.length === 0) return null;
    const productByEan = new Map(products.map((p) => [p.ean, p]));
    const cellPx = 10;
    const canvas = document.createElement('canvas');
    canvas.width  = planogram.cols * cellPx;
    canvas.height = planogram.rows * cellPx;
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

    return new THREE.CanvasTexture(canvas);
  }, [planogram, products]);

  useEffect(() => {
    return () => { texture?.dispose(); };
  }, [texture]);

  if (!texture) return null;

  const zOffset = (D / 2 + OVERLAY_Z_OFFSET) * side;
  const rotY    = side === -1 ? Math.PI : 0;

  return (
    <mesh position={[0, 0, zOffset]} rotation={[0, rotY, 0]}>
      <planeGeometry args={[W * 0.97, H * 0.97]} />
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
  const { selectedFurnitureId, selectFurniture } = useSceneStore();
  const { activeTool } = useUIStore();
  const registerGroup = useContext(MeshRegistryCtx);
  const groupRef = useRef<THREE.Group>(null!);

  if (!furniture.visible) return null;

  const isSelected = selectedFurnitureId === furniture.id;
  const isGondola  = furniture.type.startsWith('gondola') || furniture.type === 'end_gondola';

  const W  = furniture.dimensions.width  * CM_TO_UNIT;
  const H  = furniture.dimensions.height * CM_TO_UNIT;
  const D  = furniture.dimensions.depth  * CM_TO_UNIT;
  const px = furniture.position[0] * CM_TO_UNIT;
  const py = furniture.position[1] * CM_TO_UNIT;
  const pz = furniture.position[2] * CM_TO_UNIT;
  const ry = furniture.rotation[1] * (Math.PI / 180);

  const baseColor = getFurnitureColor(furniture.type);
  const color = isSelected ? '#4a9eff' : hovered ? '#a8c8ff' : baseColor;

  const handleClick = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (!SELECTABLE_TOOLS.has(activeTool)) return;
    selectFurniture(furniture.id);
  };

  // Callback ref keeps the registry entry fresh on every re-render and handles unmount
  const setGroupRef = useCallback((node: THREE.Group | null) => {
    groupRef.current = node!;
    registerGroup(furniture.id, node);
  }, [furniture.id, registerGroup]);

  return (
    <group
      ref={setGroupRef}
      position={[px + W / 2, py + H / 2, pz + D / 2]}
      rotation={[0, ry, 0]}
      onClick={handleClick}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
    >
      {/* Main body — simple box for all furniture types */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[W, H, D]} />
        <meshStandardMaterial
          color={color}
          emissive={isSelected ? '#1a3a6a' : hovered ? '#1a1a3a' : '#000000'}
          emissiveIntensity={isSelected ? 0.35 : hovered ? 0.12 : 0}
          roughness={isGondola ? 0.4 : 0.55}
          metalness={isGondola ? 0.5 : 0.25}
        />
      </mesh>

      {/* Planogram face overlays (gondola-type furniture only) */}
      {isGondola && furniture.faces.front && (
        <PlanogramFaceOverlay
          planogramId={furniture.faces.front}
          W={W} H={H} D={D}
          side={1}
        />
      )}
      {isGondola && furniture.faces.back && (
        <PlanogramFaceOverlay
          planogramId={furniture.faces.back}
          W={W} H={H} D={D}
          side={-1}
        />
      )}

      {/* Name label */}
      <Html position={[0, H / 2 + 0.3, 0]} center>
        <div
          style={{
            color: 'white',
            fontSize: '11px',
            whiteSpace: 'nowrap',
            background: 'rgba(0,0,0,0.72)',
            padding: '2px 6px',
            borderRadius: '3px',
            pointerEvents: 'none',
            fontFamily: 'ui-monospace, monospace',
            border: isSelected ? '1px solid #4a9eff' : '1px solid transparent',
          }}
        >
          {furniture.name}
        </div>
      </Html>
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
      const updated = {
        ...furniture,
        rotation: [furniture.rotation[0], newRotY, furniture.rotation[2]] as [number, number, number],
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
      onMouseUp={handleMouseUp}
    />
  );
}

// ─── Resize handles (scale mode — one handle per face, drags from that side) ──
interface ResizeHandlesProps {
  furniture: FurnitureInstance;
  projectId: string | null;
}

/** Small cube shown on each face when the scale tool is active. */
const HANDLE_SIZE  = 0.12;
const HANDLE_COLOR = '#ffcc00';
const HANDLE_HOVER = '#ffffff';

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
      const cur = currentFurRef.current;
      const snapped: FurnitureInstance = {
        ...cur,
        position: [snapToCm(cur.position[0]), cur.position[1], snapToCm(cur.position[2])],
        dimensions: {
          ...cur.dimensions,
          width: Math.max(MIN_DIM_CM, snapToCm(cur.dimensions.width)),
          depth: Math.max(MIN_DIM_CM, snapToCm(cur.dimensions.depth)),
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
  // The width axis (local X) is along world [cos(ry), 0, sin(ry)]; the depth axis is 90° offset.
  const ryMod180 = Math.abs(ry % Math.PI);
  const widthIsEW = ryMod180 < Math.PI / 4 || ryMod180 > (3 * Math.PI) / 4;

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
      <meshStandardMaterial color={hovered ? HANDLE_HOVER : HANDLE_COLOR} emissive={hovered ? '#664400' : '#000'} emissiveIntensity={0.4} />
    </mesh>
  );
}

// ─── Store Floor + fine grid ───────────────────────────────────────────────────
function StoreFloor({ store }: { store: StoreConfig }) {
  const { selectFurniture } = useSceneStore();
  const w = store.dimensions.width  * CM_TO_UNIT;
  const d = store.dimensions.depth  * CM_TO_UNIT;
  const size = Math.ceil(Math.max(w, d) * GRID_SIZE_MULTIPLIER);

  return (
    <group>
      {/* Floor slab — clicking deselects */}
      <mesh position={[w / 2, -0.05, d / 2]} receiveShadow onClick={() => selectFurniture(null)}>
        <boxGeometry args={[w, 0.1, d]} />
        <meshStandardMaterial color={store.floorColor || '#1e2230'} />
      </mesh>

      {/* Fine grid: 10 cm cells, 1 m sections */}
      <Grid
        position={[w / 2, 0.005, d / 2]}
        args={[size, size]}
        cellSize={SNAP_UNIT}
        cellThickness={0.4}
        cellColor="#1e2d3d"
        sectionSize={1.0}
        sectionThickness={0.9}
        sectionColor="#2a4a6a"
        fadeDistance={Math.max(w, d) * GRID_FADE_MULTIPLIER}
        fadeStrength={1.2}
        infiniteGrid={false}
      />
    </group>
  );
}

// ─── Scene Content ────────────────────────────────────────────────────────────
function SceneContent({ projectId }: { projectId: string | null }) {
  const { scene, selectedFurnitureId } = useSceneStore();
  const { activeTool } = useUIStore();

  const meshGroupsRef   = useRef<Map<string, THREE.Group>>(new Map());
  const [transformTarget, setTransformTarget] = useState<THREE.Group | null>(null);

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

  if (!scene) return null;

  const selectedFurniture = selectedFurnitureId
    ? scene.furniture.find(f => f.id === selectedFurnitureId) ?? null
    : null;

  // Show transform controls whenever furniture is selected.
  // 'select' and 'translate' both use translate mode; 'rotate' uses rotate mode.
  // 'scale' uses the custom ResizeHandles component instead.
  const hasSelection      = selectedFurniture != null && transformTarget != null;
  const showResizeHandles = hasSelection && activeTool === 'scale';
  const showTransform     = hasSelection && activeTool !== 'scale';
  const tMode: 'translate' | 'rotate' = activeTool === 'rotate' ? 'rotate' : 'translate';

  return (
    <MeshRegistryCtx.Provider value={registerGroup}>
      <ambientLight intensity={0.55} />
      <directionalLight position={[15, 25, 15]} intensity={0.9} castShadow shadow-mapSize={[2048, 2048]} />
      <pointLight position={[25, 8, 15]} intensity={0.35} color="#cce8ff" />
      <pointLight position={[0,  8, 0]}  intensity={0.2}  color="#fff8e7" />

      <StoreFloor store={scene.store} />

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

      {/*
        Orbit controls: rotation is disabled when furniture is selected so that
        dragging in the scene moves/transforms the selected object instead of
        spinning the camera.  Zoom and pan remain available at all times.
      */}
      <OrbitControls
        makeDefault
        target={[25, 0, 15]}
        enableRotate={!selectedFurnitureId}
      />
    </MeshRegistryCtx.Provider>
  );
}

// ─── SceneEditor ─────────────────────────────────────────────────────────────
function SceneEditor({ projectId }: { projectId: string | null }) {
  const { scene } = useSceneStore();

  if (!projectId) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-gray-950">
        <p className="text-gray-500 text-sm">No project selected</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
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
    </div>
  );
}

export { SceneEditor };

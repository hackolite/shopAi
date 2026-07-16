import { Suspense, useState, useRef, useEffect, useCallback, createContext, useContext, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Html, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { useSceneStore } from '../store/sceneStore';
import { useUIStore } from '../store/uiStore';
import { usePlanogramStore } from '../store/planogramStore';
import { useCatalogStore } from '../store/catalogStore';
import { cadApi } from '../api/cad';
import { CM_TO_UNIT } from '../constants';
import type { ActiveTool } from '../store/uiStore';
import type { FurnitureInstance, StoreConfig, Dimensions } from '../types/cad';

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

// ─── TransformProxy ───────────────────────────────────────────────────────────
interface TransformProxyProps {
  furniture: FurnitureInstance;
  transformTarget: THREE.Group;
  mode: 'translate' | 'rotate' | 'scale';
  projectId: string | null;
}

function TransformProxy({ furniture, transformTarget, mode, projectId }: TransformProxyProps) {
  const { updateFurniture } = useSceneStore();
  const baseDimsRef = useRef<Dimensions | null>(null);

  const handleMouseDown = useCallback(() => {
    baseDimsRef.current = { ...furniture.dimensions };
  }, [furniture.dimensions]);

  const handleMouseUp = useCallback(() => {
    const obj = transformTarget;
    if (!obj) return;

    if (mode === 'translate') {
      const W = furniture.dimensions.width  * CM_TO_UNIT;
      const H = furniture.dimensions.height * CM_TO_UNIT;
      const D = furniture.dimensions.depth  * CM_TO_UNIT;
      // Lock Y=0 so furniture stays on the floor (movement only on X/Z floor plane)
      const newPos: [number, number, number] = [
        (obj.position.x - W / 2) / CM_TO_UNIT,
        0,
        (obj.position.z - D / 2) / CM_TO_UNIT,
      ];
      // Snap Y back to floor in the 3D object too
      obj.position.y = H / 2;
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

    if (mode === 'scale' && baseDimsRef.current) {
      const s = obj.scale;
      const base = baseDimsRef.current;
      const newDims: Dimensions = {
        width:  Math.max(10, base.width  * Math.abs(s.x)),
        height: Math.max(10, base.height * Math.abs(s.y)),
        depth:  Math.max(10, base.depth  * Math.abs(s.z)),
      };
      obj.scale.set(1, 1, 1);
      const updated = { ...furniture, dimensions: newDims };
      updateFurniture(updated);
      if (projectId) cadApi.updateFurniture(projectId, furniture.id, updated).catch(console.error);
    }
  }, [furniture, transformTarget, mode, projectId, updateFurniture]);

  return (
    <TransformControls
      object={transformTarget}
      mode={mode}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    />
  );
}

// ─── Store Floor + Grid ───────────────────────────────────────────────────────
function StoreFloor({ store }: { store: StoreConfig }) {
  const { selectFurniture } = useSceneStore();
  const w  = store.dimensions.width  * CM_TO_UNIT;
  const d  = store.dimensions.depth  * CM_TO_UNIT;

  return (
    <group>
      <mesh position={[w / 2, -0.05, d / 2]} receiveShadow onClick={() => selectFurniture(null)}>
        <boxGeometry args={[w, 0.1, d]} />
        <meshStandardMaterial color={store.floorColor || '#1e2230'} />
      </mesh>
      <gridHelper
        args={[Math.ceil(Math.max(w, d) * 1.2), 60, '#263754', '#1a2a3a']}
        position={[w / 2, 0.01, d / 2]}
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

  const showTransform = activeTool !== 'select' && selectedFurniture && transformTarget;
  const tMode = (activeTool === 'scale' ? 'scale' : activeTool === 'rotate' ? 'rotate' : 'translate') as 'translate' | 'rotate' | 'scale';

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
          <OrbitControls makeDefault target={[25, 0, 15]} />
          <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
            <GizmoViewport axisColors={['#e84545', '#52b788', '#4a9eff']} />
          </GizmoHelper>
        </Suspense>
      </Canvas>
    </div>
  );
}

export { SceneEditor };

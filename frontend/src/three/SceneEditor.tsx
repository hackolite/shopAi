import { Suspense, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Html } from '@react-three/drei';
import { useSceneStore } from '../store/sceneStore';
import { CM_TO_UNIT } from '../constants';
import type { FurnitureInstance, StoreConfig } from '../types/cad';

// ─── Color map ────────────────────────────────────────────────────────────────
const FURNITURE_COLORS: Record<string, string> = {
  gondola_single: '#8a9bb5',
  gondola_double: '#6b7f99',
  end_gondola:    '#7a8fa8',
  fridge:         '#5b8db8',
  register:       '#c4905a',
  wall:           '#9b9b9b',
};

function getFurnitureColor(type: string): string {
  return FURNITURE_COLORS[type] ?? '#888888';
}

// ─── Furniture Mesh ───────────────────────────────────────────────────────────
interface FurnitureMeshProps {
  furniture: FurnitureInstance;
}

function FurnitureMesh({ furniture }: FurnitureMeshProps) {
  const [hovered, setHovered] = useState(false);
  const { selectedFurnitureId, selectFurniture } = useSceneStore();

  if (!furniture.visible) return null;

  const isSelected = selectedFurnitureId === furniture.id;
  const w = furniture.dimensions.width  * CM_TO_UNIT;
  const h = furniture.dimensions.height * CM_TO_UNIT;
  const d = furniture.dimensions.depth  * CM_TO_UNIT;
  const x = furniture.position[0] * CM_TO_UNIT;
  const y = furniture.position[1] * CM_TO_UNIT + h / 2;
  const z = furniture.position[2] * CM_TO_UNIT;
  const ry = furniture.rotation[1] * (Math.PI / 180);

  const color            = getFurnitureColor(furniture.type);
  const emissive         = isSelected ? '#4a9eff' : hovered ? '#ffffff' : '#000000';
  const emissiveIntensity = isSelected ? 0.4 : hovered ? 0.15 : 0;

  return (
    <mesh
      position={[x, y, z]}
      rotation={[0, ry, 0]}
      onClick={(e) => { e.stopPropagation(); selectFurniture(furniture.id); }}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
      onPointerOut={() => setHovered(false)}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
        roughness={0.55}
        metalness={0.25}
      />
      <Html position={[0, h / 2 + 0.25, 0]} center>
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
          }}
        >
          {furniture.name}
        </div>
      </Html>
    </mesh>
  );
}

// ─── Store Floor + Grid ───────────────────────────────────────────────────────
interface StoreFloorProps {
  store: StoreConfig;
}

function StoreFloor({ store }: StoreFloorProps) {
  const { selectFurniture } = useSceneStore();
  const w  = store.widthCm * CM_TO_UNIT;
  const d  = store.depthCm * CM_TO_UNIT;
  const cx = w / 2;
  const cz = d / 2;

  return (
    <group>
      {/* Floor */}
      <mesh
        position={[cx, -0.05, cz]}
        receiveShadow
        onClick={() => selectFurniture(null)}
      >
        <boxGeometry args={[w, 0.1, d]} />
        <meshStandardMaterial color={store.floorColor || '#1e2230'} />
      </mesh>

      {/* Grid */}
      <gridHelper
        args={[Math.ceil(Math.max(w, d) * 1.2), 60, '#263754', '#1a2a3a']}
        position={[cx, 0.01, cz]}
      />
    </group>
  );
}

// ─── Scene Content ────────────────────────────────────────────────────────────
function SceneContent() {
  const { scene } = useSceneStore();
  if (!scene) return null;

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight
        position={[15, 25, 15]}
        intensity={0.9}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <pointLight position={[25, 8, 15]} intensity={0.35} color="#cce8ff" />
      <pointLight position={[0,  8, 0]}  intensity={0.2}  color="#fff8e7" />

      <StoreFloor store={scene.store} />

      {scene.furniture.map((f) => (
        <FurnitureMesh key={f.id} furniture={f} />
      ))}
    </>
  );
}

// ─── SceneEditor ─────────────────────────────────────────────────────────────
interface SceneEditorProps {
  projectId: string | null;
}

function SceneEditor({ projectId }: SceneEditorProps) {
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

      <Canvas
        camera={{ position: [25, 15, 35], fov: 50 }}
        shadows
        style={{ width: '100%', height: '100%' }}
      >
        <color attach="background" args={['#111827']} />

        <Suspense fallback={null}>
          <SceneContent />
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

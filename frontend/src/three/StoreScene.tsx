import { Suspense, useEffect, useMemo, memo } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Environment } from '@react-three/drei';
import * as THREE from 'three';

import { VoxelInstances } from './ProductBlock';
import { StoreStructure } from './Shelf';
import type { Store, Voxel, SearchResult } from '../types';

// ─── Camera fly-to helper ─────────────────────────────────────────────────────
function CameraFlyTo({ target }: { target: THREE.Vector3 | null }) {
  const { camera, controls } = useThree();

  useEffect(() => {
    if (!target) return;
    const offset = new THREE.Vector3(target.x + 10, target.y + 8, target.z + 10);
    camera.position.lerp(offset, 0.8);
    camera.lookAt(target);
    // @ts-expect-error drei controls
    controls?.target?.copy(target);
    // @ts-expect-error drei controls
    controls?.update?.();
  }, [target, camera, controls]);

  return null;
}

// ─── Scene content ────────────────────────────────────────────────────────────
interface SceneProps {
  store: Store;
  voxels: Voxel[];
  searchResult: SearchResult | null;
  onHoverVoxel?: (voxel: Voxel | null) => void;
  flyTarget: THREE.Vector3 | null;
}

const SceneContent = memo(function SceneContent({ store, voxels, searchResult, onHoverVoxel, flyTarget }: SceneProps) {
  const highlightedIds = useMemo(
    () => new Set(searchResult?.instances.map((i) => i.instance_id) ?? []),
    [searchResult],
  );

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[store.geometry.width / 2, 20, store.geometry.depth / 2]}
        intensity={1.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <pointLight position={[10, 8, 10]} intensity={0.4} />

      {/* Store geometry */}
      <StoreStructure store={store} />

      {/* Floor grid */}
      <Grid
        position={[store.geometry.width / 2, 0, store.geometry.depth / 2]}
        args={[store.geometry.width, store.geometry.depth]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#9E9E9E"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#616161"
        fadeDistance={80}
        fadeStrength={1}
        infiniteGrid={false}
      />

      {/* Product voxels (InstancedMesh per colour group) */}
      <VoxelInstances
        voxels={voxels}
        highlightedIds={highlightedIds}
        onHover={onHoverVoxel}
      />

      <OrbitControls makeDefault enableDamping dampingFactor={0.05} />
      <CameraFlyTo target={flyTarget} />
    </>
  );
});

// ─── Public component ─────────────────────────────────────────────────────────
interface StoreSceneProps {
  store: Store | null;
  voxels: Voxel[];
  searchResult: SearchResult | null;
  onHoverVoxel?: (voxel: Voxel | null) => void;
}

const DEFAULT_CAMERA_POS: [number, number, number] = [60, 40, 60];

export const StoreScene = memo(function StoreScene({ store, voxels, searchResult, onHoverVoxel }: StoreSceneProps) {
  // Compute fly-to target from first search result instance
  const flyTarget = useMemo(() => {
    if (!searchResult || searchResult.instances.length === 0) return null;
    const [x, y, z] = searchResult.instances[0].position;
    return new THREE.Vector3(x, y, z);
  }, [searchResult]);

  return (
    <div className="w-full h-full bg-gray-900 rounded-lg overflow-hidden">
      <Canvas
        shadows
        camera={{ position: DEFAULT_CAMERA_POS, fov: 50, near: 0.1, far: 1000 }}
        gl={{ antialias: true, alpha: false }}
      >
        <color attach="background" args={['#1a1a2e']} />
        <fog attach="fog" args={['#1a1a2e', 80, 200]} />

        <Suspense fallback={null}>
          {store && (
            <SceneContent
              store={store}
              voxels={voxels}
              searchResult={searchResult}
              onHoverVoxel={onHoverVoxel}
              flyTarget={flyTarget}
            />
          )}
          <Environment preset="warehouse" />
        </Suspense>
      </Canvas>

      {!store && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-400">
          <div className="text-center space-y-2">
            <div className="text-4xl">🏪</div>
            <p className="text-lg font-medium">No store loaded</p>
            <p className="text-sm">Import a store JSON or load the demo project</p>
          </div>
        </div>
      )}
    </div>
  );
});

import { memo, useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { cadApi } from '../api/cad';
import { CM_TO_UNIT } from '../constants';
import { furnitureCentreCm } from '../engine/gridSnap';
import type { Scene } from '../types/cad';

const FLOOR_Y = -0.01;
const scenePreviewCache = new Map<string, Promise<Scene>>();

function getFurnitureColor(type: string, mounted: boolean): string {
  if (!mounted) return '#475569';
  if (type.startsWith('gondola')) return '#cbd5e1';
  if (type.startsWith('fridge')) return '#93c5fd';
  if (type === 'register') return '#fdba74';
  return '#a78bfa';
}

function CameraTarget({ target, position }: { target: THREE.Vector3; position: [number, number, number] }) {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(...position);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }, [camera, position, target]);

  return null;
}

function PreviewScene({ scene }: { scene: Scene }) {
  const storeOriginX = (scene.store.position?.[0] ?? 0) * CM_TO_UNIT;
  const storeOriginZ = (scene.store.position?.[2] ?? 0) * CM_TO_UNIT;
  const storeWidth = scene.store.dimensions.width * CM_TO_UNIT;
  const storeDepth = scene.store.dimensions.depth * CM_TO_UNIT;
  const storeHeight = scene.store.dimensions.height * CM_TO_UNIT;
  const maxSpan = Math.max(storeWidth, storeDepth, 1);
  const storeOutlineGeometry = useMemo(() => new THREE.BoxGeometry(storeWidth, 0.02, storeDepth), [storeDepth, storeWidth]);
  const target = useMemo(
    () => new THREE.Vector3(storeOriginX + storeWidth / 2, 0, storeOriginZ + storeDepth / 2),
    [storeDepth, storeOriginX, storeOriginZ, storeWidth],
  );
  const cameraPosition = useMemo<[number, number, number]>(
    () => [
      target.x + maxSpan * 0.85,
      Math.max(storeHeight * 1.4, maxSpan * 0.95, 3.2),
      target.z + maxSpan * 0.8,
    ],
    [maxSpan, storeHeight, target.x, target.z],
  );

  return (
    <>
      <color attach="background" args={['#0f172a']} />
      <ambientLight intensity={0.85} />
      <directionalLight position={[target.x + 4, 8, target.z + 4]} intensity={1.1} castShadow={false} />
      <CameraTarget target={target} position={cameraPosition} />

      <mesh position={[storeOriginX + storeWidth / 2, FLOOR_Y, storeOriginZ + storeDepth / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[storeWidth, storeDepth]} />
        <meshStandardMaterial color={scene.store.floorColor || '#d1d5db'} roughness={0.95} />
      </mesh>

      <lineSegments position={[storeOriginX + storeWidth / 2, 0.001, storeOriginZ + storeDepth / 2]}>
        <edgesGeometry args={[storeOutlineGeometry]} />
        <lineBasicMaterial color="#60a5fa" />
      </lineSegments>

      {scene.furniture.map((furniture) => {
        const mounted = furniture.mounted !== false;
        const center = furnitureCentreCm(furniture.position, furniture.dimensions);
        const width = furniture.dimensions.width * CM_TO_UNIT;
        const depth = furniture.dimensions.depth * CM_TO_UNIT;
        const height = furniture.dimensions.height * CM_TO_UNIT;
        const y = mounted ? height / 2 : 0.03;
        const renderedHeight = mounted ? height : 0.06;
        return (
          <mesh
            key={furniture.id}
            position={[storeOriginX + center.x * CM_TO_UNIT, y, storeOriginZ + center.z * CM_TO_UNIT]}
            rotation={[0, (furniture.rotation[1] ?? 0) * Math.PI / 180, 0]}
          >
            <boxGeometry args={[width, renderedHeight, depth]} />
            <meshStandardMaterial color={getFurnitureColor(furniture.type, mounted)} roughness={0.8} metalness={0.08} />
          </mesh>
        );
      })}
    </>
  );
}

export default memo(function ProjectSceneThumbnail({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [scene, setScene] = useState<Scene | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setScene(null);
    const request = scenePreviewCache.get(projectId) ?? cadApi.getScene(projectId);
    scenePreviewCache.set(projectId, request);
    void request
      .then((nextScene) => {
        if (cancelled) return;
        setScene(nextScene);
        setStatus('ready');
      })
      .catch(() => {
        scenePreviewCache.delete(projectId);
        if (cancelled) return;
        setStatus('error');
      });
    return () => { cancelled = true; };
  }, [projectId]);

  return (
    <div className="hub-project-thumbnail" aria-label={`Aperçu 3D du projet ${projectName}`}>
      {status === 'ready' && scene ? (
        <Canvas
          camera={{ position: [4, 4, 4], fov: 34, near: 0.1, far: 200 }}
          gl={{ antialias: true }}
        >
          <PreviewScene scene={scene} />
        </Canvas>
      ) : (
        <div className="hub-project-thumbnail-fallback">
          <span aria-hidden="true">{status === 'error' ? '⚠' : '◌'}</span>
          <p>{status === 'error' ? 'Aperçu indisponible' : 'Chargement de l’aperçu 3D…'}</p>
        </div>
      )}
    </div>
  );
});

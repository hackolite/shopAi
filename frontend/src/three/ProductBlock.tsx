import { useRef, useEffect, useCallback, useState, useMemo, memo } from 'react';
import * as THREE from 'three';
import type { Voxel } from '../types';

const SCALE = 0.97; // slight gap between adjacent voxels

// Shared geometry & scratch objects (allocated once)
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

// ─── One InstancedMesh per colour group ──────────────────────────────────────
interface ColorGroupProps {
  baseColor: string;
  voxels: Voxel[];
  highlightedIds: Set<string>;
  hoveredInstanceId: number | null;
  onPointerEnter: (iid: number, color: string) => void;
  onPointerLeave: () => void;
  onVoxelHover: (voxel: Voxel | null) => void;
}

const ColorGroup = memo(function ColorGroup({
  baseColor,
  voxels,
  highlightedIds,
  hoveredInstanceId,
  onPointerEnter,
  onPointerLeave,
  onVoxelHover,
}: ColorGroupProps) {
  const ref = useRef<THREE.InstancedMesh>(null!);

  // Update matrices (only when voxels array changes)
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    for (let i = 0; i < voxels.length; i++) {
      const v = voxels[i];
      const [px, py, pz] = v.position;
      const [sx, sy, sz] = v.size;
      _dummy.position.set(px + sx / 2, py + sy / 2, pz + sz / 2);
      _dummy.scale.set(sx * SCALE, sy * SCALE, sz * SCALE);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [voxels]);

  // Update colours whenever highlight/hover state changes
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    for (let i = 0; i < voxels.length; i++) {
      const v = voxels[i];
      if (highlightedIds.has(v.instance_id)) {
        _color.set('#FFD700');
      } else if (i === hoveredInstanceId) {
        _color.set('#FFE082');
      } else {
        _color.set(baseColor);
      }
      mesh.setColorAt(i, _color);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [voxels, highlightedIds, hoveredInstanceId, baseColor]);

  const handlePointerOver = useCallback(
    (e: { stopPropagation: () => void; instanceId?: number }) => {
      e.stopPropagation();
      if (e.instanceId !== undefined) {
        onPointerEnter(e.instanceId, baseColor);
        onVoxelHover(voxels[e.instanceId] ?? null);
        document.body.style.cursor = 'pointer';
      }
    },
    [baseColor, voxels, onPointerEnter, onVoxelHover],
  );

  const handlePointerOut = useCallback(() => {
    onPointerLeave();
    onVoxelHover(null);
    document.body.style.cursor = 'auto';
  }, [onPointerLeave, onVoxelHover]);

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, voxels.length]}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial vertexColors roughness={0.7} metalness={0.1} />
    </instancedMesh>
  );
});

// ─── Public component ─────────────────────────────────────────────────────────
interface VoxelInstancesProps {
  voxels: Voxel[];
  highlightedIds: Set<string>;
  onHover?: (voxel: Voxel | null) => void;
}

/** Renders all voxels as a set of InstancedMeshes (one per category colour). */
export const VoxelInstances = memo(function VoxelInstances({
  voxels,
  highlightedIds,
  onHover,
}: VoxelInstancesProps) {
  const [hoverState, setHoverState] = useState<{ color: string; iid: number } | null>(null);

  // Group voxels by base colour — rebuilt only when the voxels list changes
  const groupMap = useMemo(() => {
    const map = new Map<string, Voxel[]>();
    for (const v of voxels) {
      const arr = map.get(v.color) ?? [];
      arr.push(v);
      map.set(v.color, arr);
    }
    return map;
  }, [voxels]);

  const handleEnter = useCallback((iid: number, color: string) => {
    setHoverState({ iid, color });
  }, []);

  const handleLeave = useCallback(() => {
    setHoverState(null);
  }, []);

  const handleVoxelHover = useCallback(
    (v: Voxel | null) => onHover?.(v),
    [onHover],
  );

  return (
    <>
      {[...groupMap.entries()].map(([color, group]) => (
        <ColorGroup
          key={color}
          baseColor={color}
          voxels={group}
          highlightedIds={highlightedIds}
          hoveredInstanceId={hoverState?.color === color ? hoverState.iid : null}
          onPointerEnter={handleEnter}
          onPointerLeave={handleLeave}
          onVoxelHover={handleVoxelHover}
        />
      ))}
    </>
  );
});

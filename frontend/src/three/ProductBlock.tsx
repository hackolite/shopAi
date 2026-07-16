import { useRef, useEffect, useCallback, useState, useMemo, memo } from 'react';
import * as THREE from 'three';
import type { Voxel } from '../types';

const SCALE           = 0.95;  // gap between adjacent voxels
const CAP_HEIGHT      = 0.018; // 18 mm top-cap slab
const CAP_SCALE       = 0.97;  // cap slightly narrower than body to avoid z-fighting
const CAP_LIGHTNESS   = 0.55;  // how much to lerp cap colour toward white

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
  onVoxelClick: (voxel: Voxel) => void;
}

const ColorGroup = memo(function ColorGroup({
  baseColor,
  voxels,
  highlightedIds,
  hoveredInstanceId,
  onPointerEnter,
  onPointerLeave,
  onVoxelHover,
  onVoxelClick,
}: ColorGroupProps) {
  const bodyRef = useRef<THREE.InstancedMesh>(null!);
  const capRef  = useRef<THREE.InstancedMesh>(null!);

  // Lighter cap colour (top face of each product box)
  const capColor = useMemo(() => {
    const c = new THREE.Color(baseColor);
    c.lerp(new THREE.Color('#ffffff'), CAP_LIGHTNESS);
    return '#' + c.getHexString();
  }, [baseColor]);

  // Update matrices for body + top cap (only when voxel list changes)
  useEffect(() => {
    const body = bodyRef.current;
    const cap  = capRef.current;
    if (!body || !cap) return;
    for (let i = 0; i < voxels.length; i++) {
      const v = voxels[i];
      const [px, py, pz] = v.position;
      const [sx, sy, sz] = v.size;

      // Body
      _dummy.position.set(px + sx / 2, py + sy / 2, pz + sz / 2);
      _dummy.scale.set(sx * SCALE, sy * SCALE, sz * SCALE);
      _dummy.updateMatrix();
      body.setMatrixAt(i, _dummy.matrix);

      // Top cap — thin slab sitting exactly on top of the body
      const bodyTop = py + sy / 2 + (sy * SCALE) / 2;
      _dummy.position.set(px + sx / 2, bodyTop + CAP_HEIGHT / 2, pz + sz / 2);
      _dummy.scale.set(sx * SCALE * CAP_SCALE, CAP_HEIGHT, sz * SCALE * CAP_SCALE);
      _dummy.updateMatrix();
      cap.setMatrixAt(i, _dummy.matrix);
    }
    body.instanceMatrix.needsUpdate = true;
    cap.instanceMatrix.needsUpdate  = true;
  }, [voxels]);

  // Update body colours whenever highlight/hover state changes
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    for (let i = 0; i < voxels.length; i++) {
      const v = voxels[i];
      if (highlightedIds.has(v.instance_id)) {
        _color.set('#FFD700');
      } else if (i === hoveredInstanceId) {
        _color.set('#FFE082');
      } else {
        _color.set(baseColor);
      }
      body.setColorAt(i, _color);
    }
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
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

  const handleClick = useCallback(
    (e: { stopPropagation: () => void; instanceId?: number }) => {
      e.stopPropagation();
      if (e.instanceId !== undefined) {
        const voxel = voxels[e.instanceId];
        if (voxel) onVoxelClick(voxel);
      }
    },
    [voxels, onVoxelClick],
  );

  return (
    <group>
      {/* Product body */}
      <instancedMesh
        ref={bodyRef}
        args={[undefined, undefined, voxels.length]}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial vertexColors roughness={0.45} metalness={0.08} />
      </instancedMesh>

      {/* Top cap — lighter shade, gives a retail-box appearance */}
      <instancedMesh
        ref={capRef}
        args={[undefined, undefined, voxels.length]}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={capColor} roughness={0.25} metalness={0.05} />
      </instancedMesh>
    </group>
  );
});

// ─── Public component ─────────────────────────────────────────────────────────
interface VoxelInstancesProps {
  voxels: Voxel[];
  highlightedIds: Set<string>;
  onHover?: (voxel: Voxel | null) => void;
  onClickVoxel?: (voxel: Voxel) => void;
}

/** Renders all voxels as a set of InstancedMeshes (one per category colour). */
export const VoxelInstances = memo(function VoxelInstances({
  voxels,
  highlightedIds,
  onHover,
  onClickVoxel,
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

  const handleVoxelClick = useCallback(
    (v: Voxel) => onClickVoxel?.(v),
    [onClickVoxel],
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
          onVoxelClick={handleVoxelClick}
        />
      ))}
    </>
  );
});

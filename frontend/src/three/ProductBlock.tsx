import { useRef, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { Voxel } from '../types';

interface ProductBlockProps {
  voxel: Voxel;
  isHighlighted: boolean;
  onHover?: (voxel: Voxel | null) => void;
}

export function ProductBlock({ voxel, isHighlighted, onHover }: ProductBlockProps) {
  const [hovered, setHovered] = useState(false);
  const meshRef = useRef(null);

  const [px, py, pz] = voxel.position;
  const [sw, sh, sd] = voxel.size;

  // Centre the mesh at its position: box geometry is centred, so offset by half-sizes
  const posX = px + sw / 2;
  const posY = py + sh / 2;
  const posZ = pz + sd / 2;

  const baseColor = voxel.color;
  const highlightColor = '#FFFFFF';
  const hoverColor = '#FFE082';

  let color = baseColor;
  if (isHighlighted) color = highlightColor;
  else if (hovered) color = hoverColor;

  const emissive = isHighlighted ? '#FFD700' : hovered ? '#FFA000' : '#000000';
  const emissiveIntensity = isHighlighted ? 0.6 : hovered ? 0.3 : 0;

  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(true);
    onHover?.(voxel);
    document.body.style.cursor = 'pointer';
  };

  const handlePointerOut = () => {
    setHovered(false);
    onHover?.(null);
    document.body.style.cursor = 'auto';
  };

  return (
    <mesh
      ref={meshRef}
      position={[posX, posY, posZ]}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    >
      <boxGeometry args={[sw * 0.92, sh * 0.92, sd * 0.92]} />
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
        roughness={0.7}
        metalness={0.1}
      />
    </mesh>
  );
}

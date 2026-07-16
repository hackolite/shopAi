import type { Store } from '../types';

interface StoreStructureProps {
  store: Store;
}

// 1 unit = 10 cm → store 50m × 30m = 500 units × 300 units
// We scale store.json metres → Three.js units directly (store width=50 → 50 units)
const WALL_HEIGHT = 4;
const WALL_THICKNESS = 0.3;

export function StoreStructure({ store }: StoreStructureProps) {
  const W = store.geometry.width;
  const D = store.geometry.depth;
  const H = WALL_HEIGHT;

  const floorColor = '#D0D0D0';
  const wallColor = '#B0B8C1';
  const ceilingColor = '#E8E8E8';

  return (
    <group>
      {/* Floor */}
      <mesh position={[W / 2, -0.05, D / 2]} receiveShadow>
        <boxGeometry args={[W, 0.1, D]} />
        <meshStandardMaterial color={floorColor} roughness={0.9} />
      </mesh>

      {/* Ceiling (semi-transparent) */}
      <mesh position={[W / 2, H + 0.05, D / 2]}>
        <boxGeometry args={[W, 0.1, D]} />
        <meshStandardMaterial color={ceilingColor} transparent opacity={0.15} />
      </mesh>

      {/* Front wall */}
      <mesh position={[W / 2, H / 2, -WALL_THICKNESS / 2]}>
        <boxGeometry args={[W, H, WALL_THICKNESS]} />
        <meshStandardMaterial color={wallColor} roughness={0.85} />
      </mesh>

      {/* Back wall */}
      <mesh position={[W / 2, H / 2, D + WALL_THICKNESS / 2]}>
        <boxGeometry args={[W, H, WALL_THICKNESS]} />
        <meshStandardMaterial color={wallColor} roughness={0.85} />
      </mesh>

      {/* Left wall */}
      <mesh position={[-WALL_THICKNESS / 2, H / 2, D / 2]}>
        <boxGeometry args={[WALL_THICKNESS, H, D]} />
        <meshStandardMaterial color={wallColor} roughness={0.85} />
      </mesh>

      {/* Right wall */}
      <mesh position={[W + WALL_THICKNESS / 2, H / 2, D / 2]}>
        <boxGeometry args={[WALL_THICKNESS, H, D]} />
        <meshStandardMaterial color={wallColor} roughness={0.85} />
      </mesh>

      {/* Aisle shelf structures */}
      {store.aisles?.map((aisle) => (
        <ShelfUnit
          key={aisle.id}
          x={aisle.x_start}
          xEnd={aisle.x_end}
          zStart={aisle.z_start}
          zEnd={aisle.z_end}
          zone={aisle.zone}
        />
      ))}
    </group>
  );
}

const ZONE_SHELF_COLORS: Record<string, string> = {
  epicerie:  '#8D6E63',
  boisson:   '#78909C',
  frais:     '#546E7A',
  hygiene:   '#6D4C41',
  promotion: '#BF360C',
  default:   '#795548',
};

function ShelfUnit({
  x,
  xEnd,
  zStart,
  zEnd,
  zone,
}: {
  x: number;
  xEnd: number;
  zStart: number;
  zEnd: number;
  zone: string;
}) {
  const shelfColor = ZONE_SHELF_COLORS[zone] ?? ZONE_SHELF_COLORS.default;
  const width = xEnd - x;
  const depth = zEnd - zStart;
  const cx = x + width / 2;
  const cz = zStart + depth / 2;

  // Draw shelf uprights + horizontal shelves
  const levels = [0.8, 1.6, 2.4, 3.2];

  return (
    <group>
      {/* Back panel */}
      <mesh position={[cx, 1.5, cz]}>
        <boxGeometry args={[width, 3, 0.05]} />
        <meshStandardMaterial color={shelfColor} roughness={0.9} />
      </mesh>

      {/* Horizontal shelves */}
      {levels.map((y) => (
        <mesh key={y} position={[cx, y, cz]}>
          <boxGeometry args={[width, 0.04, 0.5]} />
          <meshStandardMaterial color={shelfColor} roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

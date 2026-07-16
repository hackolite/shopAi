import type { Store } from '../types';

interface StoreStructureProps {
  store: Store;
}

// ── Store geometry constants (1 unit = 1 metre) ───────────────────────────────
const WALL_HEIGHT     = 4;      // used for ceiling height

// ── Gondola constants (realistic supermarket shelving) ────────────────────────
const GONDOLA_HEIGHT  = 2.0;    // 2 m total gondola height
const SHELF_DEPTH     = 0.45;   // 45 cm usable shelf depth per face
const BACK_THICKNESS  = 0.025;  // 25 mm back panel
const BOARD_THICKNESS = 0.025;  // 25 mm shelf board
/** Y positions of shelf board TOPS = product bases (5 levels, 40 cm apart) */
const SHELF_LEVELS    = [0.03, 0.43, 0.83, 1.23, 1.63] as const;

export function StoreStructure({ store }: StoreStructureProps) {
  const W = store.geometry.width;
  const D = store.geometry.depth;
  const H = WALL_HEIGHT;

  const floorColor   = '#D0D0D0';
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

      {/* Aisle gondola structures */}
      {store.aisles?.map((aisle) => (
        <GondolaUnit
          key={aisle.id}
          xStart={aisle.x_start}
          xEnd={aisle.x_end}
          zStart={aisle.z_start}
          zEnd={aisle.z_end}
          zone={aisle.zone}
        />
      ))}
    </group>
  );
}

// ── Zone colours ──────────────────────────────────────────────────────────────
const ZONE_COLORS: Record<string, string> = {
  epicerie:  '#8D6E63',
  boisson:   '#78909C',
  frais:     '#546E7A',
  hygiene:   '#6D4C41',
  promotion: '#BF360C',
  default:   '#795548',
};

// ── One gondola unit (runs the full Z length of an aisle) ─────────────────────
function GondolaUnit({
  xStart,
  xEnd,
  zStart,
  zEnd,
  zone,
}: {
  xStart: number;
  xEnd: number;
  zStart: number;
  zEnd: number;
  zone: string;
}) {
  const color  = ZONE_COLORS[zone] ?? ZONE_COLORS.default;
  const length = zEnd - zStart;           // gondola length in Z direction
  const cz     = zStart + length / 2;    // centre Z

  // We render two gondola faces: one at xStart (left face) and one at xEnd (right face).
  // Products in the demo are placed at xStart; the xEnd face shows an empty back panel.
  return (
    <group>
      <GondolaFace x={xStart} dirX={+1} cz={cz} length={length} color={color} />
      <GondolaFace x={xEnd}   dirX={-1} cz={cz} length={length} color={color} />
    </group>
  );
}

/**
 * One face of a gondola shelving unit.
 *
 * @param x      – X position of the gondola face (back panel X)
 * @param dirX   – +1 = shelves extend in +X (left face), -1 = extend in -X (right face)
 * @param cz     – centre Z of the gondola run
 * @param length – total Z length
 * @param color  – shelf colour
 */
function GondolaFace({
  x,
  dirX,
  cz,
  length,
  color,
}: {
  x: number;
  dirX: 1 | -1;
  cz: number;
  length: number;
  color: string;
}) {
  const mat = <meshStandardMaterial color={color} roughness={0.9} />;

  // Back panel centre X (panel sits just inside the face, shelves extend outward)
  const panelCx = x + dirX * (BACK_THICKNESS / 2);
  // Shelf board centre X (centred over the usable depth)
  const boardCx = x + dirX * (BACK_THICKNESS + SHELF_DEPTH / 2);
  // Top valance centre X
  const valCx   = x + dirX * (BACK_THICKNESS + SHELF_DEPTH / 2);

  return (
    <group>
      {/* ── Back panel (full height, full length) ── */}
      <mesh position={[panelCx, GONDOLA_HEIGHT / 2, cz]}>
        <boxGeometry args={[BACK_THICKNESS, GONDOLA_HEIGHT, length]} />
        {mat}
      </mesh>

      {/* ── Horizontal shelf boards ── */}
      {SHELF_LEVELS.map((levelY) => (
        <mesh key={levelY} position={[boardCx, levelY - BOARD_THICKNESS / 2, cz]}>
          <boxGeometry args={[SHELF_DEPTH, BOARD_THICKNESS, length]} />
          {mat}
        </mesh>
      ))}

      {/* ── Top valance / cap ── */}
      <mesh position={[valCx, GONDOLA_HEIGHT - BOARD_THICKNESS / 2, cz]}>
        <boxGeometry args={[SHELF_DEPTH, BOARD_THICKNESS, length]} />
        {mat}
      </mesh>

      {/* ── End caps (upright panels at each end of the run) ── */}
      <EndCap x={x} zFace={cz - length / 2} dirX={dirX} color={color} />
      <EndCap x={x} zFace={cz + length / 2} dirX={dirX} color={color} />
    </group>
  );
}

function EndCap({
  x,
  zFace,
  dirX,
  color,
}: {
  x: number;
  zFace: number;
  dirX: 1 | -1;
  color: string;
}) {
  const panelW = BACK_THICKNESS + SHELF_DEPTH;
  const cx     = x + dirX * (panelW / 2);

  return (
    <mesh position={[cx, GONDOLA_HEIGHT / 2, zFace]}>
      <boxGeometry args={[panelW, GONDOLA_HEIGHT, BACK_THICKNESS]} />
      <meshStandardMaterial color={color} roughness={0.9} />
    </mesh>
  );
}


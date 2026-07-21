import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useSceneStore } from '../../store/sceneStore';
import { useZoneStore } from '../../store/zoneStore';
import { cadApi } from '../../api/cad';
import type { FurnitureInstance } from '../../types/cad';
import type { FloorZone } from '../../types/cad';

// ─── Constants ────────────────────────────────────────────────────────────────

const SNAP_CM = 100;
const MIN_DIM_CM = 20;

function snapToCm(v: number) {
  return Math.round(v / SNAP_CM) * SNAP_CM;
}
function snapDim(v: number) {
  return Math.max(MIN_DIM_CM, Math.round(v / SNAP_CM) * SNAP_CM);
}

// ─── Color map per furniture type ─────────────────────────────────────────────

const FURNITURE_FILL: Record<string, string> = {
  gondola_single:    '#3B82F6',  // blue
  gondola_double:    '#8B5CF6',  // violet
  fridge:            '#06B6D4',  // cyan
  fridge_horizontal: '#0EA5E9',  // sky
  pallet:            '#F59E0B',  // amber
  display:           '#EC4899',  // pink
  register:          '#10B981',  // emerald
  wall:              '#6B7280',  // gray
  partition:         '#9CA3AF',  // light gray
};

function getFurnitureColor(type: string) {
  return FURNITURE_FILL[type] ?? '#64748B';
}

const ZONE_FILL: Record<string, string> = {
  entrance: '#22C55E',
  exit:     '#F97316',
};

// ─── Types ────────────────────────────────────────────────────────────────────

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type DragState =
  | {
      kind: 'move';
      furnitureId: string;
      startSvgX: number;
      startSvgY: number;
      origX: number;
      origZ: number;
    }
  | {
      kind: 'resize';
      furnitureId: string;
      handle: Handle;
      startSvgX: number;
      startSvgY: number;
      origX: number;
      origZ: number;
      origW: number;
      origD: number;
    }
  | {
      kind: 'zone-move';
      zoneId: string;
      startSvgX: number;
      startSvgY: number;
      origX: number;
      origZ: number;
    }
  | {
      kind: 'zone-resize';
      zoneId: string;
      handle: Handle;
      startSvgX: number;
      startSvgY: number;
      origX: number;
      origZ: number;
      origW: number;
      origD: number;
    };

// ─── Helper: convert client pointer event → SVG user-space coords ─────────────

function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const svgPt = pt.matrixTransform(ctm.inverse());
  return { x: svgPt.x, y: svgPt.y };
}

// ─── Resize handle positions ──────────────────────────────────────────────────

function handlePos(handle: Handle, x: number, y: number, w: number, h: number) {
  const positions: Record<Handle, [number, number]> = {
    nw: [x, y], n: [x + w / 2, y], ne: [x + w, y],
    e: [x + w, y + h / 2],
    se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h],
    w: [x, y + h / 2],
  };
  return positions[handle];
}

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize',
  se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize',
};

// ─── FurnitureRect ────────────────────────────────────────────────────────────

interface FurnitureRectProps {
  furniture: FurnitureInstance;
  isSelected: boolean;
  onSelect: () => void;
  onMoveStart: (e: React.PointerEvent, furniture: FurnitureInstance) => void;
  onResizeStart: (e: React.PointerEvent, furniture: FurnitureInstance, handle: Handle) => void;
}

function FurnitureRect({ furniture, isSelected, onSelect, onMoveStart, onResizeStart }: FurnitureRectProps) {
  const x = furniture.position[0];
  const y = furniture.position[2];
  const w = furniture.dimensions.width;
  const h = furniture.dimensions.depth;
  const color = getFurnitureColor(furniture.type);
  const isMounted = furniture.mounted !== false;

  // Compute an appropriate font size — small enough to fit inside even narrow rects
  const fontSize = Math.min(h * 0.18, w * 0.15, 20);
  const labelY = y + h / 2;

  return (
    <g>
      {/* Shadow/highlight rect for selection */}
      {isSelected && (
        <rect
          x={x - 3} y={y - 3}
          width={w + 6} height={h + 6}
          rx={3} fill="none"
          stroke="#60A5FA" strokeWidth={3}
          strokeDasharray="6 3"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Main rect */}
      <rect
        x={x} y={y}
        width={w} height={h}
        rx={2}
        fill={color + (isMounted ? 'CC' : '66')}
        stroke={isSelected ? '#3B82F6' : color}
        strokeWidth={isSelected ? 2 : 1}
        style={{ cursor: 'move' }}
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        onPointerDown={(e) => { e.stopPropagation(); onMoveStart(e, furniture); }}
      />

      {/* "À plat" indicator diagonal hatch for unmounted */}
      {!isMounted && (
        <rect
          x={x} y={y} width={w} height={h} rx={2}
          fill="url(#hatch)"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Label */}
      {w > 30 && h > 15 && (
        <>
          <text
            x={x + w / 2} y={labelY - fontSize * 0.3}
            textAnchor="middle"
            fontSize={fontSize}
            fill="white"
            fontWeight="600"
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            {furniture.name}
          </text>
          <text
            x={x + w / 2} y={labelY + fontSize * 0.9}
            textAnchor="middle"
            fontSize={fontSize * 0.7}
            fill="white"
            opacity={0.8}
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            {isMounted ? '3D' : '▭ plat'}
          </text>
        </>
      )}

      {/* Resize handles (only when selected) */}
      {isSelected && HANDLES.map((handleKey) => {
        const [hx, hy] = handlePos(handleKey, x, y, w, h);
        return (
          <circle
            key={handleKey}
            cx={hx} cy={hy} r={Math.min(5, Math.max(2, w * 0.04))}
            fill="white" stroke="#3B82F6" strokeWidth={1.5}
            style={{ cursor: HANDLE_CURSOR[handleKey] }}
            onPointerDown={(e) => { e.stopPropagation(); onResizeStart(e, furniture, handleKey); }}
          />
        );
      })}
    </g>
  );
}

// ─── ZoneRect ─────────────────────────────────────────────────────────────────

interface ZoneRectProps {
  zone: FloorZone;
  isSelected: boolean;
  onSelect: () => void;
  onMoveStart: (e: React.PointerEvent, zone: FloorZone) => void;
  onResizeStart: (e: React.PointerEvent, zone: FloorZone, handle: Handle) => void;
}

function ZoneRect({ zone, isSelected, onSelect, onMoveStart, onResizeStart }: ZoneRectProps) {
  const fill = ZONE_FILL[zone.type] ?? '#64748B';
  const labelFontSize = Math.min(zone.depth * 0.25, zone.width * 0.15, 18);

  return (
    <g>
      {isSelected && (
        <rect
          x={zone.x - 3} y={zone.z - 3}
          width={zone.width + 6} height={zone.depth + 6}
          rx={3} fill="none"
          stroke="#FDE68A" strokeWidth={3}
          strokeDasharray="6 3"
          style={{ pointerEvents: 'none' }}
        />
      )}
      <rect
        x={zone.x} y={zone.z}
        width={zone.width} height={zone.depth}
        rx={2}
        fill={fill + '55'}
        stroke={fill}
        strokeWidth={isSelected ? 2 : 1.5}
        style={{ cursor: 'move' }}
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        onPointerDown={(e) => { e.stopPropagation(); onMoveStart(e, zone); }}
      />
      {zone.width > 30 && zone.depth > 12 && (
        <text
          x={zone.x + zone.width / 2}
          y={zone.z + zone.depth / 2 + labelFontSize * 0.35}
          textAnchor="middle"
          fontSize={labelFontSize}
          fill={fill}
          fontWeight="700"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {zone.label}
        </text>
      )}
      {isSelected && HANDLES.map((handleKey) => {
        const [hx, hy] = handlePos(handleKey, zone.x, zone.z, zone.width, zone.depth);
        return (
          <circle
            key={handleKey}
            cx={hx} cy={hy} r={Math.min(5, Math.max(2, zone.width * 0.04))}
            fill="white" stroke={fill} strokeWidth={1.5}
            style={{ cursor: HANDLE_CURSOR[handleKey] }}
            onPointerDown={(e) => { e.stopPropagation(); onResizeStart(e, zone, handleKey); }}
          />
        );
      })}
    </g>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface FloorPlanEditorProps {
  projectId: string | null;
}

export default function FloorPlanEditor({ projectId }: FloorPlanEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { scene, selectedFurnitureId, selectFurniture, updateFurniture } = useSceneStore();
  const { zones, selectedZoneId, selectZone, updateZone } = useZoneStore();

  const [drag, setDrag] = useState<DragState | null>(null);
  // Live preview positions during drag (avoids re-renders via store for each mousemove)
  const [livePos, setLivePos] = useState<{ x: number; z: number; w?: number; d?: number } | null>(null);

  const storeW = scene?.store.dimensions.width  ?? 2000;
  const storeD = scene?.store.dimensions.depth  ?? 1500;

  // ── Drag start helpers ────────────────────────────────────────────────────

  const handleFurnitureMoveStart = useCallback((e: React.PointerEvent, f: FurnitureInstance) => {
    if (!svgRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = clientToSvg(svgRef.current, e.clientX, e.clientY);
    selectFurniture(f.id);
    setDrag({ kind: 'move', furnitureId: f.id, startSvgX: x, startSvgY: y, origX: f.position[0], origZ: f.position[2] });
    setLivePos({ x: f.position[0], z: f.position[2] });
  }, [selectFurniture]);

  const handleFurnitureResizeStart = useCallback((e: React.PointerEvent, f: FurnitureInstance, handle: Handle) => {
    if (!svgRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = clientToSvg(svgRef.current, e.clientX, e.clientY);
    setDrag({ kind: 'resize', furnitureId: f.id, handle, startSvgX: x, startSvgY: y, origX: f.position[0], origZ: f.position[2], origW: f.dimensions.width, origD: f.dimensions.depth });
    setLivePos({ x: f.position[0], z: f.position[2], w: f.dimensions.width, d: f.dimensions.depth });
  }, []);

  const handleZoneMoveStart = useCallback((e: React.PointerEvent, zone: FloorZone) => {
    if (!svgRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = clientToSvg(svgRef.current, e.clientX, e.clientY);
    selectZone(zone.id);
    setDrag({ kind: 'zone-move', zoneId: zone.id, startSvgX: x, startSvgY: y, origX: zone.x, origZ: zone.z });
    setLivePos({ x: zone.x, z: zone.z });
  }, [selectZone]);

  const handleZoneResizeStart = useCallback((e: React.PointerEvent, zone: FloorZone, handle: Handle) => {
    if (!svgRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = clientToSvg(svgRef.current, e.clientX, e.clientY);
    setDrag({ kind: 'zone-resize', zoneId: zone.id, handle, startSvgX: x, startSvgY: y, origX: zone.x, origZ: zone.z, origW: zone.width, origD: zone.depth });
    setLivePos({ x: zone.x, z: zone.z, w: zone.width, d: zone.depth });
  }, []);

  // ── Pointer move/up on SVG ────────────────────────────────────────────────

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || !svgRef.current) return;
    const { x: svgX, y: svgY } = clientToSvg(svgRef.current, e.clientX, e.clientY);
    const dx = svgX - drag.startSvgX;
    const dy = svgY - drag.startSvgY;

    if (drag.kind === 'move') {
      setLivePos({ x: snapToCm(drag.origX + dx), z: snapToCm(drag.origZ + dy) });
    } else if (drag.kind === 'zone-move') {
      setLivePos({ x: snapToCm(drag.origX + dx), z: snapToCm(drag.origZ + dy) });
    } else if (drag.kind === 'resize') {
      const { handle, origX, origZ, origW, origD } = drag;
      let nx = origX, nz = origZ, nw = origW, nd = origD;
      if (handle.includes('e')) { nw = snapDim(origW + dx); }
      if (handle.includes('w')) { nw = snapDim(origW - dx); nx = snapToCm(origX + origW - nw); }
      if (handle.includes('s')) { nd = snapDim(origD + dy); }
      if (handle.includes('n')) { nd = snapDim(origD - dy); nz = snapToCm(origZ + origD - nd); }
      setLivePos({ x: nx, z: nz, w: nw, d: nd });
    } else if (drag.kind === 'zone-resize') {
      const { handle, origX, origZ, origW, origD } = drag;
      let nx = origX, nz = origZ, nw = origW, nd = origD;
      if (handle.includes('e')) { nw = snapDim(origW + dx); }
      if (handle.includes('w')) { nw = snapDim(origW - dx); nx = snapToCm(origX + origW - nw); }
      if (handle.includes('s')) { nd = snapDim(origD + dy); }
      if (handle.includes('n')) { nd = snapDim(origD - dy); nz = snapToCm(origZ + origD - nd); }
      setLivePos({ x: nx, z: nz, w: nw, d: nd });
    }
  }, [drag]);

  const handlePointerUp = useCallback((_e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || !livePos || !scene) { setDrag(null); setLivePos(null); return; }

    if (drag.kind === 'move') {
      const f = scene.furniture.find((fi) => fi.id === drag.furnitureId);
      if (f) {
        const updated: FurnitureInstance = { ...f, position: [livePos.x, f.position[1], livePos.z] };
        updateFurniture(updated);
        if (projectId) cadApi.updateFurniture(projectId, f.id, updated).catch(console.error);
      }
    } else if (drag.kind === 'resize') {
      const f = scene.furniture.find((fi) => fi.id === drag.furnitureId);
      if (f && livePos.w !== undefined && livePos.d !== undefined) {
        const updated: FurnitureInstance = {
          ...f,
          position: [livePos.x, f.position[1], livePos.z],
          dimensions: { ...f.dimensions, width: livePos.w, depth: livePos.d },
        };
        updateFurniture(updated);
        if (projectId) cadApi.updateFurniture(projectId, f.id, updated).catch(console.error);
      }
    } else if (drag.kind === 'zone-move') {
      const zone = zones.find((z) => z.id === drag.zoneId);
      if (zone) {
        const updated: FloorZone = { ...zone, x: livePos.x, z: livePos.z };
        updateZone(updated);
        // zones are persisted as part of the scene store
        if (projectId && scene) {
          cadApi.updateStore(projectId, { ...scene.store, zones: zones.map((z) => z.id === zone.id ? updated : z) }).catch(console.error);
        }
      }
    } else if (drag.kind === 'zone-resize') {
      const zone = zones.find((z) => z.id === drag.zoneId);
      if (zone && livePos.w !== undefined && livePos.d !== undefined) {
        const updated: FloorZone = { ...zone, x: livePos.x, z: livePos.z, width: livePos.w, depth: livePos.d };
        updateZone(updated);
        if (projectId && scene) {
          cadApi.updateStore(projectId, { ...scene.store, zones: zones.map((z) => z.id === zone.id ? updated : z) }).catch(console.error);
        }
      }
    }

    setDrag(null);
    setLivePos(null);
  }, [drag, livePos, scene, zones, updateFurniture, updateZone, projectId]);

  // ── Deselect on background click ─────────────────────────────────────────

  const handleSvgClick = () => {
    selectFurniture(null);
    selectZone(null);
  };

  // ── Build display furniture (apply live overrides) ────────────────────────

  const displayFurniture = scene?.furniture.map((f) => {
    if (!livePos || !drag) return f;
    if ((drag.kind === 'move' || drag.kind === 'resize') && drag.furnitureId === f.id) {
      return {
        ...f,
        position: [livePos.x, f.position[1], livePos.z] as [number, number, number],
        dimensions: {
          ...f.dimensions,
          ...(livePos.w !== undefined ? { width: livePos.w } : {}),
          ...(livePos.d !== undefined ? { depth: livePos.d } : {}),
        },
      };
    }
    return f;
  }) ?? [];

  const displayZones = zones.map((z) => {
    if (!livePos || !drag) return z;
    if ((drag.kind === 'zone-move' || drag.kind === 'zone-resize') && drag.zoneId === z.id) {
      return { ...z, x: livePos.x, z: livePos.z, ...(livePos.w !== undefined ? { width: livePos.w } : {}), ...(livePos.d !== undefined ? { depth: livePos.d } : {}) };
    }
    return z;
  });

  // ── Grid lines ────────────────────────────────────────────────────────────

  const gridLines = useMemo(() => {
    const lines: React.ReactElement[] = [];
    for (let gx = 0; gx <= storeW; gx += SNAP_CM) {
      lines.push(<line key={`vx${gx}`} x1={gx} y1={0} x2={gx} y2={storeD} stroke="#334155" strokeWidth={gx % 500 === 0 ? 1.5 : 0.5} />);
    }
    for (let gz = 0; gz <= storeD; gz += SNAP_CM) {
      lines.push(<line key={`hz${gz}`} x1={0} y1={gz} x2={storeW} y2={gz} stroke="#334155" strokeWidth={gz % 500 === 0 ? 1.5 : 0.5} />);
    }
    return lines;
  }, [storeW, storeD]);

  // ── Padding/margin around the store ──────────────────────────────────────
  const PAD = 150;
  const vb = `-${PAD} -${PAD} ${storeW + PAD * 2} ${storeD + PAD * 2}`;

  // Disable default touch/scroll while dragging
  useEffect(() => {
    if (!drag) return;
    document.body.style.userSelect = 'none';
    return () => { document.body.style.userSelect = ''; };
  }, [drag]);

  return (
    <div className="w-full h-full bg-gray-950 overflow-hidden select-none">
      <svg
        ref={svgRef}
        viewBox={vb}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full"
        style={{ cursor: drag ? 'grabbing' : 'default' }}
        onClick={handleSvgClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <defs>
          {/* Diagonal hatch pattern for "à plat" furniture */}
          <pattern id="hatch" width="10" height="10" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="10" stroke="rgba(255,255,255,0.15)" strokeWidth="4" />
          </pattern>
        </defs>

        {/* Store background */}
        <rect x={0} y={0} width={storeW} height={storeD} fill="#0F172A" rx={4} />

        {/* Grid */}
        {gridLines}

        {/* Store boundary */}
        <rect x={0} y={0} width={storeW} height={storeD} fill="none" stroke="#475569" strokeWidth={2} rx={4} />

        {/* Dimension labels */}
        <text x={storeW / 2} y={-PAD / 2} textAnchor="middle" fontSize={20} fill="#64748B">
          {(storeW / 100).toFixed(0)} m
        </text>
        <text x={-PAD / 2} y={storeD / 2} textAnchor="middle" fontSize={20} fill="#64748B" transform={`rotate(-90 ${-PAD / 2} ${storeD / 2})`}>
          {(storeD / 100).toFixed(0)} m
        </text>

        {/* Zones (below furniture) */}
        {displayZones.map((zone) => (
          <ZoneRect
            key={zone.id}
            zone={zone}
            isSelected={zone.id === selectedZoneId}
            onSelect={() => { selectZone(zone.id); selectFurniture(null); }}
            onMoveStart={handleZoneMoveStart}
            onResizeStart={handleZoneResizeStart}
          />
        ))}

        {/* Furniture */}
        {displayFurniture.map((f) => (
          <FurnitureRect
            key={f.id}
            furniture={f}
            isSelected={f.id === selectedFurnitureId}
            onSelect={() => selectFurniture(f.id)}
            onMoveStart={handleFurnitureMoveStart}
            onResizeStart={handleFurnitureResizeStart}
          />
        ))}
      </svg>
    </div>
  );
}

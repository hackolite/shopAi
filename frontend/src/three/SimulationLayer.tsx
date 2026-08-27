import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import { useSceneStore } from '../store/sceneStore';
import { useSimulationStore } from '../store/simulationStore';

const WAYPOINT_CONE_BASE_Y = 0.38;
const WAYPOINT_RING_Y = 0.02;
const WAYPOINT_LABEL_Y = 0.95;
const SUGGESTED_MARKER_Y_OFFSET = 0.005;
const SUGGESTED_MARKER_RADIUS_CM = 35;
const SUGGESTED_MARKER_INNER_RADIUS_CM = 20;
const SUGGESTED_MARKER_CROSS_HALF_CM = 18;
const SUGGESTED_MARKER_SEGMENTS = 40;

function clampCm(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  return Math.max(min, Math.min(max, rounded));
}

function getWorldHitPoint(
  gl: { domElement: HTMLElement },
  raycaster: THREE.Raycaster,
  camera: THREE.Camera,
  plane: THREE.Plane,
  clientX: number,
  clientY: number,
  ndc: THREE.Vector2,
  out: THREE.Vector3,
): boolean {
  const rect = gl.domElement.getBoundingClientRect();
  ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(plane, out) !== null;
}

function WaypointMarker({
  id,
  label,
  x,
  z,
  radiusCm,
  type,
  optional,
  invalid,
  canDrag,
  minXCm,
  maxXCm,
  minZCm,
  maxZCm,
}: {
  id: string;
  label: string;
  x: number;
  z: number;
  radiusCm: number;
  type: 'entry' | 'transit' | 'exit';
  optional: boolean;
  invalid: boolean;
  canDrag: boolean;
  minXCm: number;
  maxXCm: number;
  minZCm: number;
  maxZCm: number;
}) {
  const { gl, raycaster, camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const coneRef = useRef<THREE.Mesh>(null);
  const selectWaypoint = useSimulationStore((state) => state.selectWaypoint);
  const updateWaypoint = useSimulationStore((state) => state.updateWaypoint);
  const selectedWaypointId = useSimulationStore((state) => state.selectedWaypointId);
  const selected = selectedWaypointId === id;
  const dragStateRef = useRef<{ pointerId: number; startXcm: number; startZcm: number; startHitXcm: number; startHitZcm: number } | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const historyCapturedRef = useRef(false);
  const moveListenerRef = useRef<((event: PointerEvent) => void) | null>(null);
  const endListenerRef = useRef<((event: PointerEvent) => void) | null>(null);
  const dragPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const ndc = useRef(new THREE.Vector2());
  const dragHit = useRef(new THREE.Vector3());

  useFrame((state) => {
    if (!coneRef.current) return;
    coneRef.current.position.y = WAYPOINT_CONE_BASE_Y + Math.sin(state.clock.elapsedTime * 3) * 0.08;
  });

  const endDrag = useCallback(() => {
    if (moveListenerRef.current) {
      window.removeEventListener('pointermove', moveListenerRef.current);
      moveListenerRef.current = null;
    }
    if (endListenerRef.current) {
      window.removeEventListener('pointerup', endListenerRef.current);
      window.removeEventListener('pointercancel', endListenerRef.current);
      endListenerRef.current = null;
    }
    historyCapturedRef.current = false;
    dragStateRef.current = null;
    if (pointerIdRef.current !== null) {
      try { gl.domElement.releasePointerCapture(pointerIdRef.current); } catch { /* noop */ }
      pointerIdRef.current = null;
    }
  }, [gl]);

  useEffect(() => () => endDrag(), [endDrag]);

  return (
    <group
      ref={groupRef}
      position={[x * CM_TO_UNIT, 0, z * CM_TO_UNIT]}
      onPointerDown={(event) => {
        event.stopPropagation();
        selectWaypoint(id);
        if (!canDrag) return;
        const hit = getWorldHitPoint(
          gl,
          raycaster,
          camera,
          dragPlane,
          event.clientX,
          event.clientY,
          ndc.current,
          dragHit.current,
        );
        if (!hit) return;
        const hitXCm = dragHit.current.x / CM_TO_UNIT;
        const hitZCm = dragHit.current.z / CM_TO_UNIT;
        dragStateRef.current = {
          pointerId: event.pointerId,
          startXcm: x,
          startZcm: z,
          startHitXcm: hitXCm,
          startHitZcm: hitZCm,
        };
        historyCapturedRef.current = false;
        pointerIdRef.current = event.pointerId;
        try { gl.domElement.setPointerCapture(event.pointerId); } catch { /* noop */ }
        const onMove = (moveEvent: PointerEvent) => {
          const dragState = dragStateRef.current;
          if (!dragState || dragState.pointerId !== moveEvent.pointerId) return;
          if (!getWorldHitPoint(
            gl,
            raycaster,
            camera,
            dragPlane,
            moveEvent.clientX,
            moveEvent.clientY,
            ndc.current,
            dragHit.current,
          )) return;
          const dx = dragHit.current.x / CM_TO_UNIT - dragState.startHitXcm;
          const dz = dragHit.current.z / CM_TO_UNIT - dragState.startHitZcm;
          const nextX = clampCm(dragState.startXcm + dx, minXCm, maxXCm);
          const nextZ = clampCm(dragState.startZcm + dz, minZCm, maxZCm);
          const shouldRecordHistory = !historyCapturedRef.current && (nextX !== dragState.startXcm || nextZ !== dragState.startZcm);
          updateWaypoint(id, { x: nextX, z: nextZ }, { recordHistory: shouldRecordHistory });
          if (shouldRecordHistory) historyCapturedRef.current = true;
        };
        const onEnd = (endEvent: PointerEvent) => {
          if (dragStateRef.current?.pointerId !== endEvent.pointerId) return;
          endDrag();
        };
        moveListenerRef.current = onMove;
        endListenerRef.current = onEnd;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
      }}
    >
      <mesh ref={coneRef} rotation={[Math.PI, 0, 0]} renderOrder={1000}>
        <coneGeometry args={[0.32, 0.85, 20]} />
        <meshStandardMaterial
        color={
          invalid
            ? '#ef4444'
            : selected
              ? '#60a5fa'
              : type === 'entry'
                ? '#22c55e'
                : type === 'exit'
                  ? '#fb923c'
                  : optional
                    ? '#f59e0b'
                    : '#38bdf8'
        }
        emissive="#1f2937"
        depthTest={false}
        depthWrite={false}
      />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, WAYPOINT_RING_Y, 0]} renderOrder={999}>
        <ringGeometry args={[Math.min(Math.max(0.04, radiusCm * CM_TO_UNIT - 0.06), radiusCm * CM_TO_UNIT * 0.8), radiusCm * CM_TO_UNIT, 32]} />
        <meshBasicMaterial
          color={
            invalid
              ? '#f87171'
              : selected
                ? '#93c5fd'
                : type === 'entry'
                  ? '#4ade80'
                  : type === 'exit'
                    ? '#fdba74'
                    : optional
                      ? '#fbbf24'
                      : '#67e8f9'
          }
          transparent
          opacity={0.85}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
      <Html center position={[0, WAYPOINT_LABEL_Y, 0]} distanceFactor={10}>
        <div className="rounded bg-gray-950/85 px-2 py-1 text-[10px] font-medium text-white shadow-lg whitespace-nowrap">
          {label}{type === 'entry' ? ' · entrée' : type === 'exit' ? ' · sortie' : optional ? ' · optionnel' : ''}
        </div>
      </Html>
    </group>
  );
}

// Per-agent colour palette: [darkCenter, lightRing/cone]
const AGENT_PALETTE: Array<[string, string]> = [
  ['#b91c1c', '#fca5a5'],
  ['#1d4ed8', '#93c5fd'],
  ['#15803d', '#86efac'],
  ['#b45309', '#fcd34d'],
  ['#7e22ce', '#d8b4fe'],
  ['#0e7490', '#67e8f9'],
  ['#c2410c', '#fdba74'],
  ['#be185d', '#f9a8d4'],
  ['#4d7c0f', '#bef264'],
  ['#0f766e', '#5eead4'],
  ['#3730a3', '#a5b4fc'],
  ['#a16207', '#fef08a'],
];

// Radius of the anti-collision envelope (1 m diameter → 50 cm radius)
const ANTICOLLISION_RADIUS_CM = 50;
// Direction cone: vision-field angle and range used for the sector indicator
const AGENT_VISION_ANGLE_DEG = 70;
const AGENT_VISION_RANGE_CM = 220;

interface AgentMarkerHandle {
  setPosition(x: number, z: number): void;
  setConeHeading(y: number): void;
}

const AgentMarker = forwardRef<AgentMarkerHandle, { colorDark: string; colorLight: string }>(
  function AgentMarker({ colorDark, colorLight }, ref) {
    const groupRef = useRef<THREE.Group>(null);
    const coneGroupRef = useRef<THREE.Group>(null);

    useImperativeHandle(ref, () => ({
      setPosition(x: number, z: number) {
        if (groupRef.current) {
          groupRef.current.position.x = x;
          groupRef.current.position.z = z;
        }
      },
      setConeHeading(y: number) {
        if (coneGroupRef.current) {
          coneGroupRef.current.rotation.y = y;
        }
      },
    }));

    const thetaLength = THREE.MathUtils.degToRad(AGENT_VISION_ANGLE_DEG);
    const thetaStart = -thetaLength / 2;
    const envelopeOuter = ANTICOLLISION_RADIUS_CM * CM_TO_UNIT;
    const envelopeInner = envelopeOuter * 0.82;

    return (
      <group ref={groupRef}>
        {/* Anti-collision envelope ring */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[envelopeInner, envelopeOuter, 36]} />
          <meshBasicMaterial color={colorLight} transparent opacity={0.55} depthWrite={false} />
        </mesh>
        {/* Centre body sphere */}
        <mesh position={[0, 0.22, 0]}>
          <sphereGeometry args={[0.11, 20, 20]} />
          <meshStandardMaterial color={colorDark} emissive={colorDark} emissiveIntensity={0.4} />
        </mesh>
        {/* Direction cone sector — rotates with heading */}
        <group ref={coneGroupRef}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
            <circleGeometry args={[AGENT_VISION_RANGE_CM * CM_TO_UNIT, 28, thetaStart, thetaLength]} />
            <meshBasicMaterial color={colorLight} transparent opacity={0.18} depthWrite={false} />
          </mesh>
        </group>
      </group>
    );
  },
);

function SuggestedWaypointMarker({
  xCm,
  zCm,
}: {
  xCm: number;
  zCm: number;
}) {
  const outerRadius = SUGGESTED_MARKER_RADIUS_CM * CM_TO_UNIT;
  const innerRadius = SUGGESTED_MARKER_INNER_RADIUS_CM * CM_TO_UNIT;
  const crossHalf = SUGGESTED_MARKER_CROSS_HALF_CM * CM_TO_UNIT;
  return (
    <group position={[xCm * CM_TO_UNIT, WAYPOINT_RING_Y + SUGGESTED_MARKER_Y_OFFSET, zCm * CM_TO_UNIT]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={1001}>
        <ringGeometry args={[innerRadius, outerRadius, SUGGESTED_MARKER_SEGMENTS]} />
        <meshBasicMaterial color="#f43f5e" transparent opacity={0.9} depthTest={false} depthWrite={false} />
      </mesh>
      <Line
        points={[
          [-crossHalf, 0, 0],
          [crossHalf, 0, 0],
        ]}
        color="#fb7185"
        lineWidth={2}
      />
      <Line
        points={[
          [0, 0, -crossHalf],
          [0, 0, crossHalf],
        ]}
        color="#fb7185"
        lineWidth={2}
      />
    </group>
  );
}

export function SimulationLayer() {
  const scene = useSceneStore((state) => state.scene);
  const config = useSimulationStore((state) => state.config);
  const invalidWaypointIds = useSimulationStore((state) => state.invalidWaypointIds);
  const invalidWaypointSuggestion = useSimulationStore((state) => state.invalidWaypointSuggestion);
  const result = useSimulationStore((state) => state.result);
  const playing = useSimulationStore((state) => state.playing);
  const canDrag = scene != null;
  const storePos = scene?.store.position ?? [0, 0, 0];
  const minXCm = storePos[0];
  const minZCm = storePos[2];
  const maxXCm = minXCm + (scene?.store.dimensions.width ?? 0);
  const maxZCm = minZCm + (scene?.store.dimensions.depth ?? 0);

  // --- Smooth agent playback (no React state per frame) ---
  const startedAt = useRef<number | null>(null);
  const prevAgentIds = useRef<Set<number>>(new Set());
  const colorAssignments = useRef<Map<number, number>>(new Map());
  const nextColorCounter = useRef(0);
  const agentRefs = useRef<Map<number, AgentMarkerHandle>>(new Map());
  const cachedFrameAIdx = useRef(-1);
  const cachedAgentMapA = useRef<Map<number, { xCm: number; zCm: number; headingX: number; headingZ: number }>>(
    new Map(),
  );
  const [agentSlots, setAgentSlots] = useState<Map<number, { colorDark: string; colorLight: string }>>(
    () => new Map(),
  );

  useEffect(() => {
    startedAt.current = null;
    prevAgentIds.current = new Set();
    colorAssignments.current = new Map();
    nextColorCounter.current = 0;
    cachedFrameAIdx.current = -1;
    cachedAgentMapA.current = new Map();
    setAgentSlots(new Map());
  }, [result, playing]);

  useFrame((state) => {
    if (!result || result.frames.length <= 1 || !playing) return;

    if (startedAt.current == null) startedAt.current = state.clock.elapsedTime;
    const elapsed = state.clock.elapsedTime - startedAt.current;
    const totalDuration = result.frames[result.frames.length - 1].timeSeconds ?? 0;
    const t = totalDuration > 0 ? elapsed % totalDuration : elapsed;

    // Binary-search for the frame just after t
    let lo = 0;
    let hi = result.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (result.frames[mid].timeSeconds <= t) lo = mid + 1;
      else hi = mid;
    }
    const bIdx = lo;
    const aIdx = Math.max(0, bIdx - 1);
    const frameA = result.frames[aIdx];
    const frameB = result.frames[bIdx];

    // Rebuild frame-A lookup only when the bracket changes
    if (aIdx !== cachedFrameAIdx.current) {
      cachedFrameAIdx.current = aIdx;
      const m = new Map<number, { xCm: number; zCm: number; headingX: number; headingZ: number }>();
      for (const a of frameA.agents) m.set(a.id, a);
      cachedAgentMapA.current = m;
    }

    // Linear interpolation factor [0, 1]
    const dt = frameB.timeSeconds - frameA.timeSeconds;
    const alpha = dt > 0 ? Math.min(1, (t - frameA.timeSeconds) / dt) : 0;

    // Detect agent set change: new arrivals OR departures
    const currentIds = new Set(frameB.agents.map((a) => a.id));
    const idsChanged =
      currentIds.size !== prevAgentIds.current.size ||
      frameB.agents.some((a) => !prevAgentIds.current.has(a.id)) ||
      [...prevAgentIds.current].some((id) => !currentIds.has(id));

    if (idsChanged) {
      prevAgentIds.current = currentIds;
      const newSlots = new Map<number, { colorDark: string; colorLight: string }>();
      for (const id of currentIds) {
        if (!colorAssignments.current.has(id)) {
          colorAssignments.current.set(id, nextColorCounter.current % AGENT_PALETTE.length);
          nextColorCounter.current++;
        }
        const [dark, light] = AGENT_PALETTE[colorAssignments.current.get(id)!];
        newSlots.set(id, { colorDark: dark, colorLight: light });
      }
      setAgentSlots(newSlots);
    }

    // Imperatively update Three.js objects — no React re-render
    for (const agentB of frameB.agents) {
      const agentA = cachedAgentMapA.current.get(agentB.id) ?? agentB;

      const x = (agentA.xCm + (agentB.xCm - agentA.xCm) * alpha) * CM_TO_UNIT;
      const z = (agentA.zCm + (agentB.zCm - agentA.zCm) * alpha) * CM_TO_UNIT;

      // Interpolate heading vector then derive angle
      const hx = agentA.headingX + (agentB.headingX - agentA.headingX) * alpha;
      const hz = agentA.headingZ + (agentB.headingZ - agentA.headingZ) * alpha;
      const heading = Math.atan2(-hz, hx);

      agentRefs.current.get(agentB.id)?.setPosition(x, z);
      agentRefs.current.get(agentB.id)?.setConeHeading(heading);
    }
  });
  // --- end smooth playback ---

  const suggestedWaypoint = useMemo(() => {
    if (!invalidWaypointSuggestion) return null;
    const waypoint = config.waypoints.find((item) => item.id === invalidWaypointSuggestion.waypointId);
    if (!waypoint || !invalidWaypointIds.includes(waypoint.id)) return null;
    return { xCm: invalidWaypointSuggestion.xCm, zCm: invalidWaypointSuggestion.zCm };
  }, [config.waypoints, invalidWaypointIds, invalidWaypointSuggestion]);

  if (!config.enabled) return null;

  return (
    <>
      {config.waypoints.map((waypoint) => (
        <WaypointMarker
          key={waypoint.id}
          {...waypoint}
          invalid={invalidWaypointIds.includes(waypoint.id)}
          canDrag={canDrag}
          minXCm={minXCm}
          maxXCm={maxXCm}
          minZCm={minZCm}
          maxZCm={maxZCm}
        />
      ))}
      {[...agentSlots.entries()].map(([id, { colorDark, colorLight }]) => (
        <AgentMarker
          key={id}
          ref={(handle) => {
            if (handle) agentRefs.current.set(id, handle);
            else agentRefs.current.delete(id);
          }}
          colorDark={colorDark}
          colorLight={colorLight}
        />
      ))}
      {suggestedWaypoint && (
        <SuggestedWaypointMarker xCm={suggestedWaypoint.xCm} zCm={suggestedWaypoint.zCm} />
      )}
    </>
  );
}

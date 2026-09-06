import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Html, Line } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import { buildHeatmapPixels } from '../engine/heatmap';
import { buildMarginHeatmap } from '../engine/marginHeatmap';
import { advancePlaybackClock, clampNoReverseStep } from '../engine/simulationPlayback';
import { buildYieldHeatmap } from '../engine/yieldHeatmap';
import { useCatalogStore } from '../store/catalogStore';
import { usePlanogramStore } from '../store/planogramStore';
import { useSceneStore } from '../store/sceneStore';
import { useSimulationStore } from '../store/simulationStore';
import { useUIStore } from '../store/uiStore';
import type { AgentTrajectory, SimulationHeatmap } from '../types/cad';

const WAYPOINT_CONE_BASE_Y = 0.95;
const WAYPOINT_RING_Y = 0.02;
const WAYPOINT_LABEL_Y = 1.6;
const SUGGESTED_MARKER_Y_OFFSET = 0.005;
const SUGGESTED_MARKER_RADIUS_CM = 35;
const SUGGESTED_MARKER_INNER_RADIUS_CM = 20;
const SUGGESTED_MARKER_CROSS_HALF_CM = 18;
const SUGGESTED_MARKER_SEGMENTS = 40;
const HEATMAP_Y = 0.012;
const TRAJECTORY_Y = 0.03;
const TRAJECTORY_ACTIVE_OPACITY = 0.85;
const TRAJECTORY_PAST_OPACITY = 0.35;

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
      // Keep the click from bubbling to the floor slab's deselect handler so
      // the current product/furniture selection survives waypoint clicks.
      onClick={(event) => event.stopPropagation()}
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
            ? '#dc2626'
            : selected
              ? '#2563eb'
              : type === 'entry'
                ? '#15803d'
                : type === 'exit'
                  ? '#c2410c'
                  : optional
                    ? '#b45309'
                    : '#0369a1'
        }
        emissive={
          invalid
            ? '#7f1d1d'
            : selected
              ? '#1e3a8a'
              : type === 'entry'
                ? '#14532d'
                : type === 'exit'
                  ? '#7c2d12'
                  : optional
                    ? '#78350f'
                    : '#0c4a6e'
        }
        emissiveIntensity={0.6}
      />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, WAYPOINT_RING_Y, 0]} renderOrder={1} raycast={() => null}>
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
          side={THREE.DoubleSide}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
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
const RENDER_BUFFER_SECONDS = 0.25;
const MAX_EXTRAPOLATION_SECONDS = 0.35;
// Fixed GPU buffer capacity: the instancedMesh is allocated once with this
// many slots so Three.js never destroys/recreates it when agents arrive or
// depart.  mesh.count is updated imperatively to tell the renderer how many
// instances are actually active.
const INSTANCED_AGENTS_MAX_CAPACITY = 512;
const POSE_SMOOTHING_HZ = 12;
const MOVEMENT_HEADING_MIN_CM = 0.35;
const MAX_HEADING_TURN_RATE_RAD_S = Math.PI * 2.5;
const MIN_EXTRAPOLATION_DT_SECONDS = 1 / 30;
// Self-regulating playback clock: keeps a small buffer behind the newest frame and
// gently varies speed to stay there, so rendering stays fluid (no rhythmic freezes,
// no skips) even when the live-tick frame supply jitters around real time.
const PLAYBACK_CLOCK_OPTIONS = {
  targetBufferSeconds: RENDER_BUFFER_SECONDS,
  minRate: 0.25,
  maxRate: 1.6,
  rateStiffness: 3,
  maxExtrapolationSeconds: MAX_EXTRAPOLATION_SECONDS,
  resnapThresholdSeconds: 1,
} as const;

interface AgentPose {
  x: number;
  z: number;
  heading: number;
}

function steerAngle(current: number, target: number, maxDelta: number): number {
  const wrappedDelta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, wrappedDelta));
  return current + clampedDelta;
}

// Agents are ALWAYS rendered through the fixed-capacity instanced meshes below.
// A previous per-agent React component path (<AgentMarker>) leaked orphaned
// Group/Mesh subtrees into the Three.js scene on every agent arrival/departure
// (never removed nor disposed), which grew the renderer memory without bound
// during long live sessions and eventually crashed the tab out of memory.

function InstancedAgents({
  agentSlots,
  agentPoses,
}: {
  agentSlots: Map<number, { colorDark: string; colorLight: string }>;
  agentPoses: MutableRefObject<Map<number, AgentPose>>;
}) {
  const envelopeRef = useRef<THREE.InstancedMesh>(null);
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const coneRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const lastPoseById = useRef<Map<number, AgentPose>>(new Map());
  const orderedAgents = useMemo(() => [...agentSlots.entries()], [agentSlots]);
  const indexById = useMemo(() => {
    const map = new Map<number, number>();
    orderedAgents.forEach(([id], index) => map.set(id, index));
    return map;
  }, [orderedAgents]);
  const count = orderedAgents.length;
  const coneThetaLength = THREE.MathUtils.degToRad(AGENT_VISION_ANGLE_DEG);
  const coneThetaStart = -coneThetaLength / 2;
  const envelopeOuter = ANTICOLLISION_RADIUS_CM * CM_TO_UNIT;
  const envelopeInner = envelopeOuter * 0.82;
  const coneRange = AGENT_VISION_RANGE_CM * CM_TO_UNIT;

  // Tracks the previous agent count so we can zero-out tail slots that were
  // vacated when agents departed (orderedAgents is always contiguous 0..n-1).
  const prevCountRef = useRef(0);

  useEffect(() => {
    if (!envelopeRef.current || !bodyRef.current || !coneRef.current) return;
    const dark = new THREE.Color();
    const light = new THREE.Color();

    // Update the visible instance count without recreating the GPU buffer.
    envelopeRef.current.count = count;
    bodyRef.current.count = count;
    coneRef.current.count = count;

    // Write colours for every currently-active slot.
    orderedAgents.forEach(([, colors], index) => {
      dark.set(colors.colorDark);
      light.set(colors.colorLight);
      envelopeRef.current!.setColorAt(index, light);
      bodyRef.current!.setColorAt(index, dark);
      coneRef.current!.setColorAt(index, light);
    });
    if (envelopeRef.current.instanceColor) envelopeRef.current.instanceColor.needsUpdate = true;
    if (bodyRef.current.instanceColor) bodyRef.current.instanceColor.needsUpdate = true;
    if (coneRef.current.instanceColor) coneRef.current.instanceColor.needsUpdate = true;

    // Zero-out tail slots that existed in the previous frame but no longer do.
    // Because orderedAgents is always a contiguous 0..n-1 range derived from a
    // Map, departures always shrink the tail: the vacated slots are exactly the
    // indices [count, prevCount).
    if (prevCountRef.current > count) {
      const scratch = new THREE.Object3D();
      scratch.scale.setScalar(0);
      scratch.position.set(0, 0, 0);
      scratch.rotation.set(0, 0, 0);
      scratch.updateMatrix();
      for (let i = count; i < prevCountRef.current; i++) {
        envelopeRef.current.setMatrixAt(i, scratch.matrix);
        bodyRef.current.setMatrixAt(i, scratch.matrix);
        coneRef.current.setMatrixAt(i, scratch.matrix);
      }
    }
    prevCountRef.current = count;

    // Reset poses so the per-frame loop re-writes all active matrices.
    lastPoseById.current.clear();

    envelopeRef.current.instanceMatrix.needsUpdate = true;
    bodyRef.current.instanceMatrix.needsUpdate = true;
    coneRef.current.instanceMatrix.needsUpdate = true;
  }, [orderedAgents, count]);

  useFrame(() => {
    if (!envelopeRef.current || !bodyRef.current || !coneRef.current) return;
    let matrixUpdated = false;
    for (const [id, pose] of agentPoses.current.entries()) {
      const index = indexById.get(id);
      if (index == null) continue;
      const previousPose = lastPoseById.current.get(id);
      if (
        previousPose
        && previousPose.x === pose.x
        && previousPose.z === pose.z
        && previousPose.heading === pose.heading
      ) continue;

      dummy.position.set(pose.x, 0.01, pose.z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.updateMatrix();
      envelopeRef.current.setMatrixAt(index, dummy.matrix);

      dummy.position.set(pose.x, 0.22, pose.z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bodyRef.current.setMatrixAt(index, dummy.matrix);

      dummy.position.set(pose.x, 0.015, pose.z);
      dummy.rotation.set(-Math.PI / 2, pose.heading, 0);
      dummy.updateMatrix();
      coneRef.current.setMatrixAt(index, dummy.matrix);
      lastPoseById.current.set(id, pose);
      matrixUpdated = true;
    }

    if (matrixUpdated) {
      envelopeRef.current.instanceMatrix.needsUpdate = true;
      bodyRef.current.instanceMatrix.needsUpdate = true;
      coneRef.current.instanceMatrix.needsUpdate = true;
    }
  });

  if (count === 0) return null;

  return (
    <>
      <instancedMesh ref={envelopeRef} args={[undefined, undefined, INSTANCED_AGENTS_MAX_CAPACITY]}>
        <ringGeometry args={[envelopeInner, envelopeOuter, 36]} />
        {/* No `vertexColors` here: these geometries have no `color` attribute, and
            the flag would multiply by an unbound (black) attribute, erasing the
            per-instance colours.  setColorAt() is applied automatically. */}
        <meshBasicMaterial transparent opacity={0.55} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={bodyRef} args={[undefined, undefined, INSTANCED_AGENTS_MAX_CAPACITY]}>
        <sphereGeometry args={[0.11, 20, 20]} />
        <meshStandardMaterial emissive="#111827" emissiveIntensity={0.35} />
      </instancedMesh>
      <instancedMesh ref={coneRef} args={[undefined, undefined, INSTANCED_AGENTS_MAX_CAPACITY]}>
        <circleGeometry args={[coneRange, 28, coneThetaStart, coneThetaLength]} />
        <meshBasicMaterial transparent opacity={0.18} depthWrite={false} />
      </instancedMesh>
    </>
  );
}

/** Cumulative occupancy heatmap, drawn flat on the store floor. */
function HeatmapOverlay({ heatmap }: { heatmap: SimulationHeatmap }) {
  // The counts grow on every analytics poll, but the grid dimensions rarely
  // change: allocate the texture once per grid size and rewrite its pixels in
  // place afterwards, instead of churning a new GPU texture every second.
  const texture = useMemo(() => {
    if (heatmap.cols <= 0 || heatmap.rows <= 0) return null;
    const dataTexture = new THREE.DataTexture(
      new Uint8Array(heatmap.cols * heatmap.rows * 4),
      heatmap.cols,
      heatmap.rows,
      THREE.RGBAFormat,
    );
    dataTexture.magFilter = THREE.LinearFilter;
    dataTexture.minFilter = THREE.LinearFilter;
    return dataTexture;
  }, [heatmap.cols, heatmap.rows]);

  useEffect(() => {
    const pixels = texture?.image.data as Uint8Array | null | undefined;
    if (!texture || !pixels) return;
    pixels.set(buildHeatmapPixels(heatmap));
    texture.needsUpdate = true;
  }, [heatmap, texture]);

  useEffect(() => () => texture?.dispose(), [texture]);

  if (!texture) return null;

  const width = heatmap.cols * heatmap.cellSizeCm * CM_TO_UNIT;
  const depth = heatmap.rows * heatmap.cellSizeCm * CM_TO_UNIT;
  const centerX = heatmap.originXCm * CM_TO_UNIT + width / 2;
  const centerZ = heatmap.originZCm * CM_TO_UNIT + depth / 2;

  return (
    <mesh position={[centerX, HEATMAP_Y, centerZ]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={900}>
      <planeGeometry args={[width, depth]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}

/** Polylines showing the path each agent followed through the store. */
function TrajectoryOverlay({ trajectories }: { trajectories: AgentTrajectory[] }) {
  const lines = useMemo(
    () =>
      trajectories
        .map((trajectory) => {
          const points: [number, number, number][] = [];
          for (let index = 0; index + 1 < trajectory.pointsCm.length; index += 2) {
            points.push([
              trajectory.pointsCm[index] * CM_TO_UNIT,
              TRAJECTORY_Y,
              trajectory.pointsCm[index + 1] * CM_TO_UNIT,
            ]);
          }
          return { trajectory, points };
        })
        .filter((item) => item.points.length >= 2),
    [trajectories],
  );

  return (
    <>
      {lines.map(({ trajectory, points }) => (
        <Line
          key={trajectory.agentId}
          points={points}
          color={AGENT_PALETTE[trajectory.agentId % AGENT_PALETTE.length][1]}
          lineWidth={trajectory.active ? 2 : 1.2}
          transparent
          opacity={trajectory.active ? TRAJECTORY_ACTIVE_OPACITY : TRAJECTORY_PAST_OPACITY}
          depthWrite={false}
        />
      ))}
    </>
  );
}

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
  const paused = useSimulationStore((state) => state.paused);
  const analytics = useSimulationStore((state) => state.analytics);
  const showHeatmap = useSimulationStore((state) => state.showHeatmap);
  const heatmapMode = useSimulationStore((state) => state.heatmapMode);
  const planogramDetails = usePlanogramStore((state) => state.planogramDetails);
  const catalogProducts = useCatalogStore((state) => state.products);
  const showTrajectories = useSimulationStore((state) => state.showTrajectories);
  const viewMode = useUIStore((s) => s.viewMode);
  const canDrag = scene != null;
  const storePos = scene?.store.position ?? [0, 0, 0];
  const minXCm = storePos[0];
  const minZCm = storePos[2];
  const maxXCm = minXCm + (scene?.store.dimensions.width ?? 0);
  const maxZCm = minZCm + (scene?.store.dimensions.depth ?? 0);

  // Margin heatmap is derived from the assortment, not from a running session:
  // recompute it only while the margin mode is displayed.
  const marginHeatmap = useMemo(() => {
    if (!showHeatmap || (heatmapMode !== 'margin' && heatmapMode !== 'yield') || !scene) return null;
    return buildMarginHeatmap(scene, planogramDetails.values(), catalogProducts);
  }, [catalogProducts, heatmapMode, planogramDetails, scene, showHeatmap]);

  // Yield per m²: margin exposed on a cell weighted by the client density
  // measured there by the running simulation.
  const yieldHeatmap = useMemo(() => {
    if (!showHeatmap || heatmapMode !== 'yield') return null;
    return buildYieldHeatmap(marginHeatmap, analytics?.heatmap ?? null);
  }, [analytics, heatmapMode, marginHeatmap, showHeatmap]);

  // --- Smooth agent playback (no React state per frame) ---
  const prevAgentIds = useRef<Set<number>>(new Set());
  const colorAssignments = useRef<Map<number, number>>(new Map());
  const nextColorCounter = useRef(0);
  const agentPoses = useRef<Map<number, AgentPose>>(new Map());
  const cachedFrameAIdx = useRef(-1);
  const cachedResultFrames = useRef<import('../types/cad').SimulationFrame[] | null>(null);
  const cachedAgentMapA = useRef<Map<number, { xCm: number; zCm: number; headingX: number; headingZ: number }>>(
    new Map(),
  );
  const cachedFrameB = useRef<import('../types/cad').SimulationFrame | null>(null);
  const cachedCurrentIds = useRef<Set<number>>(new Set());
  const renderTimeRef = useRef(-1);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const profile = useRef({ frameCount: 0, elapsed: 0, maxMs: 0, accMs: 0 });
  const [profilingText, setProfilingText] = useState('FPS -- | frame -- ms | max -- ms');
  const [agentSlots, setAgentSlots] = useState<Map<number, { colorDark: string; colorLight: string }>>(
    () => new Map(),
  );
  const showProfilingHud = import.meta.env.DEV;

  useEffect(() => {
    prevAgentIds.current = new Set();
    colorAssignments.current = new Map();
    nextColorCounter.current = 0;
    agentPoses.current = new Map();
    cachedFrameAIdx.current = -1;
    cachedResultFrames.current = null;
    cachedAgentMapA.current = new Map();
    cachedFrameB.current = null;
    cachedCurrentIds.current = new Set();
    renderTimeRef.current = -1;
    profile.current = { frameCount: 0, elapsed: 0, maxMs: 0, accMs: 0 };
    setProfilingText('FPS -- | frame -- ms | max -- ms');
    setAgentSlots(new Map());
  }, [playing]);

  // When returning to the 3D view from planogram mode, reset the playback clock
  // so it immediately re-syncs to the current simulation time.  Without this,
  // a hot-update (triggered by furniture resize in the planogram editor) can block
  // tick responses long enough for the clock to get stuck at the extrapolation
  // ceiling, making agents appear frozen for several seconds after returning.
  // `playing` is read via a ref so it does not become a dependency: the [playing]
  // effect already handles resets when the user starts or stops playback.
  useEffect(() => {
    if (viewMode === '3d' && playingRef.current) {
      renderTimeRef.current = -1;
    }
  }, [viewMode]);

  useFrame((_, delta) => {
    if (!result || result.frames.length <= 1 || !playing || paused) return;

    if (showProfilingHud) {
      const frameMs = delta * 1000;
      profile.current.frameCount += 1;
      profile.current.elapsed += delta;
      profile.current.accMs += frameMs;
      profile.current.maxMs = Math.max(profile.current.maxMs, frameMs);
      if (profile.current.elapsed >= 1) {
        const fps = profile.current.frameCount / profile.current.elapsed;
        const avgFrameMs = profile.current.accMs / Math.max(1, profile.current.frameCount);
        setProfilingText(`FPS ${fps.toFixed(0)} | frame ${avgFrameMs.toFixed(1)} ms | max ${profile.current.maxMs.toFixed(1)} ms`);
        profile.current = { frameCount: 0, elapsed: 0, maxMs: 0, accMs: 0 };
      }
    }

    const totalDuration = result.frames[result.frames.length - 1].timeSeconds ?? 0;
    const t = advancePlaybackClock(renderTimeRef.current, delta, totalDuration, PLAYBACK_CLOCK_OPTIONS);
    renderTimeRef.current = t;

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

    // Rebuild frame-A lookup when the bracket changes OR when result.frames is replaced
    // (same index can point to a different frame after each tick's windowed snapshot).
    if (aIdx !== cachedFrameAIdx.current || result.frames !== cachedResultFrames.current) {
      cachedFrameAIdx.current = aIdx;
      cachedResultFrames.current = result.frames;
      const m = new Map<number, { xCm: number; zCm: number; headingX: number; headingZ: number }>();
      for (const a of frameA.agents) m.set(a.id, a);
      cachedAgentMapA.current = m;
    }

    // Linear interpolation factor [0, 1]
    const dt = frameB.timeSeconds - frameA.timeSeconds;
    let alpha = 0;
    if (dt > 0) {
      const rawAlpha = (t - frameA.timeSeconds) / dt;
      if (rawAlpha <= 1) {
        alpha = Math.max(0, rawAlpha);
      } else {
        const extrapolatedTime = Math.max(0, t - frameB.timeSeconds);
        const extrapolationSeconds = Math.min(MAX_EXTRAPOLATION_SECONDS, extrapolatedTime);
        alpha = 1 + (extrapolationSeconds / Math.max(dt, MIN_EXTRAPOLATION_DT_SECONDS));
      }
    }

    // Detect agent set change: new arrivals OR departures.
    // currentIds is cached on frameB reference to avoid rebuilding the Set at 60 fps
    // (O(N) allocations per frame with many agents is a significant GC burden).
    if (frameB !== cachedFrameB.current) {
      cachedFrameB.current = frameB;
      const ids = new Set<number>();
      for (const a of frameB.agents) ids.add(a.id);
      cachedCurrentIds.current = ids;
    }
    const currentIds = cachedCurrentIds.current;
    // Size inequality catches all net-change departures or arrivals.
    // If sizes are equal, iterating currentIds for new arrivals suffices: a new arrival
    // implies a matching departure (sizes stayed equal), so both directions are covered
    // without spreading prevAgentIds into an array on every render frame.
    let idsChanged = currentIds.size !== prevAgentIds.current.size;
    if (!idsChanged) {
      for (const id of currentIds) {
        if (!prevAgentIds.current.has(id)) { idsChanged = true; break; }
      }
    }

    if (idsChanged) {
      prevAgentIds.current = currentIds;
      setAgentSlots((previous) => {
        const next = new Map(previous);
        for (const id of next.keys()) {
          if (!currentIds.has(id)) {
            next.delete(id);
            agentPoses.current.delete(id);
          }
        }
        for (const id of currentIds) {
          if (!next.has(id)) {
            if (!colorAssignments.current.has(id)) {
              colorAssignments.current.set(id, nextColorCounter.current % AGENT_PALETTE.length);
              nextColorCounter.current++;
            }
            const [dark, light] = AGENT_PALETTE[colorAssignments.current.get(id)!];
            next.set(id, { colorDark: dark, colorLight: light });
          }
        }
        return next;
      });
    }

    // Imperatively update Three.js objects — no React re-render
    const smoothingAlpha = 1 - Math.exp(-POSE_SMOOTHING_HZ * Math.max(0, delta));
    const minMovementUnits = MOVEMENT_HEADING_MIN_CM * CM_TO_UNIT;
    const minMovementUnitsSq = minMovementUnits * minMovementUnits;
    const maxTurnDelta = MAX_HEADING_TURN_RATE_RAD_S * Math.max(0, delta);
    for (const agentB of frameB.agents) {
      const agentA = cachedAgentMapA.current.get(agentB.id) ?? agentB;
      const previousPose = agentPoses.current.get(agentB.id);

      const targetX = (agentA.xCm + (agentB.xCm - agentA.xCm) * alpha) * CM_TO_UNIT;
      const targetZ = (agentA.zCm + (agentB.zCm - agentA.zCm) * alpha) * CM_TO_UNIT;
      const frameMotionDx = (agentB.xCm - agentA.xCm) * CM_TO_UNIT;
      const frameMotionDz = (agentB.zCm - agentA.zCm) * CM_TO_UNIT;
      const interpolatedHeadingX = agentA.headingX + (agentB.headingX - agentA.headingX) * alpha;
      const interpolatedHeadingZ = agentA.headingZ + (agentB.headingZ - agentA.headingZ) * alpha;
      const hasFrameMotion = Math.abs(frameMotionDx) > 1e-9 || Math.abs(frameMotionDz) > 1e-9;
      const directionDx = hasFrameMotion
        ? frameMotionDx
        : interpolatedHeadingX;
      const directionDz = hasFrameMotion
        ? frameMotionDz
        : interpolatedHeadingZ;
      const smoothedPosition = previousPose
        ? clampNoReverseStep(
          previousPose.x,
          previousPose.z,
          previousPose.x + (targetX - previousPose.x) * smoothingAlpha,
          previousPose.z + (targetZ - previousPose.z) * smoothingAlpha,
          directionDx,
          directionDz,
        )
        : { x: targetX, z: targetZ };
      const { x, z } = smoothedPosition;

      const renderedMotionDx = previousPose ? x - previousPose.x : 0;
      const renderedMotionDz = previousPose ? z - previousPose.z : 0;
      const movementMagnitudeSq = renderedMotionDx * renderedMotionDx + renderedMotionDz * renderedMotionDz;

      let targetHeading: number;
      if (movementMagnitudeSq >= minMovementUnitsSq) {
        targetHeading = Math.atan2(-renderedMotionDz, renderedMotionDx);
      } else {
        const frameMovementMagnitudeSq = frameMotionDx * frameMotionDx + frameMotionDz * frameMotionDz;
        if (frameMovementMagnitudeSq >= minMovementUnitsSq) {
          targetHeading = Math.atan2(-frameMotionDz, frameMotionDx);
        } else {
          targetHeading = Math.atan2(
            -interpolatedHeadingZ,
            interpolatedHeadingX,
          );
        }
      }

      const heading = previousPose
        ? steerAngle(previousPose.heading, targetHeading, maxTurnDelta)
        : targetHeading;

      agentPoses.current.set(agentB.id, { x, z, heading });
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
      {showHeatmap && heatmapMode === 'traffic' && analytics?.heatmap && (
        <HeatmapOverlay heatmap={analytics.heatmap} />
      )}
      {showHeatmap && heatmapMode === 'margin' && marginHeatmap && (
        <HeatmapOverlay heatmap={marginHeatmap} />
      )}
      {showHeatmap && heatmapMode === 'yield' && yieldHeatmap && (
        <HeatmapOverlay heatmap={yieldHeatmap} />
      )}
      {showTrajectories && analytics && analytics.trajectories.length > 0 && (
        <TrajectoryOverlay trajectories={analytics.trajectories} />
      )}
      <InstancedAgents agentSlots={agentSlots} agentPoses={agentPoses} />
      {showProfilingHud && (
        <Html position={[0, 2.2, 0]} distanceFactor={12}>
          <div className="rounded bg-gray-950/80 px-2 py-1 text-[10px] text-gray-200 whitespace-nowrap">
            {profilingText} · agents {agentSlots.size} · instanced
          </div>
        </Html>
      )}
      {suggestedWaypoint && (
        <SuggestedWaypointMarker xCm={suggestedWaypoint.xCm} zCm={suggestedWaypoint.zCm} />
      )}
    </>
  );
}

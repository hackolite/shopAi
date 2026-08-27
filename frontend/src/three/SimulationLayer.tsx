import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import { useSceneStore } from '../store/sceneStore';
import { useSimulationStore } from '../store/simulationStore';

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
    coneRef.current.position.y = 0.38 + Math.sin(state.clock.elapsedTime * 3) * 0.08;
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
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} renderOrder={999}>
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
      <Html center position={[0, 0.95, 0]} distanceFactor={10}>
      <div className="rounded bg-gray-950/85 px-2 py-1 text-[10px] font-medium text-white shadow-lg whitespace-nowrap">
        {label}{type === 'entry' ? ' · entrée' : type === 'exit' ? ' · sortie' : optional ? ' · optionnel' : ''}
      </div>
      </Html>
    </group>
  );
}

function AgentVision({
  xCm,
  zCm,
  headingX,
  headingZ,
  visionAngleDeg,
  visionRangeCm,
}: {
  xCm: number;
  zCm: number;
  headingX: number;
  headingZ: number;
  visionAngleDeg: number;
  visionRangeCm: number;
}) {
  const heading = Math.atan2(headingX, headingZ);
  const thetaLength = THREE.MathUtils.degToRad(visionAngleDeg);
  const thetaStart = -thetaLength / 2;

  return (
    <group position={[xCm * CM_TO_UNIT, 0, zCm * CM_TO_UNIT]} rotation={[0, heading, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <circleGeometry args={[visionRangeCm * CM_TO_UNIT, 28, thetaStart, thetaLength]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.16} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.24, 0]} castShadow>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshStandardMaterial color="#f8fafc" emissive="#38bdf8" emissiveIntensity={0.35} />
      </mesh>
      <Line
        points={[
          [0, 0.05, 0],
          [headingX * visionRangeCm * CM_TO_UNIT, 0.05, headingZ * visionRangeCm * CM_TO_UNIT],
        ]}
        color="#7dd3fc"
        lineWidth={1.5}
      />
    </group>
  );
}

export function SimulationLayer() {
  const scene = useSceneStore((state) => state.scene);
  const config = useSimulationStore((state) => state.config);
  const invalidWaypointIds = useSimulationStore((state) => state.invalidWaypointIds);
  const result = useSimulationStore((state) => state.result);
  const [frameIndex, setFrameIndex] = useState(0);
  const startedAt = useRef<number | null>(null);
  const canDrag = scene != null;
  const storePos = scene?.store.position ?? [0, 0, 0];
  const minXCm = storePos[0];
  const minZCm = storePos[2];
  const maxXCm = minXCm + (scene?.store.dimensions.width ?? 0);
  const maxZCm = minZCm + (scene?.store.dimensions.depth ?? 0);
  useEffect(() => {
    setFrameIndex(0);
    startedAt.current = null;
  }, [result]);

  useFrame((state) => {
    if (!result || result.frames.length <= 1) return;
    if (startedAt.current == null) startedAt.current = state.clock.elapsedTime;
    const elapsed = state.clock.elapsedTime - startedAt.current;
    const lastFrame = result.frames[result.frames.length - 1];
    const totalDuration = lastFrame?.timeSeconds ?? 0;
    const loopedElapsed = totalDuration > 0 ? elapsed % totalDuration : elapsed;
    let nextIndex = result.frames.findIndex((frame) => frame.timeSeconds >= loopedElapsed);
    if (nextIndex < 0) nextIndex = result.frames.length - 1;
    setFrameIndex((current) => (current === nextIndex ? current : nextIndex));
  });

  const currentFrame = useMemo(() => {
    if (!result || result.frames.length === 0) return null;
    return result.frames[Math.min(frameIndex, result.frames.length - 1)];
  }, [frameIndex, result]);

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
      {currentFrame?.agents.map((agent) => (
        <AgentVision key={agent.id} {...agent} />
      ))}
    </>
  );
}

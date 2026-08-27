import { useEffect, useMemo, useRef, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import { useSceneStore } from '../store/sceneStore';
import { useSimulationStore } from '../store/simulationStore';

function clampCm(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  return Math.max(min, Math.min(max, rounded));
}

function WaypointMarker({
  id,
  label,
  x,
  z,
  radiusCm,
  optional,
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
  optional: boolean;
  minXCm: number;
  maxXCm: number;
  minZCm: number;
  maxZCm: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const selectWaypoint = useSimulationStore((state) => state.selectWaypoint);
  const updateWaypoint = useSimulationStore((state) => state.updateWaypoint);
  const selectedWaypointId = useSimulationStore((state) => state.selectedWaypointId);
  const selected = selectedWaypointId === id;
  const dragStateRef = useRef<{ pointerId: number; offsetXCm: number; offsetZCm: number } | null>(null);
  const dragPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const dragHit = useRef(new THREE.Vector3());

  useFrame((state) => {
    if (!groupRef.current) return;
    groupRef.current.position.y = 0.9 + Math.sin(state.clock.elapsedTime * 3) * 0.08;
  });

  const endDrag = () => {
    dragStateRef.current = null;
  };

  const withPointerCaptureTarget = (target: EventTarget | null) =>
    target as (EventTarget & { setPointerCapture?: (pointerId: number) => void; releasePointerCapture?: (pointerId: number) => void }) | null;

  return (
    <group
      ref={groupRef}
      position={[x * CM_TO_UNIT, 0.9, z * CM_TO_UNIT]}
      onPointerDown={(event) => {
        event.stopPropagation();
        selectWaypoint(id);
        const hit = event.ray.intersectPlane(dragPlane, dragHit.current);
        if (!hit) return;
        const hitXCm = hit.x / CM_TO_UNIT;
        const hitZCm = hit.z / CM_TO_UNIT;
        dragStateRef.current = {
          pointerId: event.pointerId,
          offsetXCm: x - hitXCm,
          offsetZCm: z - hitZCm,
        };
        withPointerCaptureTarget(event.target)?.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const dragState = dragStateRef.current;
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const hit = event.ray.intersectPlane(dragPlane, dragHit.current);
        if (!hit) return;
        const nextX = clampCm(hit.x / CM_TO_UNIT + dragState.offsetXCm, minXCm, maxXCm);
        const nextZ = clampCm(hit.z / CM_TO_UNIT + dragState.offsetZCm, minZCm, maxZCm);
        updateWaypoint(id, { x: nextX, z: nextZ });
      }}
      onPointerUp={(event) => {
        if (dragStateRef.current?.pointerId !== event.pointerId) return;
        event.stopPropagation();
        withPointerCaptureTarget(event.target)?.releasePointerCapture?.(event.pointerId);
        endDrag();
      }}
      onPointerCancel={(event) => {
        if (dragStateRef.current?.pointerId !== event.pointerId) return;
        event.stopPropagation();
        withPointerCaptureTarget(event.target)?.releasePointerCapture?.(event.pointerId);
        endDrag();
      }}
      onPointerMissed={() => {
        endDrag();
      }}
    >
      <mesh rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.18, 0.45, 16]} />
        <meshStandardMaterial color={selected ? '#60a5fa' : optional ? '#f59e0b' : '#22c55e'} emissive="#1f2937" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.82, 0]}>
        <ringGeometry args={[Math.max(0.12, radiusCm * CM_TO_UNIT - 0.03), radiusCm * CM_TO_UNIT, 32]} />
        <meshBasicMaterial color={selected ? '#93c5fd' : optional ? '#fbbf24' : '#4ade80'} transparent opacity={0.85} />
      </mesh>
      <Html center position={[0, 0.35, 0]} distanceFactor={10}>
        <div className="rounded bg-gray-950/85 px-2 py-1 text-[10px] font-medium text-white shadow-lg whitespace-nowrap">
          {label}{optional ? ' · optionnel' : ''}
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
  const result = useSimulationStore((state) => state.result);
  const [frameIndex, setFrameIndex] = useState(0);
  const startedAt = useRef<number | null>(null);
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

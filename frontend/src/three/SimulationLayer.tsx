import { useEffect, useMemo, useRef, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import { useSimulationStore } from '../store/simulationStore';

function WaypointMarker({
  id,
  label,
  x,
  z,
  radiusCm,
  optional,
}: {
  id: string;
  label: string;
  x: number;
  z: number;
  radiusCm: number;
  optional: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const selectWaypoint = useSimulationStore((state) => state.selectWaypoint);
  const selectedWaypointId = useSimulationStore((state) => state.selectedWaypointId);
  const selected = selectedWaypointId === id;

  useFrame((state) => {
    if (!groupRef.current) return;
    groupRef.current.position.y = 0.9 + Math.sin(state.clock.elapsedTime * 3) * 0.08;
  });

  return (
    <group
      ref={groupRef}
      position={[x * CM_TO_UNIT, 0.9, z * CM_TO_UNIT]}
      onClick={(event) => {
        event.stopPropagation();
        selectWaypoint(id);
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
  const config = useSimulationStore((state) => state.config);
  const result = useSimulationStore((state) => state.result);
  const [frameIndex, setFrameIndex] = useState(0);
  const startedAt = useRef<number | null>(null);

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
        <WaypointMarker key={waypoint.id} {...waypoint} />
      ))}
      {currentFrame?.agents.map((agent) => (
        <AgentVision key={agent.id} {...agent} />
      ))}
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import {
  aggregateSensorCells,
  filterSensorSamples,
  getMetricValue,
  metricStatsByName,
  normalizeMetricValue,
  projectSensorSample,
  reconcileProgressiveSensorReveal,
  sensorRevealBatchSize,
} from '../engine/liveSensors';
import { useSceneStore } from '../store/sceneStore';
import { useSensorStore } from '../store/sensorStore';

function sensorColor(value: number): string {
  const hue = (1 - Math.max(0, Math.min(1, value))) * 0.66;
  return new THREE.Color().setHSL(hue, 0.9, 0.5).getStyle();
}

export function SensorLayer() {
  const scene = useSceneStore((state) => state.scene);
  const {
    snapshot,
    renderMode,
    colorMetric,
    heightMetric,
    sizeMetric,
    selectedSourceIds,
    filterMetric,
    filterMinNormalized,
    filterMaxNormalized,
    opacity,
    pointScale,
    cellSizePercent,
    barMaxHeightCm,
    showLayer,
  } = useSensorStore();
  const [visibleSampleIds, setVisibleSampleIds] = useState<string[]>([]);
  const [pendingSampleIds, setPendingSampleIds] = useState<string[]>([]);
  const visibleSampleIdsRef = useRef<string[]>([]);
  const pendingSampleIdsRef = useRef<string[]>([]);

  useEffect(() => {
    const next = reconcileProgressiveSensorReveal(
      visibleSampleIdsRef.current,
      pendingSampleIdsRef.current,
      snapshot?.samples ?? [],
    );
    visibleSampleIdsRef.current = next.visibleIds;
    pendingSampleIdsRef.current = next.pendingIds;
    setVisibleSampleIds(next.visibleIds);
    setPendingSampleIds(next.pendingIds);
  }, [snapshot]);

  useEffect(() => {
    if (pendingSampleIds.length === 0) return;
    const delayMs = visibleSampleIds.length === 0 ? 0 : 140;
    const timer = window.setTimeout(() => {
      const revealCount = sensorRevealBatchSize(pendingSampleIdsRef.current.length);
      const revealedIds = pendingSampleIdsRef.current.slice(0, revealCount);
      const nextVisible = [...visibleSampleIdsRef.current, ...revealedIds];
      const nextPending = pendingSampleIdsRef.current.slice(revealCount);
      visibleSampleIdsRef.current = nextVisible;
      pendingSampleIdsRef.current = nextPending;
      setVisibleSampleIds(nextVisible);
      setPendingSampleIds(nextPending);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [pendingSampleIds.length, visibleSampleIds.length]);

  const visibleSnapshot = useMemo(() => {
    if (!snapshot) return null;
    const visibleIdSet = new Set(visibleSampleIds);
    const samples = snapshot.samples.filter((sample) => visibleIdSet.has(sample.id));
    return {
      ...snapshot,
      sampleCount: samples.length,
      samples,
    };
  }, [snapshot, visibleSampleIds]);

  const filteredSamples = useMemo(
    () => filterSensorSamples(visibleSnapshot, selectedSourceIds, {
      metricName: filterMetric,
      minNormalized: filterMinNormalized,
      maxNormalized: filterMaxNormalized,
    }),
    [filterMaxNormalized, filterMetric, filterMinNormalized, selectedSourceIds, visibleSnapshot],
  );

  const statsByName = useMemo(() => metricStatsByName(snapshot), [snapshot]);

  const aggregatedCells = useMemo(() => {
    if (!scene || !showLayer) return [];
    return aggregateSensorCells(
      filteredSamples,
      scene.store,
      snapshot,
      cellSizePercent,
      colorMetric,
      heightMetric,
      sizeMetric,
    );
  }, [cellSizePercent, colorMetric, filteredSamples, heightMetric, scene, showLayer, sizeMetric, snapshot]);

  if (!scene || !snapshot || !showLayer) return null;

  return (
    <group>
      {renderMode === 'point' && filteredSamples.map((sample) => {
        const point = projectSensorSample(sample, scene.store, snapshot);
        const colorValue = normalizeMetricValue(getMetricValue(sample, colorMetric), statsByName.get(colorMetric ?? ''));
        const heightValue = normalizeMetricValue(getMetricValue(sample, heightMetric), statsByName.get(heightMetric ?? ''));
        const sizeValue = normalizeMetricValue(getMetricValue(sample, sizeMetric), statsByName.get(sizeMetric ?? ''));
        const radiusCm = 20 + sizeValue * 36 * pointScale;
        const haloRadiusCm = radiusCm * (1.55 + heightValue * 0.45);
        return (
          <group key={sample.id} position={[point.xCm * CM_TO_UNIT, 0, point.zCm * CM_TO_UNIT]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} renderOrder={1200}>
              <circleGeometry args={[haloRadiusCm * CM_TO_UNIT, 24]} />
              <meshBasicMaterial color={sensorColor(colorValue)} transparent opacity={Math.max(0.06, opacity * 0.22)} depthWrite={false} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} renderOrder={1201}>
              <circleGeometry args={[radiusCm * CM_TO_UNIT, 20]} />
              <meshBasicMaterial color={sensorColor(colorValue)} transparent opacity={Math.max(0.18, opacity * (0.55 + heightValue * 0.35))} depthWrite={false} />
            </mesh>
          </group>
        );
      })}

      {renderMode === 'heatmap' && aggregatedCells.map((cell) => {
        const colorValue = normalizeMetricValue(cell.colorValue, statsByName.get(colorMetric ?? ''));
        const cellSizeCm = Math.max(50, (cellSizePercent / 100) * Math.max(100, Math.min(scene.store.dimensions.width, scene.store.dimensions.depth)));
        return (
          <mesh
            key={cell.key}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[cell.xCm * CM_TO_UNIT, 0.02, cell.zCm * CM_TO_UNIT]}
            renderOrder={1100}
          >
            <planeGeometry args={[cellSizeCm * CM_TO_UNIT, cellSizeCm * CM_TO_UNIT]} />
            <meshBasicMaterial
              color={sensorColor(colorValue)}
              transparent
              opacity={Math.max(0.08, opacity * colorValue)}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        );
      })}

      {renderMode === 'grid' && aggregatedCells.map((cell) => {
        const colorValue = normalizeMetricValue(cell.colorValue, statsByName.get(colorMetric ?? ''));
        const heightValue = normalizeMetricValue(cell.heightValue, statsByName.get(heightMetric ?? ''));
        const cellSizeCm = Math.max(50, (cellSizePercent / 100) * Math.max(100, Math.min(scene.store.dimensions.width, scene.store.dimensions.depth)));
        const heightCm = 10 + heightValue * 120;
        return (
          <mesh
            key={cell.key}
            position={[cell.xCm * CM_TO_UNIT, (heightCm * CM_TO_UNIT) / 2, cell.zCm * CM_TO_UNIT]}
            renderOrder={1101}
          >
            <boxGeometry args={[cellSizeCm * CM_TO_UNIT * 0.92, heightCm * CM_TO_UNIT, cellSizeCm * CM_TO_UNIT * 0.92]} />
            <meshStandardMaterial color={sensorColor(colorValue)} transparent opacity={opacity * 0.7} wireframe />
          </mesh>
        );
      })}

      {renderMode === 'bar' && aggregatedCells.map((cell) => {
        const colorValue = normalizeMetricValue(cell.colorValue, statsByName.get(colorMetric ?? ''));
        const heightValue = normalizeMetricValue(cell.heightValue, statsByName.get(heightMetric ?? ''));
        const cellSizeCm = Math.max(50, (cellSizePercent / 100) * Math.max(100, Math.min(scene.store.dimensions.width, scene.store.dimensions.depth)));
        const heightCm = 20 + heightValue * barMaxHeightCm;
        return (
          <mesh
            key={cell.key}
            position={[cell.xCm * CM_TO_UNIT, (heightCm * CM_TO_UNIT) / 2, cell.zCm * CM_TO_UNIT]}
            renderOrder={1102}
          >
            <boxGeometry args={[cellSizeCm * CM_TO_UNIT * 0.72, heightCm * CM_TO_UNIT, cellSizeCm * CM_TO_UNIT * 0.72]} />
            <meshStandardMaterial color={sensorColor(colorValue)} transparent opacity={opacity} emissive={sensorColor(colorValue)} emissiveIntensity={0.25} />
          </mesh>
        );
      })}
    </group>
  );
}

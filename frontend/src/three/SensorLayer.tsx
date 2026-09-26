import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import {
  aggregateSensorCells,
  buildMetricStats,
  filterSensorSamples,
  getSensorCellSizeCm,
  metricStatsByName,
  normalizeMetricValue,
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
    colorMetric,
    heightMetric,
    selectedSourceIds,
    filterMetric,
    filterMinNormalized,
    filterMaxNormalized,
    opacity,
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
      metrics: buildMetricStats(samples),
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

  const statsByName = useMemo(() => metricStatsByName(visibleSnapshot), [visibleSnapshot]);

  const aggregatedCells = useMemo(() => {
    if (!scene || !showLayer) return [];
    return aggregateSensorCells(
      filteredSamples,
      scene.store,
      snapshot,
      cellSizePercent,
      colorMetric,
      heightMetric,
    );
  }, [cellSizePercent, colorMetric, filteredSamples, heightMetric, scene, showLayer, snapshot]);

  if (!scene || !snapshot || !showLayer) return null;
  const cellSizeCm = getSensorCellSizeCm(scene.store, cellSizePercent);

  return (
    <group>
    {aggregatedCells.map((cell) => {
      const colorValue = normalizeMetricValue(cell.colorValue, statsByName.get(colorMetric ?? ''));
      const heightValue = normalizeMetricValue(cell.heightValue, statsByName.get(heightMetric ?? ''));
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

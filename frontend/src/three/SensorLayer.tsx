import { useEffect, useMemo, useRef, useState } from 'react';
import { CM_TO_UNIT } from '../constants';
import {
  aggregateSensorSectors,
  buildMetricStats,
  filterSensorSamples,
  metricStatsByName,
  normalizeMetricValue,
  reconcileProgressiveSensorReveal,
  sensorColor,
  sensorRevealBatchSize,
  sensorSectorFootprintCm,
} from '../engine/liveSensors';
import { useSceneStore } from '../store/sceneStore';
import { useSensorStore } from '../store/sensorStore';

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
    mapGridResolution,
    barMaxHeightCm,
    colorRamp,
    showLayer,
    isLiveTabActive,
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

  const aggregatedSectors = useMemo(() => {
    if (!scene || !showLayer || !isLiveTabActive) return [];
    return aggregateSensorSectors(
      filteredSamples,
      snapshot,
      mapGridResolution,
      colorMetric,
      heightMetric,
    );
  }, [colorMetric, filteredSamples, heightMetric, isLiveTabActive, mapGridResolution, scene, showLayer, snapshot]);

  if (!scene || !snapshot || !showLayer || !isLiveTabActive) return null;

  return (
    <group>
    {aggregatedSectors.map((sector) => {
      const colorValue = normalizeMetricValue(sector.colorValue, statsByName.get(colorMetric ?? ''));
      const heightValue = normalizeMetricValue(sector.heightValue, statsByName.get(heightMetric ?? ''));
      const heightCm = 20 + heightValue * barMaxHeightCm;
      // Sector footprint is derived from the shared grid resolution as a percentage of
      // the store bounds, the same coordinate-kind-agnostic projection used for GPS and
      // normalized samples alike, so bar width stays correct for GPS-sourced sensors.
      const footprint = sensorSectorFootprintCm(sector, mapGridResolution, scene.store);
      return (
          <mesh
            key={sector.key}
            position={[footprint.xCm * CM_TO_UNIT, (heightCm * CM_TO_UNIT) / 2, footprint.zCm * CM_TO_UNIT]}
            renderOrder={1102}
          >
            <boxGeometry args={[footprint.widthCm * CM_TO_UNIT * 0.72, heightCm * CM_TO_UNIT, footprint.depthCm * CM_TO_UNIT * 0.72]} />
            <meshStandardMaterial color={sensorColor(colorValue, colorRamp)} transparent opacity={opacity} emissive={sensorColor(colorValue, colorRamp)} emissiveIntensity={0.25} />
          </mesh>
        );
      })}
    </group>
  );
}

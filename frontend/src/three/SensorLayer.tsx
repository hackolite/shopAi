import { useMemo } from 'react';
import * as THREE from 'three';
import { CM_TO_UNIT } from '../constants';
import {
  aggregateSensorCells,
  filterSensorSamples,
  getMetricValue,
  metricStatsByName,
  normalizeMetricValue,
  projectSensorSample,
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

  const filteredSamples = useMemo(
    () => filterSensorSamples(snapshot, selectedSourceIds, {
      metricName: filterMetric,
      minNormalized: filterMinNormalized,
      maxNormalized: filterMaxNormalized,
    }),
    [filterMaxNormalized, filterMetric, filterMinNormalized, selectedSourceIds, snapshot],
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
        const radiusCm = 18 + sizeValue * 42 * pointScale;
        const heightCm = 20 + heightValue * barMaxHeightCm * 0.25;
        return (
          <group key={sample.id} position={[point.xCm * CM_TO_UNIT, 0, point.zCm * CM_TO_UNIT]}>
            <mesh position={[0, (heightCm * CM_TO_UNIT) / 2, 0]} renderOrder={1200}>
              <cylinderGeometry args={[radiusCm * CM_TO_UNIT * 0.45, radiusCm * CM_TO_UNIT, heightCm * CM_TO_UNIT, 12]} />
              <meshStandardMaterial color={sensorColor(colorValue)} transparent opacity={opacity} emissive={sensorColor(colorValue)} emissiveIntensity={0.2} />
            </mesh>
            <mesh position={[0, heightCm * CM_TO_UNIT + radiusCm * CM_TO_UNIT * 0.5, 0]} renderOrder={1201}>
              <sphereGeometry args={[radiusCm * CM_TO_UNIT * 0.45, 16, 16]} />
              <meshStandardMaterial color={sensorColor(colorValue)} transparent opacity={Math.min(1, opacity + 0.1)} emissive={sensorColor(colorValue)} emissiveIntensity={0.4} />
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

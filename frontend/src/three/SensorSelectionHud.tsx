import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { buildSensorHudLines } from '../engine/liveSensorHud';
import { zoneDisplayLabel, zoneIsLikelyBuilding } from '../engine/floorZones';
import { useSensorStore } from '../store/sensorStore';
import { useZoneStore } from '../store/zoneStore';

const HUD_DISTANCE = 10;
const ROW_HEIGHT_PX = 72;
const ROW_WIDTH_PX = 520;
const MARGIN_SCREEN_FRACTION = 0.03;
const ROW_SCREEN_FRACTION = 0.07;

function drawTexture(lines: string[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ROW_WIDTH_PX;
  canvas.height = ROW_HEIGHT_PX * lines.length;
  const ctx = canvas.getContext('2d')!;
  lines.forEach((line, index) => {
    const top = index * ROW_HEIGHT_PX;
    ctx.fillStyle = 'rgba(3, 7, 18, 0.86)';
    ctx.fillRect(0, top + 2, ROW_WIDTH_PX, ROW_HEIGHT_PX - 4);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, top + 3, ROW_WIDTH_PX - 2, ROW_HEIGHT_PX - 6);
    ctx.fillStyle = index === 0 ? '#67e8f9' : '#e5e7eb';
    ctx.font = index === 0 ? '700 30px ui-sans-serif, system-ui, sans-serif' : '600 26px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(line, 18, top + ROW_HEIGHT_PX / 2);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function SensorSelectionHud() {
  const snapshot = useSensorStore((state) => state.snapshot);
  const selectedSourceIds = useSensorStore((state) => state.selectedSourceIds);
  const colorMetric = useSensorStore((state) => state.colorMetric);
  const heightMetric = useSensorStore((state) => state.heightMetric);
  const showLayer = useSensorStore((state) => state.showLayer);
  const isLiveTabActive = useSensorStore((state) => state.isLiveTabActive);
  const zones = useZoneStore((state) => state.zones);
  const selectedZoneId = useZoneStore((state) => state.selectedZoneId);
  const spriteRef = useRef<THREE.Sprite>(null);

  const selectedBuildingName = useMemo(() => {
    if (!selectedZoneId) return null;
    const zone = zones.find((item) => item.id === selectedZoneId);
    if (!zone || !zoneIsLikelyBuilding(zone)) return null;
    return zoneDisplayLabel(zone);
  }, [selectedZoneId, zones]);

  const lines = useMemo(() => {
    const selectedSourceLabels = !snapshot || !isLiveTabActive
      ? []
      : selectedSourceIds.map((sourceId) => snapshot.sourceLabels[sourceId] || sourceId);
    return buildSensorHudLines({
      selectedBuildingName,
      showLayer: showLayer && isLiveTabActive,
      selectedSourceLabels,
      colorMetric,
      heightMetric,
    });
  }, [colorMetric, heightMetric, isLiveTabActive, selectedBuildingName, selectedSourceIds, showLayer, snapshot]);

  const texture = useMemo(() => (lines.length > 0 ? drawTexture(lines) : null), [lines]);

  useEffect(() => () => {
    if (texture?.image instanceof HTMLCanvasElement) {
      texture.image.width = 0;
      texture.image.height = 0;
    }
    texture?.dispose();
  }, [texture]);

  useFrame(({ camera }) => {
    const sprite = spriteRef.current;
    if (!sprite || !texture || !(camera instanceof THREE.PerspectiveCamera)) return;
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * HUD_DISTANCE;
    const halfW = halfH * camera.aspect;
    const rowH = ROW_SCREEN_FRACTION * 2 * halfH;
    const spriteH = rowH * lines.length;
    const spriteW = rowH * (ROW_WIDTH_PX / ROW_HEIGHT_PX);
    const margin = MARGIN_SCREEN_FRACTION * 2 * halfH;
    sprite.scale.set(spriteW, spriteH, 1);
    sprite.position
      .set(-halfW + spriteW / 2 + margin, halfH - spriteH / 2 - margin, -HUD_DISTANCE)
      .applyMatrix4(camera.matrixWorld);
  });

  if (!texture) return null;

  return (
    <sprite ref={spriteRef} renderOrder={2000}>
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} />
    </sprite>
  );
}

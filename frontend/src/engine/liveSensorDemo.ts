import type { SensorMetricValue, SensorSampleInput } from '../types/cad';

interface DemoSensorType {
  key: string;
  label: string;
  phaseOffset: number;
  profiles: {
    temperature: { base: number; amplitude: number; noiseSpan: number };
    decibel: { base: number; amplitude: number; noiseSpan: number };
    affluence: { base: number; amplitude: number; noiseSpan: number };
    humidity: { base: number; amplitude: number; noiseSpan: number };
  };
}

interface DemoSensorAnchor {
  id: string;
  label: string;
  x: number;
  y: number;
}

export interface DemoSensorDefinition {
  sourceId: string;
  sourceLabel: string;
  typeKey: string;
  coordinate: { kind: 'normalized'; x: number; y: number };
  phase: number;
  metrics: DemoSensorType['profiles'];
}

const DEMO_SENSOR_TYPES: DemoSensorType[] = [
  {
    key: 'thermal',
    label: 'Thermique',
    phaseOffset: 0.1,
    profiles: {
      temperature: { base: 23, amplitude: 6, noiseSpan: 0.8 },
      decibel: { base: 46, amplitude: 10, noiseSpan: 2.2 },
      affluence: { base: 32, amplitude: 20, noiseSpan: 5 },
      humidity: { base: 48, amplitude: 8, noiseSpan: 1.5 },
    },
  },
  {
    key: 'acoustic',
    label: 'Acoustique',
    phaseOffset: 0.45,
    profiles: {
      temperature: { base: 20, amplitude: 3, noiseSpan: 0.6 },
      decibel: { base: 61, amplitude: 15, noiseSpan: 3.8 },
      affluence: { base: 38, amplitude: 26, noiseSpan: 7 },
      humidity: { base: 44, amplitude: 6, noiseSpan: 1.4 },
    },
  },
  {
    key: 'traffic',
    label: 'Flux',
    phaseOffset: 0.8,
    profiles: {
      temperature: { base: 21, amplitude: 4, noiseSpan: 0.8 },
      decibel: { base: 54, amplitude: 12, noiseSpan: 2.6 },
      affluence: { base: 58, amplitude: 34, noiseSpan: 9 },
      humidity: { base: 46, amplitude: 7, noiseSpan: 1.7 },
    },
  },
  {
    key: 'comfort',
    label: 'Confort',
    phaseOffset: 1.15,
    profiles: {
      temperature: { base: 22, amplitude: 5, noiseSpan: 0.9 },
      decibel: { base: 43, amplitude: 9, noiseSpan: 1.9 },
      affluence: { base: 27, amplitude: 18, noiseSpan: 4.5 },
      humidity: { base: 56, amplitude: 10, noiseSpan: 2.2 },
    },
  },
];

const DEMO_SENSOR_ANCHORS: DemoSensorAnchor[] = [
  { id: 'north-west', label: 'Nord-Ouest', x: 12, y: 16 },
  { id: 'north-mid', label: 'Nord-Centre', x: 34, y: 18 },
  { id: 'north-east', label: 'Nord-Est', x: 82, y: 15 },
  { id: 'west-mid', label: 'Ouest-Centre', x: 16, y: 42 },
  { id: 'center-a', label: 'Centre A', x: 36, y: 48 },
  { id: 'center-b', label: 'Centre B', x: 58, y: 44 },
  { id: 'east-mid', label: 'Est-Centre', x: 84, y: 40 },
  { id: 'south-west', label: 'Sud-Ouest', x: 18, y: 74 },
  { id: 'south-mid', label: 'Sud-Centre', x: 44, y: 76 },
  { id: 'south-east', label: 'Sud-Est', x: 82, y: 78 },
  { id: 'checkout-lane', label: 'Caisses', x: 66, y: 62 },
  { id: 'promo-island', label: 'Îlot promo', x: 52, y: 28 },
];

function randomInt(min: number, max: number, random: () => number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const next = values.slice();
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index, random);
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function randomMetricValue(
  base: number,
  amplitude: number,
  tick: number,
  phase: number,
  noiseSpan: number,
  random: () => number,
): number {
  const wave = (Math.sin(tick * 0.22 + phase) + 1) / 2;
  const noise = (random() - 0.5) * noiseSpan;
  return Number((base + wave * amplitude + noise).toFixed(2));
}

function buildSensorMetrics(
  definition: DemoSensorDefinition,
  tick: number,
  random: () => number,
): SensorMetricValue[] {
  const { metrics, phase } = definition;
  return [
    {
      name: 'temperature',
      value: randomMetricValue(
        metrics.temperature.base,
        metrics.temperature.amplitude,
        tick,
        phase,
        metrics.temperature.noiseSpan,
        random,
      ),
      unit: '°C',
    },
    {
      name: 'decibel',
      value: randomMetricValue(
        metrics.decibel.base,
        metrics.decibel.amplitude,
        tick,
        phase + 0.35,
        metrics.decibel.noiseSpan,
        random,
      ),
      unit: 'dB',
    },
    {
      name: 'affluence',
      value: Math.max(0, Math.min(100, randomMetricValue(
        metrics.affluence.base,
        metrics.affluence.amplitude,
        tick,
        phase + 0.7,
        metrics.affluence.noiseSpan,
        random,
      ))),
      unit: '%',
    },
    {
      name: 'humidity',
      value: Math.max(0, Math.min(100, randomMetricValue(
        metrics.humidity.base,
        metrics.humidity.amplitude,
        tick,
        phase + 1.05,
        metrics.humidity.noiseSpan,
        random,
      ))),
      unit: '%',
    },
  ];
}

export function createDemoSensorDefinitions(random: () => number = Math.random): DemoSensorDefinition[] {
  const typeOrder = shuffle(
    DEMO_SENSOR_ANCHORS.map((_, index) => DEMO_SENSOR_TYPES[index % DEMO_SENSOR_TYPES.length]),
    random,
  );
  return DEMO_SENSOR_ANCHORS.map((anchor, index) => {
    const type = typeOrder[index] ?? DEMO_SENSOR_TYPES[index % DEMO_SENSOR_TYPES.length];
    return {
      sourceId: `demo-${anchor.id}`,
      sourceLabel: `${type.label} · ${anchor.label}`,
      typeKey: type.key,
      coordinate: { kind: 'normalized', x: anchor.x, y: anchor.y },
      phase: index * 0.29 + type.phaseOffset,
      metrics: type.profiles,
    };
  });
}

export function buildDemoSamples(
  tick: number,
  definitions: DemoSensorDefinition[],
  options?: { random?: () => number; nowMs?: number },
): SensorSampleInput[] {
  const random = options?.random ?? Math.random;
  const nowMs = options?.nowMs ?? Date.now();
  if (definitions.length === 0) return [];
  const emissionCount = randomInt(1, Math.min(4, definitions.length), random);
  const selectedDefinitions = shuffle(definitions, random).slice(0, emissionCount);
  return selectedDefinitions.map((definition, index) => ({
    sourceId: definition.sourceId,
    sourceLabel: definition.sourceLabel,
    timestampMs: nowMs + index * 25,
    coordinate: definition.coordinate,
    data: buildSensorMetrics(definition, tick, random),
  }));
}

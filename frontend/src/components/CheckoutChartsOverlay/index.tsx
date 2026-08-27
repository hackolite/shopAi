import { useSimulationStore } from '../../store/simulationStore';

function Sparkline({
  values,
  color,
}: {
  values: number[];
  color: string;
}) {
  if (values.length === 0) return null;
  const maxValue = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 120;
    const y = 44 - (value / maxValue) * 40;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg viewBox="0 0 120 44" className="h-12 w-full">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  );
}

export default function CheckoutChartsOverlay() {
  const result = useSimulationStore((state) => state.result);
  if (!result || result.checkouts.length === 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-30 w-80 rounded-xl border border-gray-700/70 bg-gray-950/88 p-3 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-300">Passages caisses</h4>
        <span className="text-[10px] text-gray-500">Queue & débit</span>
      </div>
      <div className="space-y-3">
        {result.checkouts.map((checkout, index) => {
          const lastSample = checkout.samples[checkout.samples.length - 1];
          return (
            <div key={checkout.registerId} className="rounded-lg border border-gray-800 bg-black/20 p-2">
            <div className="mb-1 flex items-center justify-between text-[11px] text-gray-300">
              <span>{checkout.registerName}</span>
              <span className="text-gray-500">servis {checkout.servedCustomers}</span>
            </div>
            <Sparkline
              values={checkout.samples.map((sample) => sample.queueLength)}
              color={index % 2 === 0 ? '#60a5fa' : '#34d399'}
            />
            <div className="mt-1 flex justify-between text-[10px] text-gray-500">
              <span>pic {checkout.queueLengthMax}</span>
              <span>
                dernier {lastSample?.queueLength ?? 0}
              </span>
            </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

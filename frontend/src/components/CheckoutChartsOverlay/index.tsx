import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCatalogStore } from '../../store/catalogStore';
import { usePlanogramStore } from '../../store/planogramStore';
import { useSceneStore } from '../../store/sceneStore';
import { useSimulationStore } from '../../store/simulationStore';
import { buildMarginHeatmap, isPointInMarginSource, marginColumnSources, productMarginEur } from '../../engine/marginHeatmap';
import { computeAbsoluteYield } from '../../engine/absoluteYield';
import { waypointThroughput } from '../../engine/waypointThroughput';

/** Margin (px) kept between the panel and the edges of the 3D viewport. */
const PANEL_MARGIN_PX = 16;
const MIN_PANEL_WIDTH_PX = 260;
const MAX_PANEL_WIDTH_PX = 640;
const MIN_CHART_HEIGHT_PX = 40;
const MAX_CHART_HEIGHT_PX = 260;
const DEFAULT_PANEL_WIDTH_PX = 320;
const DEFAULT_CHART_HEIGHT_PX = 48;
/** Points kept in the absolute-yield time series. */
const MAX_YIELD_POINTS = 180;

interface Point {
  x: number;
  y: number;
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('fr-FR', { maximumFractionDigits: digits });
}

function Chart({
  values,
  color,
  height,
  ariaLabel,
}: {
  values: number[];
  color: string;
  height: number;
  ariaLabel: string;
}) {
  const width = 120;
  if (values.length === 0) {
    return (
      <div
        role="img"
        aria-label={`${ariaLabel} — aucune donnée`}
        className="flex items-center justify-center rounded bg-black/30 text-[10px] text-gray-600"
        style={{ height }}
      >
        en attente de données…
      </div>
    );
  }
  const maxValue = Math.max(...values, Number.EPSILON);
  const points = values
    .map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * width;
      const y = height - (value / maxValue) * (height - 4);
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
      className="w-full"
      style={{ height }}
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        points={points}
      />
    </svg>
  );
}

function Section({
  id,
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  const bodyId = `waypoint-section-${id}`;
  return (
    <div className="rounded-lg border border-gray-800 bg-black/20">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggle(id)}
        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] text-gray-300 hover:bg-gray-800/60"
      >
        <span className="flex min-w-0 items-center gap-1">
          <span aria-hidden="true" className="text-gray-500">{open ? '▾' : '▸'}</span>
          <span className="truncate">{title}</span>
        </span>
        <span className="shrink-0 text-[10px] text-gray-500">{subtitle}</span>
      </button>
      <div id={bodyId} hidden={!open} className="px-2 pb-2">
        {children}
      </div>
    </div>
  );
}

export default function CheckoutChartsOverlay() {
  const result = useSimulationStore((state) => state.result);
  const analytics = useSimulationStore((state) => state.analytics);
  const scene = useSceneStore((state) => state.scene);
  const planogramDetails = usePlanogramStore((state) => state.planogramDetails);
  const catalogProducts = useCatalogStore((state) => state.products);
  const selection = useSceneStore((state) => state.selection);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragOffset = useRef<Point | null>(null);
  const resizeStart = useRef<{ pointer: Point; width: number; height: number } | null>(null);

  const [position, setPosition] = useState<Point | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH_PX);
  const [chartHeight, setChartHeight] = useState(DEFAULT_CHART_HEIGHT_PX);
  const [collapsed, setCollapsed] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(['absolute-yield']));
  const [yieldSeries, setYieldSeries] = useState<{ timeSeconds: number; value: number }[]>([]);

  const hasResult = result != null && result.waypoints.length > 0;

  // Margin (€) exposed on the floor: derived from the assortment only, so it is
  // recomputed when the layout or the planograms change, not on every tick.
  const marginHeatmap = useMemo(() => {
    if (!hasResult || !scene) return null;
    return buildMarginHeatmap(scene, planogramDetails.values(), catalogProducts);
  }, [catalogProducts, hasResult, planogramDetails, scene]);

  // Absolute optimisation metric: € of exposed margin per second, raw units.
  const absoluteYield = useMemo(
    () => computeAbsoluteYield(marginHeatmap, analytics?.visitHeatmap, analytics?.timeSeconds ?? 0),
    [analytics, marginHeatmap],
  );

  const currentYield = absoluteYield?.totalEurPerSecond ?? null;
  const currentYieldTime = absoluteYield?.elapsedSeconds ?? null;

  const selectedProductMetrics = useMemo(() => {
    if (!scene || selection.type !== 'planogram_cell' || !selection.planogramId || !selection.cellIds?.length) return null;
    const planogram = planogramDetails.get(selection.planogramId);
    if (!planogram) return null;
    const selectedCells = planogram.cells.filter((cell) => selection.cellIds!.includes(cell.id));
    const productsByEan = new Map(catalogProducts.map((product) => [product.ean, product]));
    const marginEur = selectedCells.reduce((total, cell) => {
      const product = productsByEan.get(cell.ean);
      return total + (product ? productMarginEur(product) : 0);
    }, 0);
    const furnitureById = new Map(scene.furniture.map((furniture) => [furniture.id, furniture]));
    const selectedColumns = new Set(selectedCells.map((cell) => cell.col));
    const sources = marginColumnSources([planogram], catalogProducts, furnitureById)
      .filter((source) => selectedColumns.has(source.col));
    const visits = analytics?.visitHeatmap;
    const furniture = furnitureById.get(planogram.furnitureId);
    let passages = 0;
    if (visits && furniture) {
      for (let row = 0; row < visits.rows; row++) {
        for (let col = 0; col < visits.cols; col++) {
          const xCm = visits.originXCm + (col + 0.5) * visits.cellSizeCm;
          const zCm = visits.originZCm + (row + 0.5) * visits.cellSizeCm;
          if (sources.some((source) => isPointInMarginSource(source, furniture, xCm, zCm))) {
            passages += visits.counts[row * visits.cols + col] ?? 0;
          }
        }
      }
    }
    return {
      count: selectedCells.length,
      marginEur,
      passagesPerSecond: passages / Math.max(analytics?.timeSeconds ?? 0, 1),
    };
  }, [analytics, catalogProducts, planogramDetails, scene, selection]);

  useEffect(() => {
    if (currentYield == null || currentYieldTime == null) return;
    setYieldSeries((previous) => {
      const last = previous[previous.length - 1];
      if (last && last.timeSeconds >= currentYieldTime) {
        // A new session restarts the clock: drop the stale history.
        return last.timeSeconds === currentYieldTime
          ? previous
          : [{ timeSeconds: currentYieldTime, value: currentYield }];
      }
      const next = [...previous, { timeSeconds: currentYieldTime, value: currentYield }];
      return next.length > MAX_YIELD_POINTS ? next.slice(next.length - MAX_YIELD_POINTS) : next;
    });
  }, [currentYield, currentYieldTime]);

  useEffect(() => {
    if (!hasResult) setYieldSeries([]);
  }, [hasResult]);

  const clampPosition = useCallback((next: Point): Point => {
    const panel = panelRef.current;
    const bounds = panel?.offsetParent as HTMLElement | null;
    const maxX = Math.max(0, (bounds?.clientWidth ?? 0) - (panel?.offsetWidth ?? 0));
    const maxY = Math.max(0, (bounds?.clientHeight ?? 0) - (panel?.offsetHeight ?? 0));
    return {
      x: Math.min(Math.max(0, next.x), maxX),
      y: Math.min(Math.max(0, next.y), maxY),
    };
  }, []);

  const resetPosition = useCallback(() => {
    const panel = panelRef.current;
    const bounds = panel?.offsetParent as HTMLElement | null;
    if (!panel || !bounds) return;
    setPosition(
      clampPosition({
        x: bounds.clientWidth - panel.offsetWidth - PANEL_MARGIN_PX,
        y: bounds.clientHeight - panel.offsetHeight - PANEL_MARGIN_PX,
      }),
    );
  }, [clampPosition]);

  // Initial placement: bottom-right of the viewport, once the panel is measured.
  useLayoutEffect(() => {
    if (position != null || !panelRef.current) return;
    resetPosition();
  }, [position, resetPosition, hasResult]);

  // Keep the panel inside the viewport when the window (or the layout) shrinks.
  useEffect(() => {
    const onResize = () => setPosition((previous) => (previous ? clampPosition(previous) : previous));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPosition]);

  const onHeaderPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const panel = panelRef.current;
    const bounds = panel?.offsetParent as HTMLElement | null;
    if (!panel || !bounds) return;
    const rect = bounds.getBoundingClientRect();
    dragOffset.current = {
      x: event.clientX - rect.left - panel.offsetLeft,
      y: event.clientY - rect.top - panel.offsetTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);

  const onHeaderPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const offset = dragOffset.current;
      const bounds = panelRef.current?.offsetParent as HTMLElement | null;
      if (!offset || !bounds) return;
      const rect = bounds.getBoundingClientRect();
      setPosition(
        clampPosition({
          x: event.clientX - rect.left - offset.x,
          y: event.clientY - rect.top - offset.y,
        }),
      );
    },
    [clampPosition],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    dragOffset.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      resizeStart.current = {
        pointer: { x: event.clientX, y: event.clientY },
        width: panelWidth,
        height: chartHeight,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [chartHeight, panelWidth],
  );

  const onResizePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    setPanelWidth(
      Math.min(
        MAX_PANEL_WIDTH_PX,
        Math.max(MIN_PANEL_WIDTH_PX, start.width + (event.clientX - start.pointer.x)),
      ),
    );
    setChartHeight(
      Math.min(
        MAX_CHART_HEIGHT_PX,
        Math.max(MIN_CHART_HEIGHT_PX, start.height + (event.clientY - start.pointer.y)),
      ),
    );
  }, []);

  const endResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      resizeStart.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setPosition((previous) => (previous ? clampPosition(previous) : previous));
    },
    [clampPosition],
  );

  const toggleSection = useCallback((id: string) => {
    setOpenSections((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!hasResult) return null;

  return (
    // The wrapper stays click-through so the 3D scene keeps receiving events
    // outside the panel itself, which re-enables pointer events for its own UI.
    <div className="pointer-events-none absolute inset-0 z-30">
      <div
        ref={panelRef}
        style={{
          width: panelWidth,
          left: position?.x,
          top: position?.y,
          visibility: position ? 'visible' : 'hidden',
        }}
        className="pointer-events-auto absolute rounded-xl border border-gray-700/70 bg-gray-950/90 shadow-2xl backdrop-blur"
      >
        <header
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="flex cursor-move touch-none items-center justify-between gap-2 rounded-t-xl border-b border-gray-800 px-3 py-2"
        >
          <h4 className="truncate text-xs font-semibold uppercase tracking-wider text-gray-300">
            Waypoints & rendement
          </h4>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              title="Replacer le panneau en bas à droite"
              aria-label="Replacer le panneau en bas à droite"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={resetPosition}
              className="rounded px-1 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-100"
            >
              ⤢
            </button>
            <button
              type="button"
              aria-expanded={!collapsed}
              title={collapsed ? 'Déplier le panneau' : 'Replier le panneau'}
              aria-label={collapsed ? 'Déplier le panneau' : 'Replier le panneau'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setCollapsed((previous) => !previous)}
              className="rounded px-1 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-100"
            >
              {collapsed ? '▢' : '—'}
            </button>
          </span>
        </header>

        {!collapsed && (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto p-2">
            {selectedProductMetrics && <Section
              id="selected-products"
              title={`Produits sélectionnés (${selectedProductMetrics.count})`}
              subtitle={`${formatNumber(selectedProductMetrics.passagesPerSecond)} passages/s`}
              open={openSections.has('selected-products')}
              onToggle={toggleSection}
            >
              <dl className="grid grid-cols-2 gap-x-2 text-[10px] text-gray-500">
                <dt>passages</dt>
                <dd className="text-right text-gray-400">
                  {formatNumber(selectedProductMetrics.passagesPerSecond)} /s
                </dd>
                <dt>marge exposée</dt>
                <dd className="text-right text-gray-400">{formatNumber(selectedProductMetrics.marginEur)} €</dd>
              </dl>
              <p className="mt-1 text-[10px] leading-tight text-gray-600">
                Shift+clic sur les produits du même planogramme pour les cumuler.
              </p>
            </Section>}

            <Section
              id="absolute-yield"
              title="Rendement absolu (€/s)"
              subtitle={currentYield != null ? `${formatNumber(currentYield)} €/s` : '—'}
              open={openSections.has('absolute-yield')}
              onToggle={toggleSection}
            >
              <p className="mb-1 text-[10px] leading-tight text-gray-500">
                Marge exposée (€) × flux client (pers/s), cellule par cellule, sans normalisation :
                comparable d'un agencement à l'autre.
              </p>
              <Chart
                values={yieldSeries.map((point) => point.value)}
                color="#fbbf24"
                height={chartHeight}
                ariaLabel="Évolution du rendement absolu en euros par seconde"
              />
              {absoluteYield ? (
                <dl className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] text-gray-500">
                  <dt>cellule max</dt>
                  <dd className="text-right text-gray-400">
                    {formatNumber(absoluteYield.maxCellEurPerSecond)} €/s
                  </dd>
                  <dt>marge exposée</dt>
                  <dd className="text-right text-gray-400">
                    {formatNumber(absoluteYield.exposedMarginEur, 0)} €
                  </dd>
                  <dt>flux exposé</dt>
                  <dd className="text-right text-gray-400">
                    {formatNumber(absoluteYield.exposedFlowPerSecond)} pers/s
                  </dd>
                  <dt>cellules productives</dt>
                  <dd className="text-right text-gray-400">{absoluteYield.productiveCells}</dd>
                </dl>
              ) : (
                <p className="mt-1 text-[10px] text-gray-600">
                  Nécessite une simulation en cours et un assortiment valorisé (prix / marge).
                </p>
              )}
            </Section>

            <Section
              id="customers"
              title="Parcours clients"
              subtitle={`${analytics?.customers?.length ?? 0} clients`}
              open={openSections.has('customers')}
              onToggle={toggleSection}
            >
              <div className="max-h-36 overflow-y-auto text-[10px] text-gray-500">
                {(analytics?.customers ?? []).map((customer) => (
                  <div key={customer.customerId} className="grid grid-cols-4 gap-1 border-b border-gray-800 py-1">
                    <span>#{customer.customerId}</span>
                    <span>{formatNumber(customer.distanceCm / 100, 1)} m</span>
                    <span>{formatNumber(customer.totalTimeSeconds, 1)} s</span>
                    <span className="text-right">{customer.active ? 'en magasin' : 'sorti'}</span>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-gray-600">Distance · temps total · état entrée/sortie</p>
            </Section>

            {result.waypoints.map((waypoint, index) => {
              const throughput = waypointThroughput(waypoint.samples);
              const lastSample = waypoint.samples[waypoint.samples.length - 1];
              const typeText =
                waypoint.waypointType === 'entry'
                  ? 'entrée'
                  : waypoint.waypointType === 'exit'
                    ? 'sortie'
                    : 'transit';
              return (
                <Section
                  key={waypoint.waypointId}
                  id={waypoint.waypointId}
                  title={`${waypoint.waypointLabel} · ${typeText}`}
                  subtitle={`${formatNumber(throughput.currentAgentsPerSecond)} ag/s`}
                  open={openSections.has(waypoint.waypointId)}
                  onToggle={toggleSection}
                >
                  <Chart
                    values={throughput.points.map((point) => point.agentsPerSecond)}
                    color={index % 2 === 0 ? '#60a5fa' : '#34d399'}
                    height={chartHeight}
                    ariaLabel={`Rendement du waypoint ${waypoint.waypointLabel} en agents par seconde`}
                  />
                  <dl className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] text-gray-500">
                    <dt>pic de débit</dt>
                    <dd className="text-right text-gray-400">
                      {formatNumber(throughput.maxAgentsPerSecond)} ag/s
                    </dd>
                    <dt>libérés</dt>
                    <dd className="text-right text-gray-400">{waypoint.releasedAgents}</dd>
                    <dt>actifs</dt>
                    <dd className="text-right text-gray-400">{lastSample?.activeAgents ?? 0}</dd>
                    <dt>pic de charge</dt>
                    <dd className="text-right text-gray-400">{waypoint.maxActiveAgents}</dd>
                    <dt>en file</dt>
                    <dd className="text-right text-gray-400">{waypoint.queuedAgents}</dd>
                    <dt>attente moy.</dt>
                    <dd className="text-right text-gray-400">
                      {formatNumber(waypoint.averageWaitSeconds, 1)} s
                    </dd>
                    <dt>attente max</dt>
                    <dd className="text-right text-gray-400">
                      {formatNumber(waypoint.maxWaitSeconds, 1)} s
                    </dd>
                  </dl>
                </Section>
              );
            })}
          </div>
        )}

        {!collapsed && (
          <div
            role="separator"
            aria-label="Redimensionner le panneau et les charts"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none rounded-br-xl text-[9px] leading-none text-gray-600"
          >
            <span aria-hidden="true" className="absolute bottom-0.5 right-0.5">◢</span>
          </div>
        )}
      </div>
    </div>
  );
}

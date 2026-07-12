import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PingRecord, PingStat, PingTask } from "../lib/api";
import { getPingRecords } from "../lib/api";
import { t } from "../lib/i18n";
import {
  findLiveStat,
  latencyPanelTitle,
  taskAppliesToNode,
  type ResolvedLatencySelection,
} from "../lib/latencySelection";
import { lossColor, pingColor, pingTier, TIER_COLORS } from "../lib/ping";

const HISTORY_HOURS = 4;
const HISTORY_BUCKETS = 20;
const HISTORY_REFRESH = 5 * 60_000;
const RANGE_OPTIONS = [1, 6, 12, 24, 168] as const;
type RangeHours = (typeof RANGE_OPTIONS)[number];

interface Segment {
  ms: number | null;
  loss: number;
  latencyTier: number;
  lossTier: number;
}

interface TaskSummary {
  average: number | null;
  latest: number | null;
  samples: number;
}

interface LiveSummary {
  latency: number | null;
  loss: number | null;
  samples: number;
}

type HistoryMap = Record<string, (Segment | null)[] | null>;
type SummaryMap = Record<string, TaskSummary>;
type LiveMap = Record<string, LiveSummary>;
type ChartPoint = { time: string; timestamp: number; [key: string]: string | number | undefined };

interface LatencyData {
  history: HistoryMap;
  chart: ChartPoint[];
  summary: SummaryMap;
  loading: boolean;
}

interface PopoverPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

const isZh =
  typeof navigator !== "undefined" &&
  (navigator.language || "").toLowerCase().startsWith("zh");

const taskKey = (taskId: number) => `task_${taskId}`;
const lossKey = (taskId: number) => `loss_${taskId}`;

function emptyData(selections: ResolvedLatencySelection[]): LatencyData {
  const history: HistoryMap = {};
  const summary: SummaryMap = {};
  for (const item of selections) {
    history[taskKey(item.taskId)] = null;
    summary[taskKey(item.taskId)] = { average: null, latest: null, samples: 0 };
  }
  return { history, summary, chart: [], loading: false };
}

function liveSummary(
  ping: Record<string, PingStat> | undefined,
  selections: ResolvedLatencySelection[],
): LiveMap {
  const output: LiveMap = {};
  for (const item of selections) {
    const stat = findLiveStat(ping, item.task);
    const key = taskKey(item.taskId);
    if (!stat) {
      output[key] = { latency: null, loss: null, samples: 0 };
      continue;
    }
    const latency = stat.latest > 0 ? stat.latest : stat.avg > 0 ? stat.avg : null;
    const hasProbe = stat.latest > 0 || stat.avg > 0 || stat.loss > 0;
    output[key] = {
      latency: latency === null ? null : Math.round(latency),
      loss: hasProbe ? Math.round(Number(stat.loss || 0) * 10) / 10 : null,
      samples: 1,
    };
  }
  return output;
}

function bucketize(records: PingRecord[]): (Segment | null)[] | null {
  const now = Date.now();
  const span = HISTORY_HOURS * 3600_000;
  const start = now - span;
  const buckets = Array.from({ length: HISTORY_BUCKETS }, () => ({ sum: 0, ok: 0, total: 0 }));

  for (const record of records) {
    const ts = new Date(record.time).getTime();
    if (!Number.isFinite(ts) || ts < start || ts > now) continue;
    const index = Math.min(
      HISTORY_BUCKETS - 1,
      Math.max(0, Math.floor(((ts - start) / span) * HISTORY_BUCKETS)),
    );
    const bucket = buckets[index];
    bucket.total++;
    if (record.value > 0) {
      bucket.sum += record.value;
      bucket.ok++;
    }
  }

  if (buckets.every((bucket) => bucket.total === 0)) return null;

  return buckets.map((bucket) => {
    if (!bucket.total) return null;
    const loss = Math.round(((bucket.total - bucket.ok) / bucket.total) * 100);
    const ms = bucket.ok ? Math.round(bucket.sum / bucket.ok) : null;
    return {
      ms,
      loss,
      latencyTier: ms === null ? 2 : pingTier(ms, 0),
      lossTier: pingTier(0, loss),
    };
  });
}

function formatAxisTime(timestamp: number, hours: RangeHours): string {
  const date = new Date(timestamp);
  if (hours >= 168) return date.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function chartBucketCount(hours: RangeHours): number {
  if (hours <= 1) return 60;
  if (hours <= 6) return 72;
  if (hours <= 12) return 72;
  if (hours <= 24) return 96;
  return 84;
}

function recordsByTask(records: PingRecord[], selections: ResolvedLatencySelection[]) {
  const ids = new Set(selections.map((item) => item.taskId));
  const output = new Map<number, PingRecord[]>();
  for (const item of selections) output.set(item.taskId, []);
  for (const record of records) {
    if (ids.has(record.task_id)) output.get(record.task_id)?.push(record);
  }
  return output;
}

function buildChartData(
  grouped: Map<number, PingRecord[]>,
  selections: ResolvedLatencySelection[],
  hours: RangeHours,
): ChartPoint[] {
  const now = Date.now();
  const span = hours * 3600_000;
  const start = now - span;
  const bucketCount = chartBucketCount(hours);
  const bucketSpan = span / bucketCount;
  const buckets = Array.from(
    { length: bucketCount },
    () => new Map<number, { sum: number; ok: number; total: number }>(),
  );

  for (const item of selections) {
    for (const record of grouped.get(item.taskId) || []) {
      const ts = new Date(record.time).getTime();
      if (!Number.isFinite(ts) || ts < start || ts > now) continue;
      const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((ts - start) / bucketSpan)));
      const current = buckets[index].get(item.taskId) || { sum: 0, ok: 0, total: 0 };
      current.total++;
      if (record.value > 0) {
        current.sum += record.value;
        current.ok++;
      }
      buckets[index].set(item.taskId, current);
    }
  }

  return buckets.map((bucket, index) => {
    const timestamp = start + (index + 0.5) * bucketSpan;
    const point: ChartPoint = { timestamp, time: formatAxisTime(timestamp, hours) };
    for (const item of selections) {
      const stat = bucket.get(item.taskId);
      if (!stat?.total) continue;
      if (stat.ok) point[taskKey(item.taskId)] = Math.round(stat.sum / stat.ok);
      point[lossKey(item.taskId)] = Math.round(((stat.total - stat.ok) / stat.total) * 1000) / 10;
    }
    return point;
  });
}

function buildSummary(
  grouped: Map<number, PingRecord[]>,
  selections: ResolvedLatencySelection[],
  hours: RangeHours,
): SummaryMap {
  const start = Date.now() - hours * 3600_000;
  const output: SummaryMap = {};
  for (const item of selections) {
    let sum = 0;
    let samples = 0;
    let latest = 0;
    let latestAt = -Infinity;
    for (const record of grouped.get(item.taskId) || []) {
      const ts = new Date(record.time).getTime();
      if (!Number.isFinite(ts) || ts < start || record.value <= 0) continue;
      sum += record.value;
      samples++;
      if (ts > latestAt) {
        latestAt = ts;
        latest = record.value;
      }
    }
    output[taskKey(item.taskId)] = {
      average: samples ? Math.round(sum / samples) : null,
      latest: samples ? Math.round(latest) : null,
      samples,
    };
  }
  return output;
}

function useLatencyData(
  uuid: string,
  enabled: boolean,
  cardIndex: number,
  selections: ResolvedLatencySelection[],
  rangeHours: RangeHours,
) {
  const selectionKey = selections.map((item) => item.taskId).join(",");
  const [data, setData] = useState<LatencyData>(() => emptyData(selections));

  useEffect(() => {
    if (!enabled || selections.length === 0) {
      setData(emptyData(selections));
      return;
    }
    let stopped = false;
    let timer: number | undefined;

    const load = async () => {
      if (stopped) return;
      setData((previous) => ({ ...previous, loading: true }));
      try {
        const response = await getPingRecords(uuid, Math.max(HISTORY_HOURS, rangeHours));
        if (!stopped) {
          const grouped = recordsByTask(response.records || [], selections);
          const history: HistoryMap = {};
          for (const item of selections) {
            history[taskKey(item.taskId)] = bucketize(grouped.get(item.taskId) || []);
          }
          setData({
            history,
            chart: buildChartData(grouped, selections, rangeHours),
            summary: buildSummary(grouped, selections, rangeHours),
            loading: false,
          });
        }
      } catch {
        if (!stopped) setData((previous) => ({ ...previous, loading: false }));
      }
      timer = window.setTimeout(load, HISTORY_REFRESH);
    };

    timer = window.setTimeout(load, Math.min(cardIndex * 120, 1800));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [uuid, enabled, cardIndex, selectionKey, rangeHours]);

  return data;
}

function HistoryStrip({ segments, metric }: { segments: (Segment | null)[] | null; metric: "latency" | "loss" }) {
  const data = segments || Array.from({ length: HISTORY_BUCKETS }, () => null);
  return (
    <div className="tcping-history" aria-hidden>
      {data.map((segment, index) => (
        <span
          key={index}
          className="tcping-history-segment"
          style={
            segment
              ? {
                  background: TIER_COLORS[metric === "latency" ? segment.latencyTier : segment.lossTier],
                  opacity: metric === "latency" ? 0.88 : segment.loss > 0 ? 0.95 : 0.78,
                }
              : { background: "var(--track)", opacity: 0.7 }
          }
        />
      ))}
    </div>
  );
}

function MetricColumn({
  metric,
  live,
  history,
  selections,
}: {
  metric: "latency" | "loss";
  live: LiveMap;
  history: HistoryMap;
  selections: ResolvedLatencySelection[];
}) {
  const showIdentity = metric === "latency";
  return (
    <div className="min-w-0">
      <div className="tcping-metric-title">{metric === "latency" ? t("latency") : t("loss")}</div>
      <div className="flex flex-col gap-2.5">
        {selections.map((item) => {
          const key = taskKey(item.taskId);
          const current = live[key] || { latency: null, loss: null, samples: 0 };
          const value = metric === "latency" ? current.latency : current.loss;
          const valueColor =
            value === null
              ? "var(--text-dim)"
              : metric === "latency"
                ? pingColor(value)
                : lossColor(value) || "var(--text)";
          return (
            <div key={item.taskId} className="min-w-0 tcping-carrier-row">
              <div className={`tcping-card-metric-line num ${showIdentity ? "" : "is-value-only"}`}>
                {showIdentity ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: item.color }} />
                    <span className="tcping-card-label" title={item.task.name}>{item.label}</span>
                    <span className="tcping-card-type">{item.shortTypeLabel}</span>
                  </>
                ) : (
                  <span className="sr-only">{item.label} {item.typeLabel}</span>
                )}
                <span className="ml-auto text-[12px] font-semibold shrink-0" style={{ color: valueColor }}>
                  {value === null ? "-" : metric === "latency" ? `${Math.round(value)} ms` : `${value.toFixed(1)}%`}
                </span>
              </div>
              <HistoryStrip segments={history[key] || null} metric={metric} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LatencyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; dataKey?: string | number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tcping-chart-tooltip glass-strong">
      <div className="tcping-chart-tooltip-time">{label}</div>
      {payload.map((item) => {
        const isLoss = String(item.dataKey || "").startsWith("loss_");
        const value = Number(item.value) || 0;
        return (
          <div key={`${item.name}-${String(item.dataKey)}`} className="tcping-chart-tooltip-row num">
            <span
              className={`tcping-chart-tooltip-dot ${isLoss ? "is-loss" : ""}`}
              style={{ background: item.color }}
            />
            <span>{item.name}</span>
            <strong>{isLoss ? `${value.toFixed(1)}%` : `${Math.round(value)} ms`}</strong>
          </div>
        );
      })}
    </div>
  );
}

function rangeLabel(hours: RangeHours): string {
  if (hours < 24) return isZh ? `${hours} 小时` : `${hours}h`;
  if (hours === 24) return isZh ? "1 天" : "1d";
  return isZh ? "7 天" : "7d";
}

function LatencyPopover({
  open,
  position,
  nodeName,
  title,
  chart,
  summary,
  live,
  selections,
  rangeHours,
  loading,
  visible,
  onRangeChange,
  onToggle,
  onSelectAll,
  onSelectNone,
  onClose,
}: {
  open: boolean;
  position: PopoverPosition | null;
  nodeName: string;
  title: string;
  chart: ChartPoint[];
  summary: SummaryMap;
  live: LiveMap;
  selections: ResolvedLatencySelection[];
  rangeHours: RangeHours;
  loading: boolean;
  visible: Record<string, boolean>;
  onRangeChange: (hours: RangeHours) => void;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onClose: () => void;
}) {
  if (!open || !position || typeof document === "undefined") return null;
  const visibleItems = selections.filter((item) => visible[taskKey(item.taskId)] !== false);
  const hasChartData = chart.some((point) =>
    visibleItems.some(
      (item) =>
        point[taskKey(item.taskId)] !== undefined ||
        Number(point[lossKey(item.taskId)] || 0) > 0,
    ),
  );

  return createPortal(
    <div className="tcping-click-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="tcping-hover-popover"
        style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${nodeName} ${title}`}
      >
        <div className="tcping-hover-card glass-strong">
        <div className="tcping-detail-header">
          <strong>{nodeName} {title}</strong>
          <span
            className="tcping-detail-close"
            role="button"
            tabIndex={0}
            aria-label="close"
            onClick={onClose}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onClose();
            }}
          >×</span>
        </div>

        <div className="tcping-detail-toolbar">
          <div className="tcping-detail-range-group" aria-label={`${title} range`}>
            {RANGE_OPTIONS.map((hours) => (
              <span
                key={hours}
                role="button"
                tabIndex={0}
                className={`tcping-detail-range ${rangeHours === hours ? "is-active" : ""}`}
                onClick={() => onRangeChange(hours)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onRangeChange(hours);
                }}
              >{rangeLabel(hours)}</span>
            ))}
          </div>
          <div className="tcping-detail-selection-actions">
            <span role="button" tabIndex={0} onClick={onSelectAll}>{isZh ? "全选" : "All"}</span>
            <span role="button" tabIndex={0} onClick={onSelectNone}>{isZh ? "全不选" : "None"}</span>
          </div>
        </div>

        <div className={`tcping-detail-summary-grid task-count-${selections.length}`}>
          {selections.map((item) => {
            const key = taskKey(item.taskId);
            const range = summary[key] || { average: null, latest: null, samples: 0 };
            const current = live[key]?.latency ?? null;
            const selected = visible[key] !== false;
            return (
              <div
                key={item.taskId}
                role="button"
                tabIndex={0}
                className={`tcping-detail-summary-card ${selected ? "is-selected" : ""}`}
                onClick={() => onToggle(key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onToggle(key);
                }}
              >
                <i style={{ background: item.color }} />
                <div className="tcping-detail-summary-content">
                  <div className="tcping-detail-summary-title">
                    <span className="tcping-summary-name" title={item.task.name}>{item.label}</span>
                    <span className="tcping-summary-type">{item.typeLabel}</span>
                  </div>
                  <div className="tcping-detail-summary-values num">
                    <strong style={{ color: current === null ? "var(--text-dim)" : pingColor(current) }}>
                      {current === null ? "-" : `${Math.round(current)} ms`}
                    </strong>
                    <span>{isZh ? "平均" : "Avg"} {range.average === null ? "-" : `${range.average} ms`}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="tcping-detail-mode-row">
          <span className="is-active">{t("latency")}</span>
          <small>
            {isZh
              ? "折线为延迟，彩色竖条为对应任务的丢包或断连"
              : "Lines show latency; colored vertical bars show packet loss or disconnects"}
          </small>
        </div>

        <div className="tcping-detail-chart-surface">
          <div className="tcping-detail-axis-label">{t("latency")} (ms)</div>
          <div className="tcping-hover-chart">
            {loading && <div className="tcping-detail-loading">{t("loading")}</div>}
            {hasChartData ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chart}
                  margin={{ top: 18, right: 18, left: -4, bottom: 4 }}
                  barCategoryGap="55%"
                  barGap={0}
                >
                  <CartesianGrid stroke="var(--track)" vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fill: "var(--text-dim)", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={34} />
                  <YAxis
                    yAxisId="latency"
                    domain={[0, "auto"]}
                    tick={{ fill: "var(--text-dim)", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={46}
                  />
                  <YAxis yAxisId="loss" domain={[0, 100]} hide />
                  <Tooltip content={<LatencyTooltip />} />
                  {visibleItems.map((item) => (
                    <Bar
                      key={`loss-${item.taskId}`}
                      yAxisId="loss"
                      dataKey={lossKey(item.taskId)}
                      name={`${item.label} ${item.typeLabel} ${t("loss")}`}
                      fill={item.color}
                      fillOpacity={0.48}
                      maxBarSize={4}
                      minPointSize={3}
                      radius={[2, 2, 0, 0]}
                      isAnimationActive={false}
                    />
                  ))}
                  {visibleItems.map((item) => (
                    <Line
                      key={item.taskId}
                      yAxisId="latency"
                      type="monotone"
                      dataKey={taskKey(item.taskId)}
                      name={`${item.label} ${item.typeLabel}`}
                      stroke={item.color}
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="tcping-hover-empty">
                {visibleItems.length === 0 ? (isZh ? "请选择至少一个监测项" : "Select at least one task") : t("noPingTasks")}
              </div>
            )}
          </div>

          <div className="tcping-detail-legend">
            {visibleItems.map((item) => {
              const average = summary[taskKey(item.taskId)]?.average ?? null;
              return (
                <span key={item.taskId}>
                  <i style={{ background: item.color }} />
                  <b>{item.label} {item.typeLabel}</b>
                  <small className="num">{average === null ? "-" : `${average} ms`}</small>
                </span>
              );
            })}
          </div>
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface Props {
  uuid: string;
  nodeName: string;
  cardIndex: number;
  ping?: Record<string, PingStat>;
  selections: ResolvedLatencySelection[];
  hoverSelections: ResolvedLatencySelection[];
}

export default function LatencySelectionPanel({
  uuid,
  nodeName,
  cardIndex,
  ping,
  selections,
  hoverSelections,
}: Props) {
  const applicableSelections = useMemo(
    () => selections.filter((item) => taskAppliesToNode(item.task, uuid)),
    [selections, uuid],
  );
  const applicableHoverSelections = useMemo(
    () => hoverSelections.filter((item) => taskAppliesToNode(item.task, uuid)),
    [hoverSelections, uuid],
  );

  const cardLive = useMemo(
    () => liveSummary(ping, applicableSelections),
    [ping, applicableSelections],
  );
  const hoverLive = useMemo(
    () => liveSummary(ping, applicableHoverSelections),
    [ping, applicableHoverSelections],
  );
  const cardTitle = latencyPanelTitle(applicableSelections, isZh);
  const hoverTitle = isZh ? "延迟监测" : "Latency Monitor";
  const [rangeHours, setRangeHours] = useState<RangeHours>(1);
  const cardData = useLatencyData(
    uuid,
    applicableSelections.length > 0,
    cardIndex,
    applicableSelections,
    1,
  );

  const panelRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const hoverData = useLatencyData(
    uuid,
    open && applicableHoverSelections.length > 0,
    0,
    applicableHoverSelections,
    rangeHours,
  );
  const hoverSelectionKey = applicableHoverSelections.map((item) => taskKey(item.taskId)).join(",");
  const [visible, setVisible] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const item of applicableHoverSelections) next[taskKey(item.taskId)] = true;
    setVisible(next);
  }, [hoverSelectionKey]);

  const updatePosition = () => {
    const element = panelRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(1180, Math.max(320, viewportWidth - 24));
    const estimatedHeight = Math.min(680, viewportHeight - 24);
    const left = Math.max(12, (viewportWidth - width) / 2);
    let top = rect.bottom + 10;
    if (top + estimatedHeight > viewportHeight - 12 && rect.top > estimatedHeight + 12) {
      top = rect.top - estimatedHeight - 10;
    }
    if (top + estimatedHeight > viewportHeight - 12) top = Math.max(12, (viewportHeight - estimatedHeight) / 2);
    setPosition({ left, top, width, maxHeight: Math.max(320, viewportHeight - top - 12) });
  };

  const togglePopover = () => {
    if (open) {
      setOpen(false);
      return;
    }
    updatePosition();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (applicableSelections.length === 0) return null;

  return (
    <section
      ref={panelRef}
      className={`tcping-panel ${open ? "is-popover-open" : ""}`}
      role="button"
      aria-expanded={open}
      aria-label={isZh ? "点击查看全部延迟与丢包详情" : "Click to view all latency and packet-loss details"}
      onClick={(event) => {
        event.stopPropagation();
        togglePopover();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          togglePopover();
        }
      }}
      tabIndex={0}
    >
      <div className="tcping-panel-header">
        <span className="tcping-panel-title">{cardTitle}</span>
        <span className="tcping-panel-window">4H · {applicableSelections.length}/3</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <MetricColumn metric="latency" live={cardLive} history={cardData.history} selections={applicableSelections} />
        <MetricColumn metric="loss" live={cardLive} history={cardData.history} selections={applicableSelections} />
      </div>

      <LatencyPopover
        open={open}
        position={position}
        nodeName={nodeName}
        title={hoverTitle}
        chart={hoverData.chart}
        summary={hoverData.summary}
        live={hoverLive}
        selections={applicableHoverSelections}
        rangeHours={rangeHours}
        loading={hoverData.loading}
        visible={visible}
        onRangeChange={setRangeHours}
        onToggle={(key) => setVisible((previous) => ({ ...previous, [key]: previous[key] === false }))}
        onSelectAll={() => {
          const next: Record<string, boolean> = {};
          for (const item of applicableHoverSelections) next[taskKey(item.taskId)] = true;
          setVisible(next);
        }}
        onSelectNone={() => {
          const next: Record<string, boolean> = {};
          for (const item of applicableHoverSelections) next[taskKey(item.taskId)] = false;
          setVisible(next);
        }}
        onClose={() => setOpen(false)}
      />
    </section>
  );
}

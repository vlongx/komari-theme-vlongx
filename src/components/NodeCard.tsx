import { useEffect, useState } from "react";
import type { LatestStatus, LoadRecord, NodeInfo } from "../lib/api";
import { getRecords } from "../lib/api";
import { daysUntil, fmtBytes, fmtDate, fmtPercent, fmtSpeed, fmtUptime, trafficUsed } from "../lib/format";
import { fmtCycle, fmtDaysLeft, fmtMonthlyResetDay, t } from "../lib/i18n";
import { osIcon } from "../lib/osIcon";
import { useNodeNetworkMetadata } from "../lib/nodeNetworkMetadata";
import type { ResolvedLatencySelection } from "../lib/latencySelection";
import Flag from "./Flag";
import LatencySelectionPanel from "./LatencySelectionPanel";

interface Props {
  node: NodeInfo;
  status?: LatestStatus;
  index: number;
  showLatency: boolean;
  latencySelections: ResolvedLatencySelection[];
  allLatencyTasks: ResolvedLatencySelection[];
  trafficResetDay: number;
  onClick: () => void;
}

const canTilt =
  typeof window !== "undefined" &&
  window.matchMedia("(pointer: fine)").matches &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function tiltMove(e: React.MouseEvent<HTMLElement>) {
  if (!canTilt) return;
  const r = e.currentTarget.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width - 0.5;
  const py = (e.clientY - r.top) / r.height - 0.5;
  e.currentTarget.style.transform = `perspective(900px) rotateX(${(-py * 3.5).toFixed(2)}deg) rotateY(${(px * 4.5).toFixed(2)}deg) translateY(-4px)`;
}

function tiltLeave(e: React.MouseEvent<HTMLElement>) {
  e.currentTarget.style.transform = "";
}

const GRADS = {
  cpu: { grad: "linear-gradient(90deg,#818cf8,#a78bfa)", color: "#8b7cf6" },
  ram: { grad: "linear-gradient(90deg,#f472b6,#fb7185)", color: "#f4649e" },
  disk: { grad: "linear-gradient(90deg,#fbbf24,#fb923c)", color: "#f59e2b" },
  traffic: { grad: "linear-gradient(90deg,#38bdf8,#2dd4bf)", color: "#14b8c6" },
  trafficHot: { grad: "linear-gradient(90deg,#fb7185,#f43f5e)", color: "#f43f5e" },
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  RMB: "¥",
  USD: "$",
  "US$": "$",
  CAD: "C$",
  "C$": "C$",
  HKD: "HK$",
  "HK$": "HK$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  SGD: "S$",
  AUD: "A$",
};

function Bar({
  label,
  pct,
  grad,
  color,
  sub,
}: {
  label: string;
  pct: number;
  grad: string;
  color: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-[12px] font-semibold min-w-0 truncate">{label}</span>
        <span className="text-[13px] font-semibold num shrink-0" style={{ color }}>
          {pct.toFixed(pct >= 10 ? 0 : 1)}%
        </span>
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%`, background: grad }} />
      </div>
      {sub && (
        <div className="text-[11px] text-dim num mt-1 truncate" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

function InfoStat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-dim truncate">{label}</div>
      <div
        className="text-[13px] font-semibold num truncate mt-0.5"
        style={color ? { color } : undefined}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function formatCount(value: number | undefined): string {
  return Math.max(0, Number(value) || 0).toLocaleString();
}

function ConnectionsRow({ tcp, udp }: { tcp: number; udp: number }) {
  return (
    <div className="connection-row">
      <span className="text-[12px] text-dim">{t("connections")}</span>
      <div className="connection-values num">
        <span className="connection-item">
          <span className="connection-protocol">{t("tcp")}</span>
          <strong style={{ color: "#8b7cf6" }}>{formatCount(tcp)}</strong>
        </span>
        <span className="connection-divider">·</span>
        <span className="connection-item">
          <span className="connection-protocol">{t("udp")}</span>
          <strong style={{ color: "#14b8c6" }}>{formatCount(udp)}</strong>
        </span>
      </div>
    </div>
  );
}

function metadataTag(tags: string, keys: string[]): string {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const part of (tags || "").split(";")) {
    const item = part.trim();
    const colon = item.indexOf(":");
    if (colon <= 0) continue;
    const key = item.slice(0, colon).trim().toLowerCase();
    if (!wanted.has(key)) continue;
    const value = item.slice(colon + 1).trim();
    if (value) return value;
  }
  return "";
}

function normalizedResetDay(tags: string, fallback: number): number {
  const match = (tags || "").match(/(?:^|;)\s*traffic-reset\s*:\s*(\d{1,2})\s*(?:;|$)/i);
  const value = match ? Number(match[1]) : Number(fallback);
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(28, Math.round(value)));
}

function cycleStart(resetDay: number): Date {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  if (now.getDate() < resetDay) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return new Date(year, month, resetDay, 0, 0, 0, 0);
}

function cumulativeDelta(records: LoadRecord[], key: "net_total_up" | "net_total_down", startMs: number): number {
  const sorted = [...records]
    .filter((record) => Number.isFinite(Number(record[key])))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  if (sorted.length === 0) return 0;

  let baselineIndex = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (new Date(sorted[i].time).getTime() <= startMs) baselineIndex = i;
    else break;
  }
  let previous = Math.max(0, Number(sorted[baselineIndex][key]) || 0);
  let total = 0;

  for (let i = baselineIndex + 1; i < sorted.length; i++) {
    if (new Date(sorted[i].time).getTime() < startMs) continue;
    const current = Math.max(0, Number(sorted[i][key]) || 0);
    total += current >= previous ? current - previous : current;
    previous = current;
  }
  return total;
}

function cycleTrafficFromRecords(records: LoadRecord[], resetDay: number, type: string): number | null {
  const start = cycleStart(resetDay);
  const startMs = start.getTime();
  const inCycle = records.filter((record) => new Date(record.time).getTime() >= startMs);

  const hasDeltaTraffic = inCycle.some(
    (record) => Number(record.traffic_up || 0) > 0 || Number(record.traffic_down || 0) > 0,
  );
  if (hasDeltaTraffic) {
    const up = inCycle.reduce((sum, record) => sum + Math.max(0, Number(record.traffic_up || 0)), 0);
    const down = inCycle.reduce((sum, record) => sum + Math.max(0, Number(record.traffic_down || 0)), 0);
    return trafficUsed(up, down, type);
  }

  const hasCounters = records.some(
    (record) => Number.isFinite(Number(record.net_total_up)) || Number.isFinite(Number(record.net_total_down)),
  );
  if (!hasCounters) return null;
  return trafficUsed(
    cumulativeDelta(records, "net_total_up", startMs),
    cumulativeDelta(records, "net_total_down", startMs),
    type,
  );
}

function useCycleTraffic(node: NodeInfo, index: number, defaultResetDay: number): number | null {
  const [value, setValue] = useState<number | null>(null);
  const resetDay = normalizedResetDay(node.tags, defaultResetDay);

  useEffect(() => {
    if (!node.traffic_limit) {
      setValue(null);
      return;
    }
    let stopped = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const start = cycleStart(resetDay);
        const hours = Math.min(24 * 35, Math.max(1, Math.ceil((Date.now() - start.getTime()) / 3600000) + 3));
        const response = await getRecords(node.uuid, hours);
        if (!stopped) setValue(cycleTrafficFromRecords(response.records || [], resetDay, node.traffic_limit_type));
      } catch {
        if (!stopped) setValue(null);
      }
      if (!stopped) timer = window.setTimeout(load, 5 * 60 * 1000);
    };

    timer = window.setTimeout(load, Math.min(250 + index * 80, 2500));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [node.uuid, node.tags, node.traffic_limit, node.traffic_limit_type, index, resetDay]);

  return value;
}

function currencySymbol(currency: string): string {
  const value = String(currency || "$").trim();
  return CURRENCY_SYMBOLS[value.toUpperCase()] || value;
}

function billingText(node: NodeInfo): string | null {
  const price = Number(node.price);
  if (!Number.isFinite(price) || price === 0) return null;

  const cycleDays = Number(node.billing_cycle);
  const cycle = Number.isFinite(cycleDays) && cycleDays > 0 ? fmtCycle(Math.round(cycleDays)) : "";
  const amount = price < 0 ? t("free") : `${currencySymbol(node.currency)}${price}`;
  return cycle ? `${amount} / ${cycle}` : amount;
}

export default function NodeCard({
  node,
  status,
  index,
  showLatency,
  latencySelections,
  allLatencyTasks,
  trafficResetDay,
  onClick,
}: Props) {
  const online = !!status?.online;
  const cpu = status ? Math.min(100, status.cpu) : 0;
  const ramPct = status ? fmtPercent(status.ram, status.ram_total || node.mem_total) : 0;
  const diskPct = status ? fmtPercent(status.disk, status.disk_total || node.disk_total) : 0;

  const trafficLimit = node.traffic_limit || 0;
  const nodeResetDay = normalizedResetDay(node.tags, trafficResetDay);
  const cycleTraffic = useCycleTraffic(node, index, trafficResetDay);
  const rawTraffic = status ? trafficUsed(status.net_total_up, status.net_total_down, node.traffic_limit_type) : 0;
  const trafficUse = cycleTraffic ?? rawTraffic;
  const trafficPct = trafficLimit > 0 ? Math.min(100, (trafficUse / trafficLimit) * 100) : 0;
  const trafficStyle = trafficPct >= 90 ? GRADS.trafficHot : GRADS.traffic;

  const expDays = daysUntil(node.expired_at);
  const expSoon = expDays !== null && expDays <= 15;
  const expiry = node.expired_at && expDays !== null ? fmtDate(node.expired_at) : null;
  const billing = billingText(node);

  // Explicit per-node metadata tags override automatic lookup when present.
  // Auto metadata is computed inside Komari by the optional privileged plugin.
  const autoNetwork = useNodeNetworkMetadata(node.uuid);
  const asn = metadataTag(node.tags, ["asn"]) || autoNetwork?.asn || "";
  const ipv4 = metadataTag(node.tags, ["ipv4", "ip4", "ipv4-country"]) || autoNetwork?.ipv4_country || "";
  const ipv6 = metadataTag(node.tags, ["ipv6", "ip6", "ipv6-country"]) || autoNetwork?.ipv6_country || "";
  // Show only the protocols that actually have location data.
  // Keep the network information row empty when neither address exists.
  const ipGeoLabel = ipv4 && ipv6 ? t("ipGeo") : ipv4 ? "IPv4" : ipv6 ? "IPv6" : t("ipGeo");
  const ipGeo = ipv4 && ipv6 ? `${ipv4} / ${ipv6}` : ipv4 || ipv6 || "";

  const tags = (node.tags || "")
    .split(";")
    .map((value) => value.trim())
    .filter(
      (value) =>
        Boolean(value) &&
        !/^(?:traffic-reset|asn|ipv4|ip4|ipv4-country|ipv6|ip6|ipv6-country)\s*:/i.test(value),
    )
    .slice(0, 3);

  const speedUp = online && status ? fmtSpeed(status.net_out) : "-";
  const speedDown = online && status ? fmtSpeed(status.net_in) : "-";
  const speedTotal = online && status ? fmtSpeed(status.net_in + status.net_out) : "-";
  const totalUp = online && status ? fmtBytes(status.net_total_up) : "-";
  const totalDown = online && status ? fmtBytes(status.net_total_down) : "-";
  const uptime = online && status ? fmtUptime(status.uptime, t) : "-";

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={node.name}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      onMouseMove={tiltMove}
      onMouseLeave={tiltLeave}
      className={`node-card glass rounded-[20px] p-4 text-left w-full card-hover rise cursor-pointer ${online ? "" : "offline-card"}`}
      style={{ animationDelay: `${Math.min(index * 55, 600)}ms` }}
    >
      <div className="flex items-start gap-2.5 mb-2.5">
        <Flag region={node.region} size={24} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {node.region && <span className="text-[11px] text-dim font-medium shrink-0">{node.region}</span>}
            <div className="font-semibold text-[15px] truncate leading-tight" title={node.name}>{node.name}</div>
          </div>
        </div>
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 mt-0.5 ${online ? "dot-online" : "dot-offline"}`}
          title={online ? t("online") : t("offline")}
        />
      </div>

      {/* Always render all three rows; Komari may intentionally omit public IP metadata. */}
      <div
        className="mb-3 px-2.5 py-2 rounded-xl flex flex-col gap-1.5"
        style={{ background: "var(--chip)", border: "1px solid var(--glass-border)" }}
      >
        <div className="flex items-start gap-2 text-[12px] text-dim leading-snug min-w-0">
          <img
            src={osIcon(node.os)}
            alt=""
            width={15}
            height={15}
            loading="lazy"
            className="shrink-0 opacity-90 mt-0.5"
          />
          <span className="min-w-0 break-words" title={`${node.os || "-"} · ${node.arch || "-"}`}>
            {node.os || "-"} · {node.arch || "-"}
          </span>
        </div>
        <div className="flex items-start gap-2 text-[12px] text-dim leading-snug min-w-0">
          <span className="shrink-0 w-[15px] text-center" aria-hidden="true">🌐</span>
          <span className="min-w-0 break-words" title={asn || t("notConfigured")}>
            <span className="font-medium">{t("asn")}:</span> {asn || t("notConfigured")}
          </span>
        </div>
        <div className="flex items-start gap-2 text-[12px] text-dim leading-snug min-w-0">
          <span className="shrink-0 w-[15px] text-center" aria-hidden="true">🌍</span>
          <span className="min-w-0 break-words" title={ipGeo}>
            <span className="font-medium">{ipGeoLabel}:</span> {ipGeo}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-x-2 gap-y-2.5 py-2.5 border-y" style={{ borderColor: "var(--glass-border)" }}>
        <InfoStat label={`↑ ${t("upload")}`} value={speedUp} color="#c56b2d" />
        <InfoStat label={t("realtimeSpeed")} value={speedTotal} color="#4f6fb5" />
        <InfoStat label={`↓ ${t("download")}`} value={speedDown} color="#0d9b78" />

        <InfoStat label={t("cumulativeUpload")} value={totalUp} color="#c56b2d" />
        <InfoStat label={t("cumulativeDownload")} value={totalDown} color="#4f6fb5" />
        <InfoStat label={t("onlineDuration")} value={uptime} color="#0d9b78" />

        {expiry && <InfoStat label={t("expire")} value={expiry} color={expSoon ? "#f59e2b" : undefined} />}
        {trafficLimit > 0 && <InfoStat label={t("trafficReset")} value={fmtMonthlyResetDay(nodeResetDay)} color="#0d9b78" />}
        {billing && <InfoStat label={t("billingAmount")} value={billing} color="#c56b2d" />}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-3 mt-3">
        <Bar
          label={t("cpu")}
          pct={online ? cpu : 0}
          grad={GRADS.cpu.grad}
          color={GRADS.cpu.color}
          sub={`${node.cpu_cores} ${t("cores")}`}
        />
        <Bar
          label={t("ram")}
          pct={online ? ramPct : 0}
          grad={GRADS.ram.grad}
          color={GRADS.ram.color}
          sub={online && status ? `${fmtBytes(status.ram)} / ${fmtBytes(status.ram_total || node.mem_total)}` : undefined}
        />
        <Bar
          label={t("disk")}
          pct={online ? diskPct : 0}
          grad={GRADS.disk.grad}
          color={GRADS.disk.color}
          sub={online && status ? `${fmtBytes(status.disk)} / ${fmtBytes(status.disk_total || node.disk_total)}` : undefined}
        />
        {trafficLimit > 0 && (
          <Bar
            label={t("cycleTraffic")}
            pct={online ? trafficPct : 0}
            grad={trafficStyle.grad}
            color={trafficStyle.color}
            sub={online && status ? `${fmtBytes(trafficUse)} / ${fmtBytes(trafficLimit)}` : undefined}
          />
        )}
      </div>

      {online && status && (
        <ConnectionsRow tcp={status.connections} udp={status.connections_udp} />
      )}

      {showLatency && online && (
        <LatencySelectionPanel
          uuid={node.uuid}
          nodeName={node.name}
          cardIndex={index}
          ping={status?.ping}
          selections={latencySelections}
          hoverSelections={allLatencyTasks}
        />
      )}

      {(tags.length > 0 || expSoon) && (
        <div className="node-card-tags flex gap-1.5 mt-2.5 flex-wrap">
          {expSoon && (
            <span
              className="text-[10.5px] px-2 py-0.5 rounded-full font-medium"
              style={{
                color: expDays! <= 3 ? "#fb7185" : "#f59e2b",
                background: "var(--chip)",
                border: `1px solid ${expDays! <= 3 ? "rgba(251,113,133,0.45)" : "rgba(245,158,43,0.45)"}`,
              }}
            >
              {expDays! < 0 ? t("expired") : fmtDaysLeft(expDays!)}
            </span>
          )}
          {tags.map((tag) => (
            <span
              key={tag}
              className="text-[10.5px] px-2 py-0.5 rounded-full"
              style={{ background: "var(--chip)", border: "1px solid var(--glass-border)" }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

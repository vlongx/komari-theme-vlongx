import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { GPUDeviceHistory, LatestStatus, LoadRecord, NodeInfo } from "../lib/api";
import { getRecords } from "../lib/api";
import { daysUntil, fmtBytes, fmtDate, fmtPercent, fmtSpeed, fmtTime, fmtUptime } from "../lib/format";
import { fmtCycle, fmtDaysLeft, t } from "../lib/i18n";
import { osIcon } from "../lib/osIcon";
import Flag from "./Flag";

interface Props {
  node: NodeInfo;
  status?: LatestStatus;
  mode: "day" | "night";
  onClose: () => void;
}

interface GPUDisplayDevice {
  name: string;
  utilization: number | null;
  memUsed: number;
  memTotal: number;
}

const RANGES = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
];

function GlassTooltip({
  active,
  payload,
  label,
  fmt,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  fmt: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-strong rounded-xl px-3 py-2 text-[12px]">
      <div className="text-dim mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-1.5 num">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <b>{fmt(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-3.5" style={{ background: "var(--chip)", border: "1px solid var(--glass-border)" }}>
      <div className="text-[13px] font-semibold mb-2">{title}</div>
      <div className="h-[180px]">{children}</div>
    </div>
  );
}

function MetaItem({ k, v, wrap = false }: { k: string; v: string; wrap?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-dim">{k}</div>
      <div
        className={`text-[13px] font-medium ${wrap ? "whitespace-normal break-words leading-snug" : "truncate"}`}
        title={v}
      >
        {v}
      </div>
    </div>
  );
}

const GPU_HINT = /(graphics|geforce|radeon|\bgpu\b|\buhd\b|\biris\b|\barc\b|quadro|tesla|\brtx\b|\bgtx\b)/i;
const GPU_REJECT = /(sensor hub|management engine|ethernet|wireless|audio controller|usb controller|sata controller)/i;

function conciseGpuName(raw?: string | null): string {
  const original = (raw || "").replace(/\s+/g, " ").trim();
  if (!original || /^(?:-|0|none|null|unknown|n\/a)$/i.test(original)) return "";
  if (GPU_REJECT.test(original)) return "";

  const brackets = Array.from(original.matchAll(/\[([^\]]+)\]/g)).map((m) => m[1].trim());
  const bracketModel = [...brackets].reverse().find((part) => GPU_HINT.test(part));
  let model = bracketModel || original;
  if (!GPU_HINT.test(model)) return "";

  model = model
    .replace(/\bIntel Corporation\b/gi, "Intel")
    .replace(/\bNVIDIA Corporation\b/gi, "NVIDIA")
    .replace(/\bAdvanced Micro Devices,? Inc\.?\b/gi, "AMD")
    .replace(/\bAMD\/ATI\b/gi, "AMD")
    .replace(/\s+/g, " ")
    .trim();

  if (bracketModel) {
    if (/Intel/i.test(original) && !/^Intel\b/i.test(model)) model = `Intel ${model}`;
    else if (/NVIDIA/i.test(original) && !/^NVIDIA\b/i.test(model)) model = `NVIDIA ${model}`;
    else if (/(AMD|Advanced Micro Devices|ATI)/i.test(original) && !/^AMD\b/i.test(model)) model = `AMD ${model}`;
  }

  return model;
}

function latestGpuUsage(records: LoadRecord[]): number | null {
  const sorted = [...records].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  const record = sorted.find((r) => typeof r.gpu === "number" && Number.isFinite(r.gpu));
  return record?.gpu ?? null;
}

export default function DetailModal({ node, status, mode, onClose }: Props) {
  const [hours, setHours] = useState(6);
  const [records, setRecords] = useState<LoadRecord[] | null>(null);
  const [gpuHistories, setGpuHistories] = useState<Record<string, GPUDeviceHistory>>({});

  const axis = mode === "day" ? "rgba(38,44,74,0.45)" : "rgba(233,236,255,0.45)";
  const grid = mode === "day" ? "rgba(38,44,74,0.10)" : "rgba(233,236,255,0.10)";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  useEffect(() => {
    let gone = false;
    setRecords(null);
    getRecords(node.uuid, hours)
      .then((d) => {
        if (gone) return;
        setRecords(d.records || []);
        setGpuHistories(d.gpu_devices || {});
      })
      .catch(() => {
        if (gone) return;
        setRecords([]);
        setGpuHistories({});
      });
    return () => {
      gone = true;
    };
  }, [node.uuid, hours]);

  const gpuDevices = useMemo<GPUDisplayDevice[]>(() => {
    const histories = Object.values(gpuHistories).sort((a, b) => a.device_index - b.device_index);
    const globalUsage = latestGpuUsage(records || []);

    if (histories.length > 0) {
      const devices = histories
        .map((history) => {
          const latest = [...(history.records || [])].sort(
            (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime(),
          )[0];
          const name = conciseGpuName(history.device_name || latest?.device_name || node.gpu_name);
          if (!name) return null;
          return {
            name,
            utilization:
              latest && Number.isFinite(latest.utilization)
                ? latest.utilization
                : histories.length === 1
                  ? globalUsage
                  : null,
            memUsed: latest?.mem_used || 0,
            memTotal: latest?.mem_total || 0,
          } satisfies GPUDisplayDevice;
        })
        .filter((item): item is GPUDisplayDevice => item !== null);

      const seen = new Set<string>();
      return devices.filter((device) => {
        if (seen.has(device.name)) return false;
        seen.add(device.name);
        return true;
      });
    }

    const fallbackName = conciseGpuName(node.gpu_name);
    return fallbackName
      ? [{ name: fallbackName, utilization: globalUsage, memUsed: 0, memTotal: 0 }]
      : [];
  }, [gpuHistories, node.gpu_name, records]);

  const gpuNames = gpuDevices.map((g) => g.name).join(" · ");
  const gpuUsage = gpuDevices.length
    ? gpuDevices.map((g) => (g.utilization === null ? "—" : `${g.utilization.toFixed(1)}%`)).join(" · ")
    : "";
  const gpuMemory = gpuDevices.length
    ? gpuDevices
        .map((g) => (g.memTotal > 0 ? `${fmtBytes(g.memUsed)} / ${fmtBytes(g.memTotal)}` : t("sharedMemory")))
        .join(" · ")
    : "";

  const loadData = useMemo(
    () =>
      [...(records || [])]
        .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
        .map((r) => ({
          time: fmtTime(r.time, hours),
          cpu: Math.min(100, r.cpu),
          ram: fmtPercent(r.ram, r.ram_total || node.mem_total),
          up: r.net_out,
          down: r.net_in,
        })),
    [records, hours, node.mem_total],
  );

  const pct = (v: number) => `${v.toFixed(1)}%`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center fadein"
      style={{ background: mode === "day" ? "rgba(60,60,90,0.25)" : "rgba(0,0,10,0.5)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="glass-strong rounded-t-3xl sm:rounded-3xl w-full sm:w-[min(880px,94vw)] max-h-[92vh] sm:max-h-[88vh] overflow-y-auto p-5 sm:p-6 pop">
        <div className="flex items-center gap-2.5 mb-4">
          <Flag region={node.region} size={30} />
          <div className="flex-1 min-w-0">
            <div className="font-bold text-[18px] truncate">{node.name}</div>
            <div className="flex items-center gap-1.5 text-[12px] text-dim truncate">
              <img src={osIcon(node.os)} alt="" width={14} height={14} className="shrink-0 opacity-90" />
              <span className="truncate">
                {node.os} · {node.arch}
                {status?.online && <> · {t("uptime")} {fmtUptime(status.uptime, t)}</>}
              </span>
            </div>
          </div>
          <span className={`w-2.5 h-2.5 rounded-full ${status?.online ? "dot-online" : "dot-offline"}`} />
          <button
            onClick={onClose}
            className="ml-1 w-8 h-8 rounded-full grid place-items-center cursor-pointer hover:opacity-70 transition-opacity"
            style={{ background: "var(--chip)", border: "1px solid var(--glass-border)" }}
            aria-label="close"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 rounded-2xl p-3.5" style={{ background: "var(--chip)", border: "1px solid var(--glass-border)" }}>
          <MetaItem k="CPU" v={`${node.cpu_name} ×${node.cpu_cores}`} wrap />
          <MetaItem k={t("virtualization")} v={`${node.virtualization || "-"} / ${node.arch}`} />
          <MetaItem k={t("ram")} v={fmtBytes(node.mem_total)} />
          <MetaItem k={t("disk")} v={fmtBytes(node.disk_total)} />
          {gpuDevices.length > 0 && (
            <>
              <MetaItem k={t("gpu")} v={gpuNames} wrap />
              <MetaItem k={t("gpuUsage")} v={gpuUsage} />
              <MetaItem k={t("gpuMemory")} v={gpuMemory} />
            </>
          )}
          {node.price !== 0 && (
            <MetaItem
              k={t("price")}
              v={node.price < 0 ? t("free") : `${node.currency || "$"}${node.price} / ${fmtCycle(node.billing_cycle)}`}
            />
          )}
          {daysUntil(node.expired_at) !== null && (
            <MetaItem
              k={t("expire")}
              v={`${fmtDate(node.expired_at!)} · ${daysUntil(node.expired_at)! < 0 ? t("expired") : fmtDaysLeft(daysUntil(node.expired_at)!)}`}
            />
          )}
          {status?.online && (
            <>
              <MetaItem k={t("load")} v={`${status.load.toFixed(2)} / ${status.load5.toFixed(2)} / ${status.load15.toFixed(2)}`} />
              <MetaItem k={t("connections")} v={`${t("tcp")} ${status.connections} · ${t("udp")} ${status.connections_udp}`} />
              <MetaItem k={t("processes")} v={String(status.process)} />
              <MetaItem k={t("traffic")} v={`↑ ${fmtBytes(status.net_total_up)} ↓ ${fmtBytes(status.net_total_down)}`} />
            </>
          )}
        </div>

        <div className="flex gap-1.5 mb-3">
          {RANGES.map((r) => (
            <button
              key={r.hours}
              onClick={() => setHours(r.hours)}
              className="px-3.5 py-1.5 rounded-full text-[12.5px] font-medium cursor-pointer transition-all num"
              style={
                hours === r.hours
                  ? { background: "var(--accent)", color: "#fff", border: "1px solid transparent" }
                  : { background: "var(--chip)", border: "1px solid var(--glass-border)" }
              }
            >
              {r.label}
            </button>
          ))}
        </div>

        {records === null ? (
          <div className="text-center text-dim py-16">{t("loading")}</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ChartCard title={`${t("cpu")} %`}>
              <ResponsiveContainer>
                <AreaChart data={loadData} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gcpu" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#818cf8" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#818cf8" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={grid} vertical={false} />
                  <XAxis dataKey="time" tick={{ fill: axis, fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={38} />
                  <YAxis domain={[0, 100]} tick={{ fill: axis, fontSize: 10 }} tickLine={false} axisLine={false} width={38} />
                  <Tooltip content={<GlassTooltip fmt={pct} />} />
                  <Area type="monotone" dataKey="cpu" name="CPU" stroke="#818cf8" strokeWidth={2} fill="url(#gcpu)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={`${t("ram")} %`}>
              <ResponsiveContainer>
                <AreaChart data={loadData} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gram" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f472b6" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#f472b6" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={grid} vertical={false} />
                  <XAxis dataKey="time" tick={{ fill: axis, fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={38} />
                  <YAxis domain={[0, 100]} tick={{ fill: axis, fontSize: 10 }} tickLine={false} axisLine={false} width={38} />
                  <Tooltip content={<GlassTooltip fmt={pct} />} />
                  <Area type="monotone" dataKey="ram" name={t("ram")} stroke="#f472b6" strokeWidth={2} fill="url(#gram)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <div className="sm:col-span-2">
              <ChartCard title={t("netChart")}>
                <ResponsiveContainer>
                  <LineChart data={loadData} margin={{ top: 4, right: 4, left: -6, bottom: 0 }}>
                    <CartesianGrid stroke={grid} vertical={false} />
                    <XAxis dataKey="time" tick={{ fill: axis, fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={38} />
                    <YAxis tick={{ fill: axis, fontSize: 10 }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => fmtBytes(v)} />
                    <Tooltip content={<GlassTooltip fmt={fmtSpeed} />} />
                    <Line type="monotone" dataKey="up" name={`↑ ${t("upload")}`} stroke="#fb7185" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="down" name={`↓ ${t("download")}`} stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

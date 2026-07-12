import type { PingStat, PingTask } from "./api";

export const LATENCY_SELECTION_STORAGE_KEY = "tasogare.latencySelections.v1";
export const MAX_LATENCY_SELECTIONS = 3;

export interface LatencySelection {
  taskId: number;
  alias: string;
}

export interface ResolvedLatencySelection extends LatencySelection {
  task: PingTask;
  label: string;
  color: string;
  typeLabel: string;
  shortTypeLabel: string;
}

const COLORS = [
  "#fb7185",
  "#60a5fa",
  "#34d399",
  "#f59e0b",
  "#a78bfa",
  "#22d3ee",
  "#f472b6",
  "#84cc16",
  "#fb923c",
  "#2dd4bf",
  "#818cf8",
  "#e879f9",
];

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export function latencyTaskType(task: PingTask): "tcp" | "icmp" | "http" | "other" {
  const explicit = normalize(task.type || "");
  if (explicit === "tcp") return "tcp";
  if (explicit === "icmp") return "icmp";
  if (explicit === "http" || explicit === "https") return "http";

  const name = normalize(task.name || "");
  if (/tcp\s*ping|tcping|\btcp\b/.test(name)) return "tcp";
  if (/icmp|(^|\s)ping($|\s)/.test(name)) return "icmp";
  if (/https?|web/.test(name)) return "http";
  return "other";
}

export function latencyTaskTypeLabel(task: PingTask): string {
  const type = latencyTaskType(task);
  if (type === "tcp") return "TCPing";
  if (type === "icmp") return "ICMP";
  if (type === "http") return "HTTP";
  return String(task.type || "Other").toUpperCase();
}

export function latencyTaskShortTypeLabel(task: PingTask): string {
  const type = latencyTaskType(task);
  if (type === "tcp") return "TCP";
  if (type === "icmp") return "ICMP";
  if (type === "http") return "HTTP";
  return String(task.type || "OTHER").toUpperCase().slice(0, 5);
}

export function latencyPanelTitle(selections: ResolvedLatencySelection[], zh = false): string {
  const types = new Set(selections.map((item) => latencyTaskType(item.task)));
  if (types.size !== 1) return zh ? "延迟监测" : "Latency";
  const type = Array.from(types)[0];
  if (type === "tcp") return "TCPing";
  if (type === "icmp") return "Ping";
  if (type === "http") return "HTTP";
  return zh ? "延迟监测" : "Latency";
}

export function simplifyTaskName(name: string): string {
  const cleaned = String(name || "")
    .replace(/(?:tcp\s*ping|tcping|icmp|https?|ping|tcp)\b/gi, "")
    .replace(/[\-_–—|/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || name || "Latency";
}


export function compactTaskName(name: string): string {
  const simplified = simplifyTaskName(name);
  const carriers: Array<[RegExp, string]> = [
    [/(?:中国)?联通|china\s*unicom|unicom|cucc/gi, "CU"],
    [/(?:中国)?电信|china\s*telecom|telecom|ctcc|chinanet|cn2/gi, "CT"],
    [/(?:中国)?移动|china\s*mobile|mobile|cmcc|cmin2|cmi/gi, "CM"],
  ];

  for (const [pattern, abbreviation] of carriers) {
    if (!pattern.test(simplified)) continue;
    pattern.lastIndex = 0;
    const region = simplified
      .replace(pattern, "")
      .replace(/[·•\s_\-/|]+/g, " ")
      .trim();
    return region ? `${region}·${abbreviation}` : abbreviation;
  }
  return simplified;
}

export function taskAppliesToNode(task: PingTask, uuid: string): boolean {
  const clients = Array.isArray(task.clients) ? task.clients.filter(Boolean) : [];
  if (clients.includes(uuid)) return true;
  if (task.default_on === true) return true;
  return clients.length === 0;
}

export function parseThemeSelections(
  idsRaw: unknown,
  aliasesRaw: unknown,
  tasks: PingTask[],
): LatencySelection[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const byName = new Map(tasks.map((task) => [normalize(task.name), task]));
  const tokens = String(idsRaw || "")
    .split(/[,，;；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_LATENCY_SELECTIONS);
  const aliases = String(aliasesRaw || "")
    .split(/[,，;；\n]+/)
    .map((item) => item.trim());

  const output: LatencySelection[] = [];
  const seen = new Set<number>();
  tokens.forEach((token, index) => {
    const numericId = Number(token);
    const task = Number.isFinite(numericId) ? byId.get(numericId) : byName.get(normalize(token));
    if (!task || seen.has(task.id)) return;
    seen.add(task.id);
    output.push({ taskId: task.id, alias: aliases[index] || "" });
  });
  return output;
}

export function sanitizeSelections(
  selections: LatencySelection[],
  tasks: PingTask[],
): LatencySelection[] {
  const ids = new Set(tasks.map((task) => task.id));
  const seen = new Set<number>();
  const output: LatencySelection[] = [];
  for (const item of selections || []) {
    const taskId = Number(item?.taskId);
    if (!Number.isFinite(taskId) || !ids.has(taskId) || seen.has(taskId)) continue;
    seen.add(taskId);
    output.push({ taskId, alias: String(item?.alias || "").trim().slice(0, 24) });
    if (output.length >= MAX_LATENCY_SELECTIONS) break;
  }
  return output;
}

export function resolveSelections(
  selections: LatencySelection[],
  tasks: PingTask[],
): ResolvedLatencySelection[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return sanitizeSelections(selections, tasks)
    .map((selection, index) => {
      const task = byId.get(selection.taskId);
      if (!task) return null;
      const label = selection.alias || compactTaskName(task.name);
      return {
        ...selection,
        task,
        label,
        color: COLORS[index % COLORS.length],
        typeLabel: latencyTaskTypeLabel(task),
        shortTypeLabel: latencyTaskShortTypeLabel(task),
      } satisfies ResolvedLatencySelection;
    })
    .filter((item): item is ResolvedLatencySelection => item !== null);
}


export function resolveAllTasks(tasks: PingTask[]): ResolvedLatencySelection[] {
  return [...tasks]
    .sort((a, b) => (Number(a.weight) || 0) - (Number(b.weight) || 0) || a.id - b.id)
    .map((task, index) => ({
      taskId: task.id,
      alias: "",
      task,
      label: simplifyTaskName(task.name),
      color: COLORS[index % COLORS.length],
      typeLabel: latencyTaskTypeLabel(task),
      shortTypeLabel: latencyTaskShortTypeLabel(task),
    }));
}

export function findLiveStat(
  ping: Record<string, PingStat> | undefined,
  task: PingTask,
): PingStat | undefined {
  if (!ping) return undefined;
  const byId = ping[String(task.id)];
  if (byId) return byId;
  const target = normalize(task.name || "");
  return Object.values(ping).find((stat) => normalize(stat.name || "") === target);
}

export function readStoredSelections(): LatencySelection[] | null {
  try {
    const raw = localStorage.getItem(LATENCY_SELECTION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredSelections(selections: LatencySelection[]): void {
  try {
    localStorage.setItem(LATENCY_SELECTION_STORAGE_KEY, JSON.stringify(selections));
  } catch {
    // localStorage can be unavailable in private or restricted contexts.
  }
}

export function clearStoredSelections(): void {
  try {
    localStorage.removeItem(LATENCY_SELECTION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

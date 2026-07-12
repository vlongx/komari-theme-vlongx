import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { PingTask } from "../lib/api";
import {
  MAX_LATENCY_SELECTIONS,
  latencyTaskTypeLabel,
  simplifyTaskName,
  type LatencySelection,
} from "../lib/latencySelection";

const isZh =
  typeof navigator !== "undefined" &&
  (navigator.language || "").toLowerCase().startsWith("zh");

interface Props {
  open: boolean;
  tasks: PingTask[];
  value: LatencySelection[];
  themeDefaults: LatencySelection[];
  onClose: () => void;
  onSave: (value: LatencySelection[]) => void;
  onUseThemeDefaults: () => void;
}

function sortTasks(tasks: PingTask[]): PingTask[] {
  return [...tasks].sort(
    (a, b) =>
      (Number(a.weight) || 0) - (Number(b.weight) || 0) ||
      a.name.localeCompare(b.name, "zh-CN"),
  );
}

export default function LatencyTaskSelector({
  open,
  tasks,
  value,
  themeDefaults,
  onClose,
  onSave,
  onUseThemeDefaults,
}: Props) {
  const [draft, setDraft] = useState<LatencySelection[]>(value);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setDraft(value);
      setQuery("");
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const visibleTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = sortTasks(tasks);
    if (!q) return sorted;
    return sorted.filter((task) =>
      `${task.name} ${task.type || ""} ${task.target || ""}`.toLowerCase().includes(q),
    );
  }, [tasks, query]);

  if (!open || typeof document === "undefined") return null;

  const selectedIds = new Set(draft.map((item) => item.taskId));

  const toggleTask = (task: PingTask) => {
    if (selectedIds.has(task.id)) {
      setDraft((current) => current.filter((item) => item.taskId !== task.id));
      return;
    }
    if (draft.length >= MAX_LATENCY_SELECTIONS) return;
    setDraft((current) => [...current, { taskId: task.id, alias: simplifyTaskName(task.name) }]);
  };

  const move = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draft.length) return;
    setDraft((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  return createPortal(
    <div className="latency-selector-backdrop" onMouseDown={onClose}>
      <div
        className="latency-selector-modal glass-strong"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isZh ? "首页延迟监测设置" : "Homepage latency settings"}
      >
        <div className="latency-selector-header">
          <div>
            <strong>{isZh ? "首页延迟监测" : "Homepage latency"}</strong>
            <p>
              {isZh
                ? "从 Komari 已创建的延迟任务中自由选择 0～3 项。每个展示项只读取一个明确任务，不做跨城市平均。"
                : "Choose 0–3 existing Komari latency tasks. Each row maps to one exact task, with no cross-task averaging."}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="close">×</button>
        </div>

        <div className="latency-selector-counter">
          <span>{isZh ? "已选择" : "Selected"}</span>
          <strong>{draft.length}/{MAX_LATENCY_SELECTIONS}</strong>
          <small>{isZh ? "选择 0 项会隐藏首页延迟模块" : "Select 0 to hide the card module"}</small>
        </div>

        <div className="latency-selector-selected">
          {draft.length === 0 ? (
            <div className="latency-selector-empty">
              {isZh ? "当前不显示任何延迟监测项" : "No latency task will be shown"}
            </div>
          ) : (
            draft.map((item, index) => {
              const task = tasks.find((candidate) => candidate.id === item.taskId);
              if (!task) return null;
              return (
                <div key={item.taskId} className="latency-selector-slot">
                  <div className="latency-selector-slot-order">{index + 1}</div>
                  <div className="latency-selector-slot-main">
                    <div className="latency-selector-slot-task">
                      <span>{task.name}</span>
                      <em>{latencyTaskTypeLabel(task)}</em>
                    </div>
                    <input
                      value={item.alias}
                      maxLength={24}
                      onChange={(event) =>
                        setDraft((current) =>
                          current.map((entry) =>
                            entry.taskId === item.taskId
                              ? { ...entry, alias: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      placeholder={isZh ? "首页显示名称" : "Display label"}
                    />
                  </div>
                  <div className="latency-selector-slot-actions">
                    <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                    <button type="button" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>↓</button>
                    <button type="button" onClick={() => toggleTask(task)}>×</button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="latency-selector-search-row">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={isZh ? "搜索任务名称、类型或目标…" : "Search task, type or target…"}
          />
          <button type="button" onClick={() => setDraft([])}>
            {isZh ? "清空" : "Clear"}
          </button>
        </div>

        <div className="latency-selector-task-list">
          {visibleTasks.length === 0 ? (
            <div className="latency-selector-empty">{isZh ? "没有匹配的延迟任务" : "No matching tasks"}</div>
          ) : (
            visibleTasks.map((task) => {
              const checked = selectedIds.has(task.id);
              const disabled = !checked && draft.length >= MAX_LATENCY_SELECTIONS;
              return (
                <button
                  key={task.id}
                  type="button"
                  className={`latency-selector-task ${checked ? "is-selected" : ""}`}
                  disabled={disabled}
                  onClick={() => toggleTask(task)}
                >
                  <span className="latency-selector-check">{checked ? "✓" : ""}</span>
                  <span className="latency-selector-task-copy">
                    <strong>{task.name}</strong>
                    <small>{task.target || (isZh ? "未填写目标" : "No target")}</small>
                  </span>
                  <em>{latencyTaskTypeLabel(task)}</em>
                </button>
              );
            })
          )}
        </div>

        <div className="latency-selector-footer">
          <button
            type="button"
            className="latency-selector-secondary"
            onClick={() => {
              onUseThemeDefaults();
              onClose();
            }}
          >
            {isZh ? "恢复主题默认" : "Use theme defaults"}
          </button>
          <div>
            <button type="button" className="latency-selector-secondary" onClick={onClose}>
              {isZh ? "取消" : "Cancel"}
            </button>
            <button
              type="button"
              className="latency-selector-primary"
              onClick={() => onSave(draft)}
            >
              {isZh ? "保存" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

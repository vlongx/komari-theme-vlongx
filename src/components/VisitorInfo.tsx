import { useEffect, useMemo, useState } from "react";
import { t } from "../lib/i18n";

interface Props {
  enabled: boolean;
  endpoint?: string;
}

interface VisitorState {
  ip: string;
  loading: boolean;
  failed: boolean;
}

const DEFAULT_ENDPOINT = "https://api64.ipify.org?format=json";

function extractIp(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  for (const key of ["ip", "query", "address", "client_ip"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

export default function VisitorInfo({ enabled, endpoint }: Props) {
  const [state, setState] = useState<VisitorState>({ ip: "", loading: false, failed: false });
  const source = useMemo(() => (endpoint || "").trim() || DEFAULT_ENDPOINT, [endpoint]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    const timeout = window.setTimeout(() => controller.abort(), 7000);
    setState({ ip: "", loading: true, failed: false });

    fetch(source, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`visitor ip: ${response.status}`);
        const contentType = response.headers.get("content-type") || "";
        return contentType.includes("application/json") ? response.json() : response.text();
      })
      .then((payload) => {
        const ip = extractIp(payload);
        if (!ip) throw new Error("visitor ip missing");
        setState({ ip, loading: false, failed: false });
      })
      .catch(() => {
        if (!disposed) setState({ ip: "", loading: false, failed: true });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [enabled, source]);

  if (!enabled) return null;
  const ipType = state.ip.includes(":") ? "IPv6" : state.ip ? "IPv4" : "";

  return (
    <div className="visitor-ip glass" aria-live="polite">
      <span className="visitor-ip-icon" aria-hidden>◎</span>
      <span className="visitor-ip-label">{t("visitorIp")}</span>
      <strong className="visitor-ip-value num">
        {state.loading ? t("loadingShort") : state.failed ? t("unavailable") : state.ip}
      </strong>
      {ipType && <span className="visitor-ip-type">{ipType}</span>}
    </div>
  );
}

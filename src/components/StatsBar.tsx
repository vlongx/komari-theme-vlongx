import { useEffect, useMemo, useState } from "react";
import type { LatestStatus, NodeInfo } from "../lib/api";
import {
  calculateFinanceSummary,
  CURRENCIES,
  CURRENCY_SYMBOLS,
  DEFAULT_EXCHANGE_RATES,
  convertFromCNY,
  formatMoney,
  getDailyExchangeRates,
  getStoredCurrency,
  storeCurrency,
  type CurrencyCode,
  type ExchangeRates,
} from "../lib/finance";
import { fmtBytes, fmtSpeed } from "../lib/format";
import { t } from "../lib/i18n";

interface Props {
  nodes: NodeInfo[];
  latest: Record<string, LatestStatus>;
}

function Item({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[11px] tracking-wide text-dim">{label}</span>
      <span className="text-[15px] font-semibold num whitespace-nowrap">
        {children}
      </span>
    </div>
  );
}

function FinanceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="finance-metric min-w-0">
      <span>{label}</span>
      <strong className="num">{value}</strong>
    </div>
  );
}

function FinanceSummary({ nodes }: { nodes: NodeInfo[] }) {
  const [rates, setRates] = useState<ExchangeRates>(DEFAULT_EXCHANGE_RATES);
  const [currency, setCurrency] = useState<CurrencyCode>(() => getStoredCurrency());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    getDailyExchangeRates().then((next) => {
      if (active) setRates(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const summary = useMemo(() => calculateFinanceSummary(nodes, rates), [nodes, rates]);
  const symbol = CURRENCY_SYMBOLS[currency];
  const display = (valueCNY: number) =>
    `${symbol}${formatMoney(convertFromCNY(valueCNY, currency, rates), currency)}`;

  const selectCurrency = (next: CurrencyCode) => {
    setCurrency(next);
    storeCurrency(next);
  };

  return (
    <div
      className="finance-summary relative min-w-0"
      tabIndex={0}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onClick={() => setOpen((value) => !value)}
      aria-label={t("remainingValue")}
    >
      <span className="text-[11px] tracking-wide text-dim">{t("remainingValue")}</span>
      <span className="text-[15px] font-semibold num whitespace-nowrap finance-summary-value">
        {display(summary.remainingValueCNY)}
        <small>{currency}</small>
      </span>

      <div
        className={`finance-popover glass-strong ${open ? "is-open" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="finance-overview-grid">
          <FinanceMetric label={t("totalValue")} value={display(summary.totalValueCNY)} />
          <FinanceMetric label={t("monthlyCost")} value={display(summary.monthlyCostCNY)} />
          <FinanceMetric label={t("remainingValue")} value={display(summary.remainingValueCNY)} />
        </div>

        <div className="finance-rate-heading">
          <span>{t("todayRates")}</span>
          <select
            value={currency}
            onChange={(event) => selectCurrency(event.target.value as CurrencyCode)}
            aria-label={t("displayCurrency")}
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>

        <div className="finance-rate-grid">
          {CURRENCIES.map((code) => (
            <div className="finance-rate-row" key={code}>
              <span>{code}</span>
              <strong className="num">
                {CURRENCY_SYMBOLS[code]}
                {(rates[code] || 0).toFixed(6)}
              </strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function StatsBar({ nodes, latest }: Props) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const online = nodes.filter((n) => latest[n.uuid]?.online);
  const regions = new Set(nodes.map((n) => n.region || "🏳️")).size;
  let up = 0,
    down = 0,
    totalUp = 0,
    totalDown = 0;
  for (const n of nodes) {
    const s = latest[n.uuid];
    if (!s) continue;
    totalUp += s.net_total_up;
    totalDown += s.net_total_down;
    if (s.online) {
      up += s.net_out;
      down += s.net_in;
    }
  }

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  return (
    <div className="glass stats-bar rounded-2xl px-5 py-3.5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-3">
      <Item label={t("currentTime")}>
        {hh}:{mm}
        <span className="text-dim">:{ss}</span>
      </Item>
      <Item label={t("currentOnline")}>
        <span style={{ color: "#34d399" }}>{online.length}</span>
        <span className="text-dim"> / {nodes.length}</span>
      </Item>
      <Item label={t("regions")}>{regions}</Item>
      <FinanceSummary nodes={nodes} />
      <Item label={t("totalTraffic")}>
        <span className="text-dim text-[13px]">↑</span> {fmtBytes(totalUp)}{" "}
        <span className="text-dim text-[13px]">↓</span> {fmtBytes(totalDown)}
      </Item>
      <Item label={t("netSpeed")}>
        <span className="text-dim text-[13px]">↑</span> {fmtSpeed(up)}{" "}
        <span className="text-dim text-[13px]">↓</span> {fmtSpeed(down)}
      </Item>
    </div>
  );
}

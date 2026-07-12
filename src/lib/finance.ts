import type { NodeInfo } from "./api";

export type CurrencyCode = "CNY" | "USD" | "HKD" | "EUR" | "GBP" | "JPY";
export type ExchangeRates = Record<CurrencyCode, number>;

interface ExchangeRatesCache {
  base: "CNY";
  date: string;
  rates: Partial<Record<CurrencyCode, number>>;
}

const CACHE_KEY = "tasogare_finance_exchange_rates_cny_v1";
const CURRENCY_KEY = "tasogare_finance_currency";
const MS_PER_DAY = 86400000;
const LONG_TERM_YEARS = 100;

export const CURRENCIES: CurrencyCode[] = ["CNY", "USD", "HKD", "EUR", "GBP", "JPY"];

export const DEFAULT_EXCHANGE_RATES: ExchangeRates = {
  CNY: 1,
  USD: 0.142536,
  HKD: 1.108377,
  EUR: 0.12102,
  GBP: 0.105581,
  JPY: 22.231552,
};

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  CNY: "¥",
  USD: "$",
  HKD: "HK$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

const EXCHANGE_RATE_APIS = [
  {
    url: "https://open.er-api.com/v6/latest/CNY",
    parse: (data: unknown) => (data as { rates?: unknown }).rates,
  },
  {
    url: "https://api.frankfurter.app/latest?from=CNY",
    parse: (data: unknown) => (data as { rates?: unknown }).rates,
  },
] as const;

export function normalizeCurrency(currency: string | null | undefined): CurrencyCode {
  const value = String(currency || "CNY").trim().toUpperCase();
  if (value === "USD" || value === "$") return "USD";
  if (value === "HKD" || value === "HK$") return "HKD";
  if (value === "EUR" || value === "€") return "EUR";
  if (value === "GBP" || value === "£") return "GBP";
  if (value === "JPY" || value === "JP¥") return "JPY";
  return "CNY";
}

function dateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sanitizeRates(input: unknown): ExchangeRates | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const result = { CNY: 1 } as ExchangeRates;
  for (const code of CURRENCIES) {
    if (code === "CNY") continue;
    const value = Number(record[code]);
    if (!Number.isFinite(value) || value <= 0) return null;
    result[code] = value;
  }
  return result;
}

function readCache(): { date: string; rates: ExchangeRates } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ExchangeRatesCache;
    if (parsed.base !== "CNY" || !parsed.date) return null;
    const rates = sanitizeRates(parsed.rates);
    return rates ? { date: parsed.date, rates } : null;
  } catch {
    return null;
  }
}

function writeCache(rates: ExchangeRates): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ base: "CNY", date: dateKey(), rates } satisfies ExchangeRatesCache),
    );
  } catch {
    /* localStorage can be unavailable in privacy modes */
  }
}

async function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function getDailyExchangeRates(): Promise<ExchangeRates> {
  const cached = readCache();
  if (cached?.date === dateKey()) return cached.rates;

  for (const api of EXCHANGE_RATE_APIS) {
    try {
      const response = await fetchWithTimeout(api.url);
      if (!response.ok) continue;
      const payload = await response.json();
      const rates = sanitizeRates(api.parse(payload));
      if (rates) {
        writeCache(rates);
        return rates;
      }
    } catch {
      /* try the next endpoint */
    }
  }

  return cached?.rates || DEFAULT_EXCHANGE_RATES;
}

export function getStoredCurrency(): CurrencyCode {
  try {
    return normalizeCurrency(localStorage.getItem(CURRENCY_KEY));
  } catch {
    return "CNY";
  }
}

export function storeCurrency(currency: CurrencyCode): void {
  try {
    localStorage.setItem(CURRENCY_KEY, currency);
  } catch {
    /* ignore */
  }
}

export function priceCNY(node: NodeInfo, rates: ExchangeRates): number {
  const price = Number(node.price);
  if (!Number.isFinite(price) || price <= 0) return 0;
  const currency = normalizeCurrency(node.currency);
  return currency === "CNY" ? price : price / rates[currency];
}

export function remainingValueCNY(node: NodeInfo, rates: ExchangeRates, now = new Date()): number {
  const price = priceCNY(node, rates);
  if (price <= 0 || !node.expired_at) return 0;

  const expires = new Date(node.expired_at).getTime();
  if (!Number.isFinite(expires)) return 0;
  const diffMs = expires - now.getTime();
  if (diffMs <= 0) return 0;

  if (diffMs / (MS_PER_DAY * 365) > LONG_TERM_YEARS) return price;

  const cycle = Number(node.billing_cycle);
  if (!Number.isFinite(cycle) || cycle <= 0) return price;

  const remainingDays = Math.ceil(diffMs / MS_PER_DAY);
  return price * Math.min(remainingDays / cycle, 1);
}

export function monthlyCostCNY(node: NodeInfo, rates: ExchangeRates): number {
  const price = priceCNY(node, rates);
  if (price <= 0) return 0;
  const cycle = Number(node.billing_cycle);
  if (!Number.isFinite(cycle) || cycle <= 0) return price;
  return (price / cycle) * 30;
}

export function calculateFinanceSummary(nodes: NodeInfo[], rates: ExchangeRates) {
  return nodes.reduce(
    (result, node) => {
      result.totalValueCNY += priceCNY(node, rates);
      result.monthlyCostCNY += monthlyCostCNY(node, rates);
      result.remainingValueCNY += remainingValueCNY(node, rates);
      return result;
    },
    { totalValueCNY: 0, monthlyCostCNY: 0, remainingValueCNY: 0 },
  );
}

export function convertFromCNY(value: number, currency: CurrencyCode, rates: ExchangeRates): number {
  return value * (rates[currency] || 1);
}

export function formatMoney(value: number, currency: CurrencyCode): string {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safe);
}

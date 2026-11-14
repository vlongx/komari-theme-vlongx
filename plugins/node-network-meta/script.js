// Optional Komari server-side node metadata plugin.
// Private node addresses remain inside Komari and are never returned to visitors.
const server = require("server");
const ROUTE = "/api/vlongx/node-network-meta";
const PROVIDER = "https://api.ipapi.is/?q=";
const META_TTL = 12 * 60 * 60 * 1000;
const ERROR_TTL = 30 * 60 * 1000;
const MAX_NODES = 300;
const MAX_CONCURRENT_LOOKUPS = 5;
let snapshot = null;
let refreshPromise = null;
const ipCache = new Map();

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\x00-\x1f\x7f]/g, " ").slice(0, maxLength);
}

function publicIPv4(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 2 || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) return false;
  if (a === 198 && (b === 18 || b === 19) || a === 192 && b === 0 && c === 0) return false;
  return true;
}

function publicIPv6(value) {
  if (typeof value !== "string" || value.length > 45 || !value.includes(":")) return false;
  if (!/^[0-9a-fA-F:]+$/.test(value)) return false;
  const normalized = value.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")) return false;
  if (/^2001:0?db8(?::|$)/.test(normalized)) return false;
  return /^(2|3)[0-9a-f]{0,3}:/.test(normalized);
}

function safeIP(raw, family) {
  if (typeof raw !== "string") return "";
  const first = raw.trim().split(/[\s,;/]+/)[0];
  if (family === 4 && publicIPv4(first)) return first;
  if (family === 6 && publicIPv6(first)) return first;
  return "";
}

function normalizeLookup(data) {
  if (!data || typeof data !== "object" || data.error || data.is_bogon === true) return { asn: "", country: "" };
  let asn = "";
  if (typeof data.asn === "string") asn = data.asn;
  else if (data.asn && typeof data.asn === "object") {
    const n = data.asn.asn || data.asn.number || data.asn.num;
    const org = cleanText(data.asn.org || data.asn.descr || "", 110);
    asn = n ? ("AS" + String(n).replace(/^AS/i, "") + " " + org).trim() : "";
  }
  return { asn: cleanText(asn, 180), country: cleanText(data.country || (data.location && data.location.country) || "", 96) };
}

async function lookupIP(ip) {
  if (!ip) return { asn: "", country: "" };
  const cached = ipCache.get(ip);
  if (cached && cached.expires > Date.now()) return cached.info;
  let info = { asn: "", country: "" };
  let ttl = ERROR_TTL;
  try {
    const response = await fetch(PROVIDER + encodeURIComponent(ip), { headers: { Accept: "application/json" } });
    if (response.ok) {
      info = normalizeLookup(await response.json());
      if (info.asn || info.country) ttl = META_TTL;
    }
  } catch (_) {
    // Never log or return private node addresses.
  }
  ipCache.set(ip, { info, expires: Date.now() + ttl });
  return info;
}

async function refresh() {
  // Plugin calls registered Komari RPC as admin; no API key is embedded in JS.
  const nodes = await server.call("common:getNodes", {});
  const list = Object.values(nodes || {}).filter((n) => n && !n.hidden && typeof n.uuid === "string").slice(0, MAX_NODES);
  const ips = [];
  const byUUID = new Map();
  for (const node of list) {
    const v4 = safeIP(node.ipv4, 4);
    const v6 = safeIP(node.ipv6, 6);
    byUUID.set(node.uuid, { v4, v6 });
    if (v4 && !ips.includes(v4)) ips.push(v4);
    if (v6 && !ips.includes(v6)) ips.push(v6);
  }
  const results = new Map();
  let next = 0;
  async function worker() {
    while (next < ips.length) {
      const ip = ips[next++];
      results.set(ip, await lookupIP(ip));
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_LOOKUPS, ips.length) }, worker));
  const output = Object.create(null);
  for (const [uuid, address] of byUUID) {
    const g4 = results.get(address.v4) || {};
    const g6 = results.get(address.v6) || {};
    const a4 = g4.asn || "";
    const a6 = g6.asn || "";
    const asn = a4 && a6 && a4 !== a6 ? a4 + " · " + a6 : a4 || a6 || "";
    output[uuid] = {
      asn: asn.slice(0, 360),
      ipv4_country: g4.country || "",
      ipv6_country: g6.country || ""
    };
  }
  // Aggregate diagnostics never include node addresses or identifiers.
  const values = Object.values(output);
  const diagnostics = {
    visible_nodes: list.length,
    nodes_with_public_ip: Array.from(byUUID.values()).filter((entry) => entry.v4 || entry.v6).length,
    nodes_with_asn: values.filter((value) => value.asn).length,
    nodes_with_country: values.filter((value) => value.ipv4_country || value.ipv6_country).length
  };
  snapshot = { nodes: output, diagnostics, updated_at: new Date().toISOString(), expires: Date.now() + META_TTL };
  return snapshot;
}

function getSnapshot() {
  if (snapshot && snapshot.expires > Date.now()) return Promise.resolve(snapshot);
  if (!refreshPromise) refreshPromise = refresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function respond(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // No HTTP shared caching: private-site authentication and Hidden nodes can change.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const settings = await server.call("public:getPublicSettings", {});
    // A private-site owner must not expose node metadata to guest viewers.
    if (settings && settings.private_site) {
      const principal = req && req.context && req.context.principal;
      const roles = principal && Array.isArray(principal.roles) ? principal.roles : [];
      const isAdmin = roles.some((role) => String(role).toLowerCase() === "admin") ||
        String(req && req.context && req.context.role || "").toLowerCase() === "admin";
      if (!isAdmin) {
        res.end(JSON.stringify({ nodes: {}, disabled: "private_site" }));
        return;
      }
    }
    // Verify each node remains public before responding, even if the ASN cache is warm.
    const currentlyVisible = await server.call("common:getNodes", {});
    const allowed = new Set(
      Object.values(currentlyVisible || {})
        .filter((node) => node && !node.hidden && typeof node.uuid === "string")
        .map((node) => node.uuid)
    );
    const info = await getSnapshot();
    const publicNodes = Object.create(null);
    for (const uuid of Object.keys(info.nodes)) {
      if (allowed.has(uuid)) publicNodes[uuid] = info.nodes[uuid];
    }
    res.end(JSON.stringify({
      nodes: publicNodes,
      status: info.diagnostics.nodes_with_country || info.diagnostics.nodes_with_asn
        ? "ok" : info.diagnostics.nodes_with_public_ip ? "lookup_unavailable" : "no_public_ip",
      diagnostics: info.diagnostics,
      updated_at: info.updated_at
    }));
  } catch (error) {
    // Fail closed on any authorization, RPC or provider failure. Log category only.
    console.error("[vlongx-node-network-meta] node metadata refresh failed");
    res.statusCode = 503;
    res.end(JSON.stringify({ nodes: {}, error: "metadata_unavailable" }));
  }
}

function load() {
  server.route("GET", ROUTE, respond);
  console.log("[vlongx-node-network-meta] read-only metadata route registered");
}

function unload() {
  snapshot = null;
  ipCache.clear();
}

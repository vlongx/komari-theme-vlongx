import { useEffect, useState } from "react";

export interface NetworkMetadata {
  asn?: string;
  ipv4_country?: string;
  ipv6_country?: string;
}

type NodeMetadataMap = Record<string, NetworkMetadata>;

const ENDPOINT = "/api/vlongx/node-network-meta";
const REFRESH_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 1000;

let cache: NodeMetadataMap = {};
let expires = 0;
let pending: Promise<NodeMetadataMap> | null = null;

function getMetadata(): Promise<NodeMetadataMap> {
  if (Date.now() < expires) return Promise.resolve(cache);
  if (pending) return pending;
  pending = fetch(ENDPOINT, { credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error("network metadata endpoint unavailable");
      return response.json() as Promise<{ nodes?: NodeMetadataMap }>;
    })
    .then((payload) => {
      const data = payload.nodes && typeof payload.nodes === "object" ? payload.nodes : {};
      cache = data;
      expires = Date.now() + (Object.keys(cache).length ? REFRESH_MS : RETRY_MS);
      return cache;
    })
    .catch(() => {
      // The server-side plugin is optional; retain v2.2.5 fallback labels.
      expires = Date.now() + RETRY_MS;
      return cache;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function useNodeNetworkMetadata(uuid: string): NetworkMetadata | null {
  const [metadata, setMetadata] = useState<NetworkMetadata | null>(() => cache[uuid] ?? null);

  useEffect(() => {
    let active = true;
    const update = () => {
      getMetadata().then((items) => {
        if (active) setMetadata(items[uuid] || null);
      });
    };
    update();
    const interval = window.setInterval(update, RETRY_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [uuid]);

  return metadata;
}

/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

const AGENT_NETWORK_FILTER_STORAGE_KEY = "cocalc-agents-network-filter-v1";

export function readAgentNetworkFilter(
  search = typeof window === "undefined" ? "" : window.location.search,
): string | undefined {
  const fromUrl = new URLSearchParams(search).get("network");
  if (fromUrl) return fromUrl;
  if (typeof window === "undefined") return undefined;
  try {
    return (
      window.localStorage.getItem(AGENT_NETWORK_FILTER_STORAGE_KEY) || undefined
    );
  } catch {
    return undefined;
  }
}

export function rememberAgentNetworkFilter(networkId?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (networkId) {
      window.localStorage.setItem(AGENT_NETWORK_FILTER_STORAGE_KEY, networkId);
    } else {
      window.localStorage.removeItem(AGENT_NETWORK_FILTER_STORAGE_KEY);
    }
  } catch {
    // URL state still works when localStorage is unavailable.
  }
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type { Client } from "@cocalc/conat/core/client";
import { sysApiMany } from "@cocalc/conat/core/sys";
import type { ConatServer } from "@cocalc/conat/core/server";
import type { ConnectionStats } from "@cocalc/conat/core/types";

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_IDLE_LOG_INTERVALS = 6;
const DEFAULT_BROWSER_BURST_THRESHOLD = 6;
const DEFAULT_ADDRESS_BURST_THRESHOLD = 12;
const TOP_LIMIT = 5;

type ConnectionStatsSnapshot = { [id: string]: ConnectionStats };

async function loadClusterStatsSnapshot({
  conatServer,
  systemClient,
}: {
  conatServer: ConatServer;
  systemClient?: Client;
}): Promise<ConnectionStatsSnapshot> {
  if (!systemClient) {
    return conatServer.getStatsSnapshot();
  }
  try {
    if (!systemClient.isSignedIn()) {
      await systemClient.waitUntilSignedIn({ timeout: 5000 });
    }
    if (!systemClient.isSignedIn()) {
      return conatServer.getStatsSnapshot();
    }
    const responses = await sysApiMany(systemClient, {
      maxWait: 2000,
      maxMessages: 64,
    }).stats();
    const snapshot: ConnectionStatsSnapshot = {};
    for (const response of responses ?? []) {
      for (const socketStatsById of Object.values(response ?? {})) {
        Object.assign(snapshot, socketStatsById ?? {});
      }
    }
    return Object.keys(snapshot).length > 0
      ? snapshot
      : conatServer.getStatsSnapshot();
  } catch {
    return conatServer.getStatsSnapshot();
  }
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function diffCounter(
  current: number | undefined,
  previous: number | undefined,
) {
  const currentValue = Number.isFinite(current) ? Math.max(0, current ?? 0) : 0;
  const previousValue = Number.isFinite(previous)
    ? Math.max(0, previous ?? 0)
    : 0;
  return currentValue >= previousValue
    ? currentValue - previousValue
    : currentValue;
}

function roundRate(value: number, intervalMs: number): number {
  if (intervalMs <= 0) return 0;
  return Math.round((value * 10_000) / intervalMs) / 10;
}

function topOpenedCounts(
  counts: Map<string, number>,
  key: string,
): Array<Record<string, number | string>> {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_LIMIT)
    .map(([value, connections]) => ({
      [key]: value,
      connections,
    }));
}

function incrementCount(counts: Map<string, number>, key: string | undefined) {
  const value = `${key ?? ""}`.trim();
  if (!value) return;
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

export function summarizeConatRouterTraffic({
  previous,
  current,
  intervalMs,
}: {
  previous: ConnectionStatsSnapshot;
  current: ConnectionStatsSnapshot;
  intervalMs: number;
}) {
  const previousIds = new Set(Object.keys(previous));
  const uniqueAddresses = new Set<string>();
  const uniqueBrowsers = new Set<string>();
  const uniqueAccounts = new Set<string>();
  const uniqueProjects = new Set<string>();
  const uniqueHubs = new Set<string>();
  const openedByBrowser = new Map<string, number>();
  const openedByAddress = new Map<string, number>();

  let openedConnections = 0;
  let authErrorConnections = 0;
  let subscriptions = 0;
  let recvMessages = 0;
  let sendMessages = 0;
  let recvBytes = 0;
  let sendBytes = 0;

  for (const [id, stats] of Object.entries(current)) {
    const prev = previous[id];
    previousIds.delete(id);

    subscriptions += Math.max(0, stats.subs ?? 0);
    recvMessages += diffCounter(stats.recv?.messages, prev?.recv?.messages);
    sendMessages += diffCounter(stats.send?.messages, prev?.send?.messages);
    recvBytes += diffCounter(stats.recv?.bytes, prev?.recv?.bytes);
    sendBytes += diffCounter(stats.send?.bytes, prev?.send?.bytes);

    const address = `${stats.address ?? ""}`.trim();
    if (address) {
      uniqueAddresses.add(address);
    }
    const browserId = `${stats.browser_id ?? ""}`.trim();
    if (browserId) {
      uniqueBrowsers.add(browserId);
    }
    const user = stats.user;
    const accountId = `${user?.account_id ?? ""}`.trim();
    if (accountId) {
      uniqueAccounts.add(accountId);
    }
    const projectId = `${user?.project_id ?? ""}`.trim();
    if (projectId) {
      uniqueProjects.add(projectId);
    }
    const hubId = `${user?.hub_id ?? ""}`.trim();
    if (hubId) {
      uniqueHubs.add(hubId);
    }
    if (`${user?.error ?? ""}`.trim()) {
      authErrorConnections += 1;
    }

    if (prev == null) {
      openedConnections += 1;
      incrementCount(openedByBrowser, browserId);
      incrementCount(openedByAddress, address);
    }
  }

  const closedConnections = previousIds.size;
  const activeConnections = Object.keys(current).length;

  return {
    interval_ms: intervalMs,
    active_connections: activeConnections,
    opened_connections: openedConnections,
    closed_connections: closedConnections,
    unique_addresses: uniqueAddresses.size,
    unique_browsers: uniqueBrowsers.size,
    unique_accounts: uniqueAccounts.size,
    unique_projects: uniqueProjects.size,
    unique_hubs: uniqueHubs.size,
    auth_error_connections: authErrorConnections,
    subscriptions,
    recv_messages: recvMessages,
    send_messages: sendMessages,
    recv_bytes: recvBytes,
    send_bytes: sendBytes,
    recv_messages_per_s: roundRate(recvMessages, intervalMs),
    send_messages_per_s: roundRate(sendMessages, intervalMs),
    recv_bytes_per_s: roundRate(recvBytes, intervalMs),
    send_bytes_per_s: roundRate(sendBytes, intervalMs),
    top_opened_browsers: topOpenedCounts(openedByBrowser, "browser_id"),
    top_opened_addresses: topOpenedCounts(openedByAddress, "address"),
  };
}

function hasTrafficActivity(
  summary: ReturnType<typeof summarizeConatRouterTraffic>,
): boolean {
  return Boolean(
    summary.opened_connections ||
    summary.closed_connections ||
    summary.recv_messages ||
    summary.send_messages ||
    summary.recv_bytes ||
    summary.send_bytes,
  );
}

export function startConatRouterTrafficMetricsLoop({
  conatServer,
  systemClient,
  loggerName = "project-host:conat-router-daemon:traffic",
  intervalMs = envPositiveInt(
    "COCALC_PROJECT_HOST_CONAT_ROUTER_METRICS_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  ),
  idleLogIntervals = envPositiveInt(
    "COCALC_PROJECT_HOST_CONAT_ROUTER_IDLE_LOG_INTERVALS",
    DEFAULT_IDLE_LOG_INTERVALS,
  ),
  browserBurstThreshold = envPositiveInt(
    "COCALC_PROJECT_HOST_CONAT_ROUTER_BROWSER_BURST_THRESHOLD",
    DEFAULT_BROWSER_BURST_THRESHOLD,
  ),
  addressBurstThreshold = envPositiveInt(
    "COCALC_PROJECT_HOST_CONAT_ROUTER_ADDRESS_BURST_THRESHOLD",
    DEFAULT_ADDRESS_BURST_THRESHOLD,
  ),
}: {
  conatServer: ConatServer;
  systemClient?: Client;
  loggerName?: string;
  intervalMs?: number;
  idleLogIntervals?: number;
  browserBurstThreshold?: number;
  addressBurstThreshold?: number;
}): () => void {
  const logger = getLogger(loggerName);
  let previous: ConnectionStatsSnapshot = {};
  let idleIntervals = 0;

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      const current = await loadClusterStatsSnapshot({
        conatServer,
        systemClient,
      });
      const summary = summarizeConatRouterTraffic({
        previous,
        current,
        intervalMs,
      });
      previous = current;

      const browserBursts = summary.top_opened_browsers.filter(
        (entry) => Number(entry.connections) >= browserBurstThreshold,
      );
      const addressBursts = summary.top_opened_addresses.filter(
        (entry) => Number(entry.connections) >= addressBurstThreshold,
      );
      if (browserBursts.length || addressBursts.length) {
        logger.warn("project-host conat router reconnect burst", {
          interval_ms: intervalMs,
          browser_burst_threshold: browserBurstThreshold,
          address_burst_threshold: addressBurstThreshold,
          browser_bursts: browserBursts,
          address_bursts: addressBursts,
        });
      }

      const active = hasTrafficActivity(summary);
      if (!active) {
        idleIntervals += 1;
      } else {
        idleIntervals = 0;
      }
      if (!active && idleIntervals < idleLogIntervals) {
        return;
      }
      if (!active) {
        idleIntervals = 0;
      }
      logger.info("project-host conat router traffic", summary);
    })()
      .catch((err) => {
        logger.debug("project-host conat router traffic sampling failed", {
          err: `${err}`,
        });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export const __test__ = {
  summarizeConatRouterTraffic,
  diffCounter,
  roundRate,
};

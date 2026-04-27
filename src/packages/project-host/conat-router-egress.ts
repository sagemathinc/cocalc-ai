/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type { ConnectionStats } from "@cocalc/conat/core/types";
import type { ConatServer } from "@cocalc/conat/core/server";
import { hubApi } from "@cocalc/lite/hub/api";
import type { ManagedProjectEgressCategory } from "@cocalc/conat/hub/api/system";
import { capitalize } from "@cocalc/util/misc";
import {
  clearProjectHostManagedEgressBlockedAccount,
  clearProjectHostManagedEgressBlockedAccounts,
  getProjectHostManagedEgressMode,
  listProjectHostManagedEgressBlockedAccounts,
  setProjectHostManagedEgressBlockedAccount,
} from "./managed-egress-runtime";

const DEFAULT_INTERVAL_MS = 5_000;
const CATEGORY: ManagedProjectEgressCategory = "interactive-conat";

type ConnectionStatsSnapshot = { [id: string]: ConnectionStats };

type AccountEgressDelta = {
  account_id: string;
  bytes: number;
  socket_ids: string[];
  browser_ids: string[];
};

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
): number {
  const currentValue = Number.isFinite(current) ? Math.max(0, current ?? 0) : 0;
  const previousValue = Number.isFinite(previous)
    ? Math.max(0, previous ?? 0)
    : 0;
  return currentValue >= previousValue
    ? currentValue - previousValue
    : currentValue;
}

function normalizeAccountId(stats: ConnectionStats): string | undefined {
  const account_id = `${stats.user?.account_id ?? ""}`.trim();
  if (!account_id) return;
  if (`${stats.user?.hub_id ?? ""}`.trim()) return;
  if (`${stats.user?.project_id ?? ""}`.trim()) return;
  if (`${stats.user?.error ?? ""}`.trim()) return;
  return account_id;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

export function summarizeManagedConatEgressDeltas({
  previous,
  current,
}: {
  previous: ConnectionStatsSnapshot;
  current: ConnectionStatsSnapshot;
}): AccountEgressDelta[] {
  const byAccount = new Map<string, AccountEgressDelta>();
  for (const [socket_id, stats] of Object.entries(current)) {
    const account_id = normalizeAccountId(stats);
    if (!account_id) continue;
    const deltaBytes = diffCounter(
      stats.recv?.bytes,
      previous[socket_id]?.recv?.bytes,
    );
    if (!(deltaBytes > 0)) continue;
    const browser_id = `${stats.browser_id ?? ""}`.trim();
    const entry = byAccount.get(account_id) ?? {
      account_id,
      bytes: 0,
      socket_ids: [],
      browser_ids: [],
    };
    entry.bytes += deltaBytes;
    entry.socket_ids.push(socket_id);
    if (browser_id) {
      entry.browser_ids.push(browser_id);
    }
    byAccount.set(account_id, entry);
  }
  return Array.from(byAccount.values())
    .map((entry) => ({
      ...entry,
      socket_ids: uniqueSorted(entry.socket_ids),
      browser_ids: uniqueSorted(entry.browser_ids),
    }))
    .sort((a, b) => a.account_id.localeCompare(b.account_id));
}

function summarizeActiveSocketsByAccount(
  current: ConnectionStatsSnapshot,
): Map<string, string[]> {
  const byAccount = new Map<string, string[]>();
  for (const [socket_id, stats] of Object.entries(current)) {
    const account_id = normalizeAccountId(stats);
    if (!account_id) continue;
    const ids = byAccount.get(account_id) ?? [];
    ids.push(socket_id);
    byAccount.set(account_id, ids);
  }
  for (const [account_id, ids] of byAccount) {
    byAccount.set(account_id, uniqueSorted(ids));
  }
  return byAccount;
}

function formatByteCount(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = Number.isInteger(value) || value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatManagedEgressCategory(category: string): string {
  if (category === "file-download") return "File downloads";
  if (category === "interactive-conat") return "Interactive session traffic";
  return capitalize(category.replace(/[-_]/g, " "));
}

function buildBlockedMessage(policy: {
  managed_egress_5h_bytes?: number;
  managed_egress_7d_bytes?: number;
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  managed_egress_categories_5h_bytes?: Record<string, number>;
}): string {
  const breakdown = Object.entries(
    policy.managed_egress_categories_5h_bytes ?? {},
  )
    .filter(
      ([, bytes]) =>
        typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0,
    )
    .map(
      ([category, bytes]) =>
        `${formatManagedEgressCategory(category)}: ${formatByteCount(bytes)}`,
    );
  const lines = [
    "Interactive session traffic limit reached for this account.",
    "New terminal, notebook, and editor session traffic is temporarily blocked until the egress usage window resets.",
  ];
  if (policy.egress_5h_bytes != null) {
    lines.push(
      `5-hour usage: ${formatByteCount(policy.managed_egress_5h_bytes ?? 0)} / ${formatByteCount(policy.egress_5h_bytes)}.`,
    );
  }
  if (policy.egress_7d_bytes != null) {
    lines.push(
      `7-day usage: ${formatByteCount(policy.managed_egress_7d_bytes ?? 0)} / ${formatByteCount(policy.egress_7d_bytes)}.`,
    );
  }
  if (breakdown.length > 0) {
    lines.push(
      `Current managed egress categories (5 hours): ${breakdown.join(", ")}.`,
    );
  }
  return lines.join("\n");
}

export function startConatRouterManagedEgressLoop({
  conatServer,
  loggerName = "project-host:conat-router-daemon:managed-egress",
  intervalMs = envPositiveInt(
    "COCALC_PROJECT_HOST_CONAT_ROUTER_MANAGED_EGRESS_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  ),
}: {
  conatServer: ConatServer;
  loggerName?: string;
  intervalMs?: number;
}): () => void {
  const logger = getLogger(loggerName);
  let previous = conatServer.getStatsSnapshot();
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const mode = getProjectHostManagedEgressMode();
      const current = conatServer.getStatsSnapshot();
      const deltas = summarizeManagedConatEgressDeltas({ previous, current });
      const activeSocketsByAccount = summarizeActiveSocketsByAccount(current);
      previous = current;

      if (mode === "off") {
        clearProjectHostManagedEgressBlockedAccounts();
        return;
      }

      const pending = new Map(deltas.map((entry) => [entry.account_id, entry]));
      const accountsToCheck = new Set<string>(pending.keys());
      if (mode === "enforce") {
        for (const account_id of listProjectHostManagedEgressBlockedAccounts()) {
          accountsToCheck.add(account_id);
        }
      } else {
        clearProjectHostManagedEgressBlockedAccounts();
      }

      for (const account_id of accountsToCheck) {
        const delta = pending.get(account_id);
        if (delta?.bytes) {
          try {
            await hubApi.system.recordManagedProjectEgress({
              account_id,
              category: CATEGORY,
              bytes: delta.bytes,
              metadata: {
                browser_ids: delta.browser_ids,
                socket_count: delta.socket_ids.length,
              },
            });
          } catch (err) {
            logger.warn("unable to record managed conat egress", {
              account_id,
              bytes: delta.bytes,
              err: `${err}`,
            });
          }
        }
        if (mode !== "enforce") {
          continue;
        }
        try {
          const policy = await hubApi.system.getManagedProjectEgressPolicy({
            account_id,
            category: CATEGORY,
          });
          if (policy.allowed) {
            clearProjectHostManagedEgressBlockedAccount(account_id);
            continue;
          }
          const message = buildBlockedMessage(policy);
          setProjectHostManagedEgressBlockedAccount({ account_id, message });
          const socket_ids = activeSocketsByAccount.get(account_id) ?? [];
          if (socket_ids.length > 0) {
            logger.info("disconnecting over-limit conat account", {
              account_id,
              sockets: socket_ids.length,
              blocked_by: policy.blocked_by,
            });
            conatServer.disconnectSockets(socket_ids);
          }
        } catch (err) {
          logger.warn("unable to evaluate managed conat egress policy", {
            account_id,
            err: `${err}`,
          });
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export const __test__ = {
  buildBlockedMessage,
  diffCounter,
  summarizeActiveSocketsByAccount,
  summarizeManagedConatEgressDeltas,
};

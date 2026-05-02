/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type { Client } from "@cocalc/conat/core/client";
import type { ConatServer } from "@cocalc/conat/core/server";
import { sysApiMany } from "@cocalc/conat/core/sys";
import type { ConnectionStats } from "@cocalc/conat/core/types";
import type { ManagedProjectEgressCategory } from "@cocalc/conat/hub/api/system";
import {
  getManagedProjectEgressPolicy as getManagedProjectEgressPolicyRaw,
  type ManagedProjectEgressPolicy,
} from "@cocalc/server/membership/managed-egress-policy";
import { recordManagedProjectEgress as recordManagedProjectEgressRaw } from "@cocalc/server/membership/managed-egress";
import { capitalize, humanSize } from "@cocalc/util/misc";
import {
  clearHubManagedEgressBlockedAccount,
  clearHubManagedEgressBlockedAccounts,
  getHubManagedEgressMode,
  listHubManagedEgressBlockedAccounts,
  setHubManagedEgressBlockedAccount,
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

type RawSendDeltaSocket = {
  socket_id: string;
  bytes: number;
  account_id?: string;
  project_id?: string;
  hub_id?: string;
  browser_id?: string;
};

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
): number {
  const currentValue = Number.isFinite(current) ? Math.max(0, current ?? 0) : 0;
  const previousValue = Number.isFinite(previous)
    ? Math.max(0, previous ?? 0)
    : 0;
  return currentValue >= previousValue
    ? currentValue - previousValue
    : currentValue;
}

function getBrowserId(stats: ConnectionStats): string | undefined {
  const browser_id = `${stats.browser_id ?? ""}`.trim();
  return browser_id || undefined;
}

function normalizeAccountId(stats: ConnectionStats): string | undefined {
  const account_id = `${stats.user?.account_id ?? ""}`.trim();
  if (!account_id) return;
  if (!getBrowserId(stats)) return;
  if (`${stats.user?.hub_id ?? ""}`.trim()) return;
  if (`${stats.user?.project_id ?? ""}`.trim()) return;
  if (`${stats.user?.error ?? ""}`.trim()) return;
  return account_id;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function summarizeRawSendDeltaSockets({
  previous,
  current,
  limit = 5,
}: {
  previous: ConnectionStatsSnapshot;
  current: ConnectionStatsSnapshot;
  limit?: number;
}): RawSendDeltaSocket[] {
  const out: RawSendDeltaSocket[] = [];
  for (const [socket_id, stats] of Object.entries(current)) {
    const bytes = diffCounter(
      stats.egress?.bytes,
      previous[socket_id]?.egress?.bytes,
    );
    if (!(bytes > 0)) continue;
    out.push({
      socket_id,
      bytes,
      account_id: `${stats.user?.account_id ?? ""}`.trim() || undefined,
      project_id: `${stats.user?.project_id ?? ""}`.trim() || undefined,
      hub_id: `${stats.user?.hub_id ?? ""}`.trim() || undefined,
      browser_id: getBrowserId(stats),
    });
  }
  out.sort(
    (a, b) => b.bytes - a.bytes || a.socket_id.localeCompare(b.socket_id),
  );
  return out.slice(0, limit);
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
    const browser_id = getBrowserId(stats)!;
    const entry = byAccount.get(account_id) ?? {
      account_id,
      bytes: 0,
      socket_ids: [],
      browser_ids: [],
    };
    entry.bytes += deltaBytes;
    entry.socket_ids.push(socket_id);
    entry.browser_ids.push(browser_id);
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
  return humanSize(Math.max(0, bytes));
}

function formatManagedEgressCategory(category: string): string {
  if (category === "file-download") return "File downloads";
  if (category === "http-proxy") return "App server HTTP traffic";
  if (category === "ws-proxy") return "App server WebSocket traffic";
  if (category === "ssh") return "SSH traffic";
  if (category === "interactive-conat") return "Interactive session traffic";
  if (category === "backup-upload") return "Project backup uploads";
  return capitalize(category.replace(/[-_]/g, " "));
}

function buildBlockedMessage(policy: ManagedProjectEgressPolicy): string {
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
    "New browser session traffic is temporarily blocked until the egress usage window resets.",
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

export function startHubConatManagedEgressLoop({
  conatServer,
  systemClient,
  loggerName = "server:conat:socketio:managed-egress",
  intervalMs = envPositiveInt(
    "COCALC_HUB_CONAT_MANAGED_EGRESS_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  ),
}: {
  conatServer: ConatServer;
  systemClient?: Client;
  loggerName?: string;
  intervalMs?: number;
}): () => void {
  const logger = getLogger(loggerName);
  let previous: ConnectionStatsSnapshot = {};
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const mode = getHubManagedEgressMode();
      const current = await loadClusterStatsSnapshot({
        conatServer,
        systemClient,
      });
      const deltas = summarizeManagedConatEgressDeltas({ previous, current });
      const activeSocketsByAccount = summarizeActiveSocketsByAccount(current);
      const rawSendDeltaSockets = summarizeRawSendDeltaSockets({
        previous,
        current,
      });
      previous = current;

      if (mode === "off") {
        clearHubManagedEgressBlockedAccounts();
        return;
      }

      if (deltas.length > 0) {
        logger.info("managed hub conat egress sample", {
          mode,
          accounts: deltas.map((delta) => ({
            account_id: delta.account_id,
            bytes: delta.bytes,
            socket_count: delta.socket_ids.length,
            browser_ids: delta.browser_ids,
          })),
          sockets: rawSendDeltaSockets,
        });
      }

      const pending = new Map(deltas.map((entry) => [entry.account_id, entry]));
      const accountsToCheck = new Set<string>(pending.keys());
      if (mode === "enforce") {
        for (const account_id of listHubManagedEgressBlockedAccounts()) {
          accountsToCheck.add(account_id);
        }
      } else {
        clearHubManagedEgressBlockedAccounts();
      }

      for (const account_id of accountsToCheck) {
        const delta = pending.get(account_id);
        if (delta?.bytes) {
          try {
            await recordManagedProjectEgressRaw({
              account_id,
              category: CATEGORY,
              bytes: delta.bytes,
              metadata: {
                browser_ids: delta.browser_ids,
                socket_count: delta.socket_ids.length,
              },
            });
          } catch (err) {
            logger.warn("unable to record managed hub conat egress", {
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
          const policy = await getManagedProjectEgressPolicyRaw({
            account_id,
            category: CATEGORY,
          });
          if (policy.allowed) {
            clearHubManagedEgressBlockedAccount(account_id);
            continue;
          }
          const message = buildBlockedMessage(policy);
          setHubManagedEgressBlockedAccount({ account_id, message });
          const socket_ids = activeSocketsByAccount.get(account_id) ?? [];
          if (socket_ids.length > 0) {
            logger.info("disconnecting over-limit hub conat account", {
              account_id,
              sockets: socket_ids.length,
              blocked_by: policy.blocked_by,
            });
            conatServer.disconnectSockets(socket_ids);
          }
        } catch (err) {
          logger.warn("unable to evaluate managed hub conat egress policy", {
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
  summarizeManagedConatEgressDeltas,
};

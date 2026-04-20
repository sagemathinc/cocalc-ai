/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { drainAccountNotificationIndexProjection } from "@cocalc/database/postgres/account-notification-index-projector";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { publishProjectedNotificationFeedUpdatesBestEffort } from "@cocalc/server/notifications/feed";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";

const logger = getLogger("server:projections:account-notification-index");

const ENABLED =
  `${process.env.COCALC_ACCOUNT_NOTIFICATION_INDEX_PROJECTOR_ENABLED ?? "1"}`.trim() !==
  "0";
const INTERVAL_MS = clampInt(
  process.env.COCALC_ACCOUNT_NOTIFICATION_INDEX_PROJECTOR_INTERVAL_MS,
  5_000,
  500,
  10 * 60_000,
);
const BATCH_LIMIT = clampInt(
  process.env.COCALC_ACCOUNT_NOTIFICATION_INDEX_PROJECTOR_BATCH_LIMIT,
  100,
  1,
  10_000,
);
const MAX_BATCHES_PER_TICK = clampInt(
  process.env.COCALC_ACCOUNT_NOTIFICATION_INDEX_PROJECTOR_MAX_BATCHES_PER_TICK,
  5,
  1,
  1_000,
);

let timer: NodeJS.Timeout | undefined;
let running = false;
let startedAt: Date | null = null;
let lastTickStartedAt: Date | null = null;
let lastTickFinishedAt: Date | null = null;
let lastTickDurationMs: number | null = null;
let lastSuccessAt: Date | null = null;
let lastErrorAt: Date | null = null;
let lastError: string | null = null;
let consecutiveFailures = 0;
let lastResult: AccountNotificationIndexProjectionPassResult | null = null;

export interface AccountNotificationIndexProjectionPassResult {
  bay_id: string;
  batches: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  affected_account_ids: string[];
  affected_notifications: Array<{
    account_id: string;
    notification_id: string;
  }>;
  event_types: Record<string, number>;
}

export interface RunAccountNotificationIndexProjectionPassOptions {
  bay_id?: string;
  batch_limit?: number;
  max_batches_per_tick?: number;
  drain?: typeof drainAccountNotificationIndexProjection;
}

export interface AccountNotificationIndexProjectionMaintenanceStatus {
  enabled: boolean;
  observed_bay_id: string;
  interval_ms: number;
  batch_limit: number;
  max_batches_per_tick: number;
  running: boolean;
  started_at: string | null;
  last_tick_started_at: string | null;
  last_tick_finished_at: string | null;
  last_tick_duration_ms: number | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_result: AccountNotificationIndexProjectionPassResult | null;
}

export interface RunAccountNotificationIndexProjectionMaintenanceTickOptions extends RunAccountNotificationIndexProjectionPassOptions {
  pass_runner?: typeof runAccountNotificationIndexProjectionPass;
  publisher?: typeof publishProjectedNotificationFeedUpdatesBestEffort;
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function isoOrNull(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export async function runAccountNotificationIndexProjectionPass(
  opts?: RunAccountNotificationIndexProjectionPassOptions,
): Promise<AccountNotificationIndexProjectionPassResult> {
  const bay_id =
    `${opts?.bay_id ?? getConfiguredBayId()}`.trim() || DEFAULT_BAY_ID;
  const batch_limit = opts?.batch_limit ?? BATCH_LIMIT;
  const max_batches_per_tick =
    opts?.max_batches_per_tick ?? MAX_BATCHES_PER_TICK;
  const drain = opts?.drain ?? drainAccountNotificationIndexProjection;
  const result: AccountNotificationIndexProjectionPassResult = {
    bay_id,
    batches: 0,
    scanned_events: 0,
    applied_events: 0,
    inserted_rows: 0,
    deleted_rows: 0,
    affected_account_ids: [],
    affected_notifications: [],
    event_types: {},
  };
  const affectedAccountIds = new Set<string>();
  const affectedNotifications = new Set<string>();
  for (let i = 0; i < max_batches_per_tick; i += 1) {
    const batch = await drain({
      bay_id,
      limit: batch_limit,
      dry_run: false,
    });
    result.batches += 1;
    result.scanned_events += batch.scanned_events;
    result.applied_events += batch.applied_events;
    result.inserted_rows += batch.inserted_rows;
    result.deleted_rows += batch.deleted_rows;
    for (const account_id of batch.affected_account_ids) {
      affectedAccountIds.add(account_id);
    }
    for (const item of batch.affected_notifications) {
      affectedNotifications.add(`${item.account_id}:${item.notification_id}`);
    }
    for (const [event_type, count] of Object.entries(batch.event_types)) {
      result.event_types[event_type] =
        (result.event_types[event_type] ?? 0) + count;
    }
    if (batch.scanned_events < batch_limit) {
      break;
    }
  }
  result.affected_account_ids = Array.from(affectedAccountIds).sort();
  result.affected_notifications = Array.from(affectedNotifications)
    .sort()
    .map((value) => {
      const [account_id, notification_id] = value.split(":");
      return { account_id, notification_id };
    });
  return result;
}

export function getAccountNotificationIndexProjectionMaintenanceStatus(): AccountNotificationIndexProjectionMaintenanceStatus {
  return {
    enabled: ENABLED,
    observed_bay_id: getConfiguredBayId(),
    interval_ms: INTERVAL_MS,
    batch_limit: BATCH_LIMIT,
    max_batches_per_tick: MAX_BATCHES_PER_TICK,
    running,
    started_at: isoOrNull(startedAt),
    last_tick_started_at: isoOrNull(lastTickStartedAt),
    last_tick_finished_at: isoOrNull(lastTickFinishedAt),
    last_tick_duration_ms: lastTickDurationMs,
    last_success_at: isoOrNull(lastSuccessAt),
    last_error_at: isoOrNull(lastErrorAt),
    last_error: lastError,
    consecutive_failures: consecutiveFailures,
    last_result: lastResult,
  };
}

export async function runAccountNotificationIndexProjectionMaintenanceTick(
  opts?: RunAccountNotificationIndexProjectionMaintenanceTickOptions,
): Promise<AccountNotificationIndexProjectionPassResult | null> {
  if (running) return null;
  running = true;
  const pass_runner =
    opts?.pass_runner ?? runAccountNotificationIndexProjectionPass;
  const publisher =
    opts?.publisher ?? publishProjectedNotificationFeedUpdatesBestEffort;
  const started = new Date();
  lastTickStartedAt = started;
  try {
    const result = await pass_runner(opts);
    const finished = new Date();
    lastTickFinishedAt = finished;
    lastTickDurationMs = Math.max(0, finished.getTime() - started.getTime());
    lastSuccessAt = finished;
    lastErrorAt = null;
    lastError = null;
    consecutiveFailures = 0;
    lastResult = result;
    if (result.scanned_events > 0 || result.applied_events > 0) {
      logger.info(
        "account notification index projector tick applied events",
        result,
      );
    }
    const notificationIdsByAccount = new Map<string, string[]>();
    for (const item of result.affected_notifications) {
      const ids = notificationIdsByAccount.get(item.account_id) ?? [];
      ids.push(item.notification_id);
      notificationIdsByAccount.set(item.account_id, ids);
    }
    for (const [account_id, notification_ids] of notificationIdsByAccount) {
      void publisher({
        account_id,
        reason: "projected_upsert",
        notification_ids,
      });
    }
    return result;
  } catch (err) {
    const finished = new Date();
    lastTickFinishedAt = finished;
    lastTickDurationMs = Math.max(0, finished.getTime() - started.getTime());
    lastErrorAt = finished;
    lastError = err instanceof Error ? err.message : `${err}`;
    consecutiveFailures += 1;
    logger.error("account notification index projector tick failed", err);
    throw err;
  } finally {
    running = false;
  }
}

export function startAccountNotificationIndexProjectionMaintenance(): void {
  if (!ENABLED) {
    logger.info("account notification index projector disabled");
    return;
  }
  if (timer) return;
  startedAt = new Date();
  timer = setInterval(() => {
    void runAccountNotificationIndexProjectionMaintenanceTick();
  }, INTERVAL_MS);
  timer.unref?.();
  void runAccountNotificationIndexProjectionMaintenanceTick();
  logger.info("account notification index projector started", {
    interval_ms: INTERVAL_MS,
    batch_limit: BATCH_LIMIT,
    max_batches_per_tick: MAX_BATCHES_PER_TICK,
  });
}

export function stopAccountNotificationIndexProjectionMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

export function resetAccountNotificationIndexProjectionMaintenanceStateForTests(): void {
  stopAccountNotificationIndexProjectionMaintenance();
  running = false;
  startedAt = null;
  lastTickStartedAt = null;
  lastTickFinishedAt = null;
  lastTickDurationMs = null;
  lastSuccessAt = null;
  lastErrorAt = null;
  lastError = null;
  consecutiveFailures = 0;
  lastResult = null;
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_DAYS = 35;
const DEFAULT_BATCH_SIZE = 5000;

const logger = getLogger("server:membership:usage-retention-maintenance");

const TABLES = [
  {
    table: "account_managed_egress_events",
    time_column: "occurred_at",
  },
  {
    table: "account_managed_egress_rollups",
    time_column: "bucket_start",
  },
  {
    table: "account_cpu_usage_events",
    time_column: "sample_ended_at",
  },
] as const;

let started = false;
let running = false;

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function deleteExpiredBatch({
  table,
  time_column,
  retentionDays,
  batchSize,
}: {
  table: (typeof TABLES)[number]["table"];
  time_column: (typeof TABLES)[number]["time_column"];
  retentionDays: number;
  batchSize: number;
}): Promise<number> {
  try {
    const { rowCount } = await getPool().query(
      `
        WITH doomed AS (
          SELECT ctid
          FROM ${table}
          WHERE ${time_column} < now() - ($1::text || ' days')::interval
          ORDER BY ${time_column}
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        DELETE FROM ${table} AS events
        USING doomed
        WHERE events.ctid = doomed.ctid
      `,
      [retentionDays, batchSize],
    );
    return rowCount ?? 0;
  } catch (err: any) {
    if (err?.code === "42P01") return 0;
    throw err;
  }
}

export async function runUsageRetentionMaintenanceOnce(): Promise<
  Record<string, number>
> {
  if (running) return {};
  running = true;
  const retentionDays = positiveIntegerEnv(
    "COCALC_MANAGED_USAGE_DETAIL_RETENTION_DAYS",
    DEFAULT_RETENTION_DAYS,
  );
  const batchSize = positiveIntegerEnv(
    "COCALC_MANAGED_USAGE_RETENTION_BATCH_SIZE",
    DEFAULT_BATCH_SIZE,
  );
  const deleted: Record<string, number> = {};
  try {
    for (const entry of TABLES) {
      deleted[entry.table] = await deleteExpiredBatch({
        ...entry,
        retentionDays,
        batchSize,
      });
    }
    const total = Object.values(deleted).reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      logger.info("deleted expired managed usage detail", {
        retention_days: retentionDays,
        deleted,
      });
    }
    return deleted;
  } catch (err) {
    logger.warn("managed usage retention maintenance failed", {
      err: `${err}`,
    });
    return deleted;
  } finally {
    running = false;
  }
}

export function startUsageRetentionMaintenance(): void {
  if (started) return;
  started = true;
  const interval = positiveIntegerEnv(
    "COCALC_MANAGED_USAGE_RETENTION_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  );
  const timer = setInterval(() => {
    void runUsageRetentionMaintenanceOnce();
  }, interval);
  timer.unref?.();
}

export const __test__ = {
  reset: () => {
    started = false;
    running = false;
  },
};

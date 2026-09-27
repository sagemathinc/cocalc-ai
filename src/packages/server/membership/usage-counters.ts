/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import LRU from "lru-cache";
import {
  ensureAccountUsageWindowSchema,
  type AccountUsageWindow,
  type AccountUsageWindowName,
} from "./usage-windows";

const COUNTERS_TABLE = "account_usage_counters";
const STATES_TABLE = "account_usage_counter_states";
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_MAX_PENDING = 1000;
const INITIALIZATION_CONCURRENCY = positiveIntegerEnv(
  "COCALC_USAGE_COUNTER_INITIALIZATION_CONCURRENCY",
  2,
);

const logger = getLogger("server:membership:usage-counters");

export type AccountUsageCounterMetric =
  | "managed-cpu-seconds"
  | "managed-egress-bytes";

export type AccountUsageWindows = Partial<
  Record<AccountUsageWindowName, AccountUsageWindow>
>;

export type AccountUsageCounterBaseline = {
  usage_window_id: string;
  category: string;
  amount: number;
};

type BaselineLoader = (opts: {
  client: PoolClient;
  windows: AccountUsageWindow[];
  cutoff: Date;
}) => Promise<AccountUsageCounterBaseline[]>;

type PendingCounter = AccountUsageCounterBaseline & {
  metric: AccountUsageCounterMetric;
};

let ensuredSchema: Promise<void> | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushPromise: Promise<void> | undefined;
const pendingCounters = new Map<string, PendingCounter>();
const initializedCounters = new LRU<string, Promise<void>>({
  max: 50_000,
  ttl: 8 * 24 * 60 * 60 * 1000,
});
let activeInitializations = 0;
const initializationWaiters: Array<() => void> = [];

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function withInitializationSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeInitializations >= INITIALIZATION_CONCURRENCY) {
    await new Promise<void>((resolve) => initializationWaiters.push(resolve));
  }
  activeInitializations += 1;
  try {
    return await fn();
  } finally {
    activeInitializations -= 1;
    initializationWaiters.shift()?.();
  }
}

function pendingKey(entry: PendingCounter): string {
  return [entry.usage_window_id, entry.metric, entry.category].join(":");
}

function initializationKey({
  metric,
  windows,
}: {
  metric: AccountUsageCounterMetric;
  windows: AccountUsageWindow[];
}): string {
  return `${metric}:${windows
    .map(({ id }) => id)
    .sort()
    .join(":")}`;
}

export async function ensureAccountUsageCounterSchema(): Promise<void> {
  if (!ensuredSchema) {
    ensuredSchema = (async () => {
      await ensureAccountUsageWindowSchema();
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS ${COUNTERS_TABLE} (
          usage_window_id UUID NOT NULL REFERENCES account_usage_windows(id) ON DELETE CASCADE,
          metric TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT '',
          amount NUMERIC NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (usage_window_id, metric, category)
        )
      `);
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS ${STATES_TABLE} (
          usage_window_id UUID NOT NULL REFERENCES account_usage_windows(id) ON DELETE CASCADE,
          metric TEXT NOT NULL,
          initialized_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (usage_window_id, metric)
        )
      `);
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${STATES_TABLE}_metric_idx ON ${STATES_TABLE}(metric, initialized_at DESC)`,
      );
    })().catch((err) => {
      ensuredSchema = undefined;
      throw err;
    });
  }
  await ensuredSchema;
}

async function initializeAccountUsageCountersInternal({
  account_id,
  metric,
  windows,
  loadBaseline,
  transaction,
}: {
  account_id: string;
  metric: AccountUsageCounterMetric;
  windows: AccountUsageWindow[];
  loadBaseline: BaselineLoader;
  transaction?: PoolClient;
}): Promise<void> {
  await ensureAccountUsageCounterSchema();
  const client = transaction ?? (await getPool().connect());
  try {
    if (!transaction) await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [account_id, metric],
    );
    const windowIds = windows.map(({ id }) => id);
    const { rows } = await client.query<{ usage_window_id: string }>(
      `
        SELECT usage_window_id
        FROM ${STATES_TABLE}
        WHERE metric = $1
          AND usage_window_id = ANY($2::uuid[])
      `,
      [metric, windowIds],
    );
    const initialized = new Set(
      rows.map(({ usage_window_id }) => usage_window_id),
    );
    const missing = windows.filter(({ id }) => !initialized.has(id));
    if (missing.length > 0) {
      const cutoff = new Date();
      const baseline = await loadBaseline({ client, windows: missing, cutoff });
      if (baseline.length > 0) {
        await client.query(
          `
            WITH input AS (
              SELECT *
              FROM jsonb_to_recordset($1::jsonb) AS entry(
                usage_window_id uuid,
                category text,
                amount numeric
              )
            )
            INSERT INTO ${COUNTERS_TABLE}
              (usage_window_id, metric, category, amount)
            SELECT usage_window_id, $2, category, amount
            FROM input
            ON CONFLICT (usage_window_id, metric, category)
            DO UPDATE SET
              amount = EXCLUDED.amount,
              updated_at = now()
          `,
          [JSON.stringify(baseline), metric],
        );
      }
      await client.query(
        `
          INSERT INTO ${STATES_TABLE}
            (usage_window_id, metric, initialized_at)
          SELECT value::uuid, $2, $3
          FROM unnest($1::text[]) AS value
          ON CONFLICT (usage_window_id, metric) DO NOTHING
        `,
        [missing.map(({ id }) => id), metric, cutoff],
      );
    }
    if (!transaction) await client.query("COMMIT");
  } catch (err) {
    if (!transaction) await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    if (!transaction) client.release();
  }
}

export async function ensureAccountUsageCountersInitialized({
  account_id,
  metric,
  windows,
  loadBaseline,
  transaction,
}: {
  account_id: string;
  metric: AccountUsageCounterMetric;
  windows: AccountUsageWindows;
  loadBaseline: BaselineLoader;
  transaction?: PoolClient;
}): Promise<void> {
  const windowList = Object.values(windows);
  if (windowList.length === 0) return;
  // Do not cache uncommitted initialization or wait for an initializer that
  // needs the transaction's advisory lock.
  if (transaction) {
    return await initializeAccountUsageCountersInternal({
      account_id,
      metric,
      windows: windowList,
      loadBaseline,
      transaction,
    });
  }
  const key = initializationKey({ metric, windows: windowList });
  const cached = initializedCounters.get(key);
  if (cached) {
    return await cached;
  }
  const value = withInitializationSlot(
    async () =>
      await initializeAccountUsageCountersInternal({
        account_id,
        metric,
        windows: windowList,
        loadBaseline,
      }),
  ).catch((err) => {
    if (initializedCounters.get(key) === value) {
      initializedCounters.delete(key);
    }
    throw err;
  });
  initializedCounters.set(key, value);
  await value;
}

function mergePendingCounter(entry: PendingCounter): void {
  const key = pendingKey(entry);
  const existing = pendingCounters.get(key);
  if (existing) {
    existing.amount += entry.amount;
  } else {
    pendingCounters.set(key, { ...entry });
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushAccountUsageCounters().catch(() => undefined);
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

export function recordAccountUsageCounterDelta({
  metric,
  windows,
  category = "",
  amount,
}: {
  metric: AccountUsageCounterMetric;
  windows: AccountUsageWindows;
  category?: string;
  amount: number;
}): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  for (const { id } of Object.values(windows)) {
    mergePendingCounter({
      usage_window_id: id,
      metric,
      category,
      amount,
    });
  }
  if (pendingCounters.size >= FLUSH_MAX_PENDING) {
    void flushAccountUsageCounters();
  } else {
    scheduleFlush();
  }
}

export async function flushAccountUsageCounters(): Promise<void> {
  if (flushPromise) return await flushPromise;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const batch = [...pendingCounters.values()];
  pendingCounters.clear();
  if (batch.length === 0) return;
  flushPromise = getPool("medium")
    .query(
      `
        WITH input AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb) AS entry(
            usage_window_id uuid,
            metric text,
            category text,
            amount numeric
          )
        )
        INSERT INTO ${COUNTERS_TABLE}
          (usage_window_id, metric, category, amount)
        SELECT usage_window_id, metric, category, amount
        FROM input
        ON CONFLICT (usage_window_id, metric, category)
        DO UPDATE SET
          amount = ${COUNTERS_TABLE}.amount + EXCLUDED.amount,
          updated_at = now()
      `,
      [JSON.stringify(batch)],
    )
    .then(() => undefined)
    .catch((err) => {
      logger.warn("failed to flush account usage counters", {
        count: batch.length,
        err: `${err}`,
      });
      for (const entry of batch) {
        mergePendingCounter(entry);
      }
      scheduleFlush();
    })
    .finally(() => {
      flushPromise = undefined;
      if (pendingCounters.size > 0) scheduleFlush();
    });
  await flushPromise;
}

export async function getAccountUsageCounterValues({
  metric,
  windows,
}: {
  metric: AccountUsageCounterMetric;
  windows: AccountUsageWindows;
}): Promise<Record<AccountUsageWindowName, Record<string, number>>> {
  await ensureAccountUsageCounterSchema();
  if (flushPromise) await flushPromise;
  const windowEntries = Object.entries(windows) as Array<
    [AccountUsageWindowName, AccountUsageWindow]
  >;
  const byId = new Map(windowEntries.map(([name, { id }]) => [id, name]));
  const result: Record<AccountUsageWindowName, Record<string, number>> = {
    "5h": {},
    "7d": {},
  };
  if (windowEntries.length === 0) return result;
  const { rows } = await getPool().query<{
    usage_window_id: string;
    category: string;
    amount: string | number;
  }>(
    `
      SELECT usage_window_id, category, amount
      FROM ${COUNTERS_TABLE}
      WHERE metric = $1
        AND usage_window_id = ANY($2::uuid[])
      ORDER BY usage_window_id, category
    `,
    [metric, [...byId.keys()]],
  );
  for (const { usage_window_id, category, amount } of rows) {
    const window = byId.get(usage_window_id);
    if (!window) continue;
    result[window][category] = Math.max(0, Number(amount) || 0);
  }
  for (const entry of pendingCounters.values()) {
    if (entry.metric !== metric) continue;
    const window = byId.get(entry.usage_window_id);
    if (!window) continue;
    result[window][entry.category] =
      (result[window][entry.category] ?? 0) + entry.amount;
  }
  return result;
}

export const __test__ = {
  pendingCounters,
};

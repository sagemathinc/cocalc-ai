/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Each account's sensor budgets: how many agent turns its sensors and
// watchers may start in any 24 hours, and how many watchers it may have at
// once. They live on the account's home bay, so they hold however many bays
// the account's projects are on. Other bays reach them through
// sensorBudget (cocalc-connector-routing.ts).

import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  SENSOR_DEFAULT_MAX_WAKES_PER_DAY,
  SENSOR_DEFAULT_MIN_INTERVAL_MINUTES,
  SENSOR_LIMITS,
} from "@cocalc/conat/agents/sensors";
import type {
  SensorWakeBudgetRequest,
  SensorWatcherBudgetRequest,
} from "@cocalc/conat/inter-bay/agent-connector";
import { getAccountProductAccessTrust } from "@cocalc/server/accounts/trusted-product-access";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import type { PoolClient } from "@cocalc/database/pool";
import { agentStore } from "./store";

/** Active sensors per project when a tier does not set a limit. */
const DEFAULT_MAX_ACTIVE = 20;
/**
 * A watcher counts as active until it is released (it fired, gave up or was
 * deleted) or, if a release is lost, until a while after it expires.
 */
const WATCHER_SLACK_MS = 3_600_000;

export const NO_SENSORS =
  "Your membership does not include agent sensors. Upgrade your membership to use them.";

export interface SensorLimits {
  maxActive: number;
  minIntervalMinutes: number;
  maxWakesPerDay: number;
}

export async function sensorLimits(account_id: string): Promise<SensorLimits> {
  const trust = await getAccountProductAccessTrust(account_id);
  if (!trust.trusted)
    return {
      maxActive: 0,
      minIntervalMinutes: SENSOR_DEFAULT_MIN_INTERVAL_MINUTES,
      maxWakesPerDay: 0,
    };
  const limits =
    (await resolveMembershipForAccount(account_id)).effective_limits ?? {};
  const count = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  return {
    maxActive: count(
      limits.acp_max_active_automations_per_project,
      DEFAULT_MAX_ACTIVE,
    ),
    minIntervalMinutes: Math.max(
      1,
      count(
        limits.sensor_min_interval_minutes,
        SENSOR_DEFAULT_MIN_INTERVAL_MINUTES,
      ),
    ),
    maxWakesPerDay: count(
      limits.sensor_max_wakes_per_day,
      SENSOR_DEFAULT_MAX_WAKES_PER_DAY,
    ),
  };
}

type Querier = Pick<PoolClient, "query">;

/** Serialize one account's budget changes on its home bay. */
async function lockAccountSensors(client: Querier, account_id: string) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('agent-sensor-budget:' || $1::text, 0))",
    [account_id],
  );
}

function ids(opts: Record<string, unknown>, names: string[]) {
  for (const name of names) requireUuid(opts[name], name);
}

/**
 * Reserve one wake for this run in the account's rolling 24-hour budget.
 * Keyed by the run, so asking again for the same run never counts twice.
 */
export async function reserveSensorWakeAtHome(
  opts: SensorWakeBudgetRequest,
): Promise<{ reserved: boolean }> {
  ids(opts as any, [
    "account_id",
    "project_id",
    "agent_id",
    "sensor_id",
    "run_id",
  ]);
  const { maxWakesPerDay } = await sensorLimits(opts.account_id);
  return await agentStore().transaction(async (client) => {
    await lockAccountSensors(client, opts.account_id);
    const { rows: existing } = await client.query(
      "SELECT 1 FROM agent_sensor_events WHERE event_id=$1 AND account_id=$2 AND kind='wake'",
      [opts.run_id, opts.account_id],
    );
    if (existing.length > 0) return { reserved: true };
    const { rows } = await client.query(
      `INSERT INTO agent_sensor_events (event_id, kind, account_id, project_id, agent_id, sensor_id)
       SELECT $1, 'wake', $2, $3, $4, $5
       WHERE (SELECT count(*) FROM agent_sensor_events WHERE account_id=$2
              AND kind='wake' AND created > now() - interval '1 day') < $6
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        opts.run_id,
        opts.account_id,
        opts.project_id,
        opts.agent_id,
        opts.sensor_id,
        maxWakesPerDay,
      ],
    );
    return { reserved: rows.length > 0 };
  });
}

/**
 * Give a wake back. Only for a wake that was certainly never sent: once a
 * delivery was attempted, the turn may have started, so it stays counted.
 */
export async function releaseSensorWakeAtHome({
  account_id,
  run_id,
}: {
  account_id: string;
  run_id: string;
}): Promise<void> {
  requireUuid(account_id, "account_id");
  requireUuid(run_id, "run_id");
  await agentStore().query(
    "DELETE FROM agent_sensor_events WHERE event_id=$1 AND account_id=$2 AND kind='wake'",
    [run_id, account_id],
  );
}

/**
 * Count a new watcher against the account's limits: a few active at once,
 * and no more set per day than the account may be woken. It stays active
 * until released, or until a while after it expires if a release is lost.
 */
export async function reserveSensorWatcherAtHome(
  opts: SensorWatcherBudgetRequest,
): Promise<void> {
  ids(opts as any, ["account_id", "project_id", "agent_id", "sensor_id"]);
  const expires = Date.parse(opts.expires_at);
  if (
    !Number.isFinite(expires) ||
    expires > Date.now() + (SENSOR_LIMITS.maxReminderHours + 2) * 3_600_000
  )
    throw new Error("invalid watcher expiry");
  const limits = await sensorLimits(opts.account_id);
  if (limits.maxActive === 0 || limits.maxWakesPerDay === 0)
    throw new Error(NO_SENSORS);
  await agentStore().transaction(async (client) => {
    await lockAccountSensors(client, opts.account_id);
    const { rows: counts } = await client.query<{
      active: string;
      recent: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE released_at IS NULL AND expires_at > now()) AS active,
         count(*) FILTER (WHERE created > now() - interval '1 day') AS recent
       FROM agent_sensor_events WHERE account_id=$1 AND kind='watch'`,
      [opts.account_id],
    );
    if (Number(counts[0]?.active) >= SENSOR_LIMITS.maxWatchersPerAccount)
      throw new Error(
        `at most ${SENSOR_LIMITS.maxWatchersPerAccount} watchers may be active at once for this account`,
      );
    if (Number(counts[0]?.recent) >= limits.maxWakesPerDay)
      throw new Error(
        `this account may set at most ${limits.maxWakesPerDay} watchers a day`,
      );
    await client.query(
      `INSERT INTO agent_sensor_events (event_id, kind, account_id, project_id,
         agent_id, sensor_id, expires_at)
       VALUES ($1, 'watch', $2, $3, $4, $1, $5)`,
      [
        opts.sensor_id,
        opts.account_id,
        opts.project_id,
        opts.agent_id,
        new Date(expires + WATCHER_SLACK_MS),
      ],
    );
  });
}

/** The watcher fired, gave up or was deleted: no longer active. */
export async function releaseSensorWatcherAtHome({
  account_id,
  sensor_id,
}: {
  account_id: string;
  sensor_id: string;
}): Promise<void> {
  requireUuid(account_id, "account_id");
  requireUuid(sensor_id, "sensor_id");
  await agentStore().query(
    `UPDATE agent_sensor_events SET released_at=now()
     WHERE event_id=$1 AND account_id=$2 AND kind='watch' AND released_at IS NULL`,
    [sensor_id, account_id],
  );
}

/** Budgets look back one day; watchers count until they expire. */
export async function pruneSensorEvents(): Promise<void> {
  await agentStore().query(
    `DELETE FROM agent_sensor_events WHERE created < now() - interval '2 days'
       AND (expires_at IS NULL OR expires_at < now())`,
  );
}

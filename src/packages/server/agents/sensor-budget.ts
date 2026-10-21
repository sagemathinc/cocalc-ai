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
  SENSOR_DEFAULT_ACCOUNT_WAKES_PER_DAY,
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

/**
 * Watchers an account may set per day, per wake of its daily budget: a cap
 * against churn only. Most watchers fire once, so this leaves room for those
 * that are deleted or given up on before they fire.
 */
export const WATCHERS_PER_WAKE = 4;

export const NO_SENSORS =
  "Your membership does not include agent sensors. Upgrade your membership to use them.";

export interface SensorLimits {
  maxActive: number;
  minIntervalMinutes: number;
  maxWakesPerDay: number;
  /** Built-in watchers all of the account's agents may have active at once. */
  maxWatchers: number;
  /** Built-in watchers one agent may have active at once. */
  maxWatchersPerAgent: number;
}

export async function sensorLimits(account_id: string): Promise<SensorLimits> {
  const trust = await getAccountProductAccessTrust(account_id);
  if (!trust.trusted)
    return {
      maxActive: 0,
      minIntervalMinutes: SENSOR_DEFAULT_MIN_INTERVAL_MINUTES,
      maxWakesPerDay: 0,
      maxWatchers: 0,
      maxWatchersPerAgent: 0,
    };
  const limits =
    (await resolveMembershipForAccount(account_id)).effective_limits ?? {};
  const count = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  const maxWatchers = count(
    limits.sensor_max_active_watchers,
    SENSOR_LIMITS.maxWatchersPerAccount,
  );
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
      SENSOR_DEFAULT_ACCOUNT_WAKES_PER_DAY,
    ),
    maxWatchers,
    // Unset: one agent may use all of the account's watchers.
    maxWatchersPerAgent: Math.min(
      maxWatchers,
      count(limits.sensor_max_active_watchers_per_agent, maxWatchers),
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
 * and only while the account still has wakes left today. A watcher costs a
 * turn only when it fires, and that wake is reserved from the daily budget
 * then, so setting one is not limited by that budget itself, only by a
 * generous cap against churn. It stays active until released, or until a
 * while after it expires if a release is lost.
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
  // Watchers replace polling: any membership that allows wakes has them,
  // limited by maxWatchers, maxWatchersPerAgent and the wake budget, not
  // maxActive.
  // A reminder (`watch at`) checks nothing until it fires, perhaps months
  // away: it is counted apart, so it never takes another watcher's place
  // (and a tier with no watchers still has reminders, if it has wakes).
  const kind = opts.reminder === true ? "reminder" : "watch";
  if (
    limits.maxWakesPerDay === 0 ||
    (kind === "watch" && limits.maxWatchers === 0)
  )
    throw new Error(NO_SENSORS);
  await agentStore().transaction(async (client) => {
    await lockAccountSensors(client, opts.account_id);
    const { rows: counts } = await client.query<{
      active: string;
      agent_active: string;
      recent: string;
      wakes: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE kind=$3 AND released_at IS NULL
                          AND expires_at > now()) AS active,
         count(*) FILTER (WHERE kind=$3 AND released_at IS NULL
                          AND expires_at > now() AND agent_id=$2) AS agent_active,
         count(*) FILTER (WHERE kind IN ('watch', 'reminder')
                          AND created > now() - interval '1 day') AS recent,
         count(*) FILTER (WHERE kind='wake'
                          AND created > now() - interval '1 day') AS wakes
       FROM agent_sensor_events WHERE account_id=$1`,
      [opts.account_id, opts.agent_id, kind],
    );
    const [maxActive, maxPerAgent, what] =
      kind === "reminder"
        ? [
            SENSOR_LIMITS.maxRemindersPerAccount,
            SENSOR_LIMITS.maxRemindersPerAgent,
            "reminders may be pending",
          ]
        : [
            limits.maxWatchers,
            limits.maxWatchersPerAgent,
            "watchers may be active",
          ];
    if (Number(counts[0]?.active) >= maxActive)
      throw new Error(
        `at most ${maxActive} ${what} at once for this account (all its agents together). ` +
          (await activeWatchersText(client, opts.account_id, undefined, kind)),
      );
    if (Number(counts[0]?.agent_active) >= maxPerAgent)
      throw new Error(
        `at most ${maxPerAgent} ${what} at once for this agent. ` +
          (await activeWatchersText(
            client,
            opts.account_id,
            opts.agent_id,
            kind,
          )),
      );
    // Refused now rather than set: with no wake left it could fire but never
    // wake the agent, which ended its turn to wait for it. A reminder due
    // after the current 24 hours have rolled past fires with later wakes;
    // one due sooner is refused like any watcher. (`expires` is an hour
    // after a reminder's time.)
    const dueWithinWindow =
      kind === "watch" || expires - 3_600_000 < Date.now() + 86_400_000;
    if (dueWithinWindow && Number(counts[0]?.wakes) >= limits.maxWakesPerDay)
      throw new Error(
        `this account's agents have used all ${limits.maxWakesPerDay} wakes of the last 24 hours, so a watcher could not wake you; wait in the foreground instead`,
      );
    const maxCreated = limits.maxWakesPerDay * WATCHERS_PER_WAKE;
    if (Number(counts[0]?.recent) >= maxCreated)
      throw new Error(
        `this account may set at most ${maxCreated} watchers a day`,
      );
    await client.query(
      `INSERT INTO agent_sensor_events (event_id, kind, account_id, project_id,
         agent_id, sensor_id, expires_at)
       VALUES ($1, $6, $2, $3, $4, $1, $5)`,
      [
        opts.sensor_id,
        opts.account_id,
        opts.project_id,
        opts.agent_id,
        new Date(expires + WATCHER_SLACK_MS),
        kind,
      ],
    );
  });
}

/**
 * Which watchers hold the account's (or one agent's) places, so whoever hits
 * a limit can see what to delete instead of guessing.
 */
async function activeWatchersText(
  client: Querier,
  account_id: string,
  agent_id?: string,
  kind: "watch" | "reminder" = "watch",
): Promise<string> {
  const { rows } = await client.query<{
    sensor_id: string;
    agent_id: string;
    project_id: string;
    expires_at: Date;
  }>(
    `SELECT sensor_id, agent_id, project_id, expires_at FROM agent_sensor_events
      WHERE account_id=$1 AND kind=$3 AND released_at IS NULL
        AND expires_at > now() AND ($2::uuid IS NULL OR agent_id=$2)
      ORDER BY created LIMIT 10`,
    [account_id, agent_id ?? null, kind],
  );
  if (rows.length === 0) return "";
  const list = rows
    .map(
      (r) =>
        `${r.sensor_id} (agent ${r.agent_id}, project ${r.project_id}, counted until ${new Date(r.expires_at).toISOString()})`,
    )
    .join("; ");
  return `Active: ${list}. An agent can delete its own with \`cocalc sensor delete <id>\`; a person can delete any in that agent's Sensors panel.`;
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
     WHERE event_id=$1 AND account_id=$2 AND kind IN ('watch', 'reminder')
       AND released_at IS NULL`,
    [sensor_id, account_id],
  );
}

/** Budgets look back one day; watchers count until they expire. */
export async function pruneSensorEvents(): Promise<void> {
  await agentStore().query(
    `DELETE FROM agent_sensor_events WHERE created < now() - interval '2 days'
       AND (expires_at IS NULL OR expires_at < now()
            OR released_at < now() - interval '1 day')`,
  );
}

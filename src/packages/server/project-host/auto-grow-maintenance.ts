/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import {
  loadBackgroundAutoGrowHistory,
  maybeAutoGrowHostDiskForBackgroundPressure,
} from "./auto-grow";

const logger = getLogger("server:project-host:auto-grow-maintenance");
const CHECK_INTERVAL_MS = Math.max(
  60_000,
  Number(
    process.env.COCALC_HOST_AUTO_GROW_BACKGROUND_INTERVAL_MS ?? 3 * 60_000,
  ),
);
const HOST_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const LOCK_KEY = "project_host_auto_grow_background_maintenance";

let started = false;

type CandidateHostRow = {
  id: string;
};

async function withMaintenanceLock<T>(
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const pool = getPool("medium");
  const { rows } = await pool.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    [LOCK_KEY],
  );
  if (!rows[0]?.locked) {
    return undefined;
  }
  try {
    return await fn();
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
  }
}

async function listCandidateHostIds(): Promise<string[]> {
  const { rows } = await getPool().query<CandidateHostRow>(
    `
      SELECT id
      FROM project_hosts
      WHERE deleted IS NULL
        AND status = 'running'
        AND last_seen >= NOW() - ($1::text || ' milliseconds')::interval
      ORDER BY updated DESC
    `,
    [HOST_ONLINE_WINDOW_MS],
  );
  return rows.map(({ id }) => id).filter(Boolean);
}

async function runBackgroundAutoGrowPass(): Promise<void> {
  const host_ids = await listCandidateHostIds();
  if (!host_ids.length) return;
  const historyByHost = await loadBackgroundAutoGrowHistory(host_ids);
  for (const host_id of host_ids) {
    const result = await maybeAutoGrowHostDiskForBackgroundPressure({
      host_id,
      history: historyByHost.get(host_id),
    });
    if (result.grown) {
      logger.info("background auto-grow completed", {
        host_id,
        next_disk_gb: result.next_disk_gb,
      });
    }
  }
}

export function startBackgroundAutoGrowMaintenance(): void {
  if (started) {
    return;
  }
  started = true;
  logger.info("starting background host auto-grow maintenance loop", {
    CHECK_INTERVAL_MS,
    HOST_ONLINE_WINDOW_MS,
  });
  const run = async () => {
    try {
      await withMaintenanceLock(runBackgroundAutoGrowPass);
    } catch (err) {
      logger.error("background host auto-grow maintenance failed", err);
    }
  };
  void run();
  const timer = setInterval(() => {
    void run();
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

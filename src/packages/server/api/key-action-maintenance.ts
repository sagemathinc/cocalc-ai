/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import { API_KEY_ACTION_HISTORY_RETENTION_MS } from "@cocalc/util/api-key-management";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { ApiKeyActionStore } from "./key-action-store";

const log = getLogger("api:key-action-maintenance");
const BATCH = 32;

export async function cleanupApiKeyActionHistory(
  cursor?: string,
): Promise<{ cursor?: string; scanned: number; deleted: number }> {
  const pool = getPool();
  const store = new ApiKeyActionStore(pool);
  await store.ensureSchema();
  const { rows } = await pool.query<{ account_id: string }>(
    `SELECT a.account_id FROM accounts a
     WHERE a.deleted IS NOT TRUE AND COALESCE(a.home_bay_id,$1)=$1
       AND ($2::uuid IS NULL OR a.account_id>$2::uuid)
       AND EXISTS (SELECT 1 FROM api_key_action_requests r
         WHERE r.account_id=a.account_id AND r.expires_at <
           extract(epoch from clock_timestamp())*1000-$3)
     ORDER BY a.account_id LIMIT $4`,
    [
      getConfiguredBayId(),
      cursor ?? null,
      API_KEY_ACTION_HISTORY_RETENTION_MS,
      BATCH,
    ],
  );
  const counts = await mapParallelLimit(
    rows,
    async ({ account_id }) => {
      try {
        return await store.pruneExpired(account_id);
      } catch (error) {
        log.warn("API approval history cleanup deferred", {
          account_id,
          error,
        });
        return 0;
      }
    },
    4,
  );
  return {
    cursor: rows.at(-1)?.account_id,
    scanned: rows.length,
    deleted: counts.reduce((sum, n) => sum + n, 0),
  };
}

let stopRunning: (() => void) | undefined;
export function startApiKeyActionMaintenance(): () => void {
  if (stopRunning) return stopRunning;
  let stopped = false;
  let cursor: string | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number) => {
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  const tick = async () => {
    let delay = 60_000;
    try {
      const result = await cleanupApiKeyActionHistory(cursor);
      cursor = result.cursor;
      if (result.scanned) delay = 1_000;
    } catch (error) {
      log.warn("API approval history maintenance failed", { error });
    }
    if (!stopped) schedule(delay);
  };
  stopRunning = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    stopRunning = undefined;
  };
  schedule(1_000);
  return stopRunning;
}

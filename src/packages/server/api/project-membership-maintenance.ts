/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectApiKeyRevocation } from "./project-membership-revocation";

const log = getLogger("api:project-membership-maintenance");
const BATCH = 32;
type Cursor = { project_id: string; account_id: string };

export async function reconcileProjectApiKeyRevocations(
  cursor?: Cursor,
): Promise<{ cursor?: Cursor; scanned: number; resolved: number }> {
  const { rows } = await getPool().query<Cursor & { generation: string }>(
    `SELECT p.project_id,member.key AS account_id,member.value->>'generation' AS generation
     FROM projects p CROSS JOIN LATERAL jsonb_each(p.api_key_membership_revocations) member
     WHERE p.api_key_membership_pending IS TRUE AND p.deleted IS NOT TRUE
       AND COALESCE(p.owning_bay_id,$1)=$1
       AND member.value->'pending'='true'::jsonb
       AND ($2::uuid IS NULL OR (p.project_id,member.key)>($2::uuid,$3::text))
     ORDER BY p.project_id,member.key LIMIT $4`,
    [
      getConfiguredBayId(),
      cursor?.project_id ?? null,
      cursor?.account_id ?? null,
      BATCH,
    ],
  );
  const resolved = await mapParallelLimit(
    rows,
    async (row) => {
      try {
        return Number(await resolveProjectApiKeyRevocation(row));
      } catch (error) {
        log.warn("project API delegation reconciliation deferred", {
          ...row,
          error,
        });
        return 0;
      }
    },
    4,
  );
  const last = rows.at(-1);
  return {
    scanned: rows.length,
    resolved: resolved.reduce((sum, n) => sum + n, 0),
    cursor: last
      ? { project_id: last.project_id, account_id: last.account_id }
      : undefined,
  };
}

let stopRunning: (() => void) | undefined;
export function startProjectApiKeyRevocationMaintenance(): () => void {
  if (stopRunning) return stopRunning;
  let stopped = false;
  let cursor: Cursor | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number) => {
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  const tick = async () => {
    let delay = 5_000;
    try {
      const result = await reconcileProjectApiKeyRevocations(cursor);
      cursor = result.cursor;
      if (result.scanned === BATCH) delay = 1_000;
    } catch (error) {
      log.warn("project API delegation maintenance failed", { error });
      delay = 30_000;
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

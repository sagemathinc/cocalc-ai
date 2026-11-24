/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { HostPressurePolicy } from "@cocalc/conat/hub/api/hosts";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

// The calling host's pressure policy: a host outside the shared pool (a
// private host) is watch-only. Answered only by the bay that owns the host,
// from its own row; any other case is an error, never a value.
export async function getPressurePolicy({
  host_id,
}: {
  host_id?: string;
} = {}): Promise<HostPressurePolicy> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  const { rows } = await getPool().query<{
    tier: number | null;
    bay_id: string | null;
  }>(
    "SELECT tier, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  if (`${row.bay_id ?? ""}` !== getConfiguredBayId()) {
    throw new Error("host is not owned by this bay");
  }
  const watch_only = row.tier == null;
  return {
    host_id,
    watch_only,
    reason: watch_only ? "private_host" : "shared_pool",
    evaluated_at: new Date().toISOString(),
  };
}

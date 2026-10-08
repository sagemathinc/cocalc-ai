/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Data and test hooks for the Spot recovery fallback ladder.

import { readFileSync } from "node:fs";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import type { GcpCatalogPrices } from "@cocalc/util/project-host-pricing";
import type { GcpMachineTypeEntry, LadderRung } from "./fallback-ladder";

const logger = getLogger("server:cloud:fallback-ladder");

export async function loadGcpZoneMachineTypes(
  zone: string,
): Promise<GcpMachineTypeEntry[]> {
  const { rows } = await getPool("medium").query(
    `SELECT payload
       FROM cloud_catalog_cache
      WHERE provider='gcp' AND kind='machine_types' AND scope=$1
      ORDER BY fetched_at DESC NULLS LAST
      LIMIT 1`,
    [`zone/${zone}`],
  );
  const payload = rows[0]?.payload;
  return Array.isArray(payload) ? payload : [];
}

export async function loadGcpCatalogPrices(): Promise<
  GcpCatalogPrices | undefined
> {
  const { rows } = await getPool("medium").query(
    `SELECT payload
       FROM cloud_catalog_cache
      WHERE provider='gcp' AND kind='prices'
      ORDER BY fetched_at DESC NULLS LAST
      LIMIT 1`,
  );
  const payload = rows[0]?.payload;
  return payload && typeof payload === "object"
    ? (payload as GcpCatalogPrices)
    : undefined;
}

// Test-only fault injection, so staging can exercise every rung without a
// real stockout. Disabled unless COCALC_SPOT_RECOVERY_FAULTS_FILE is set on
// the bay; the file is re-read on every start attempt so tests can edit it.
//   {"rules": [{"host_id": "...", "pricing": "spot",
//               "machine_type": "t2d-standard-2",
//               "error": "ZONE_RESOURCE_POOL_EXHAUSTED"}]}
export interface StartFaultRule {
  host_id?: string;
  pricing?: LadderRung["pricing"];
  machine_type?: string;
  error: string;
}

export function injectedStartFault(opts: {
  host_id: string;
  pricing: LadderRung["pricing"];
  machine_type: string;
}): string | undefined {
  const path = `${process.env.COCALC_SPOT_RECOVERY_FAULTS_FILE ?? ""}`.trim();
  if (!path) return undefined;
  let rules: StartFaultRule[] = [];
  try {
    rules = JSON.parse(readFileSync(path, "utf8"))?.rules ?? [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn("ignoring unreadable spot recovery fault file", {
        path,
        err: `${err}`,
      });
    }
    return undefined;
  }
  const rule = (Array.isArray(rules) ? rules : []).find(
    (rule) =>
      rule &&
      typeof rule.error === "string" &&
      (!rule.host_id || rule.host_id === opts.host_id) &&
      (!rule.pricing || rule.pricing === opts.pricing) &&
      (!rule.machine_type || rule.machine_type === opts.machine_type),
  );
  if (!rule) return undefined;
  logger.warn("injecting spot recovery start fault", { ...opts, rule });
  return rule.error;
}

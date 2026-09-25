/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { PoolClient } from "pg";
import getPool from "@cocalc/database/pool";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/** Credit transfers are available by default when trusted financial approval
 * is configured. The site setting and environment variable are emergency
 * opt-outs; neither can make an unavailable approval service usable.
 */
export async function creditTransfersEnabled(
  db: Pick<PoolClient, "query"> = getPool(),
): Promise<boolean> {
  if (
    DISABLED_VALUES.has(
      `${process.env.COCALC_ENABLE_CREDIT_TRANSFERS ?? ""}`
        .trim()
        .toLowerCase(),
    )
  ) {
    return false;
  }
  const { rows } = await db.query<{ value: string }>(
    "SELECT value FROM server_settings WHERE name='credit_transfers_enabled'",
  );
  if (rows.length === 0) return true;
  return !DISABLED_VALUES.has(`${rows[0].value ?? ""}`.trim().toLowerCase());
}

export async function requireCreditTransfersEnabled(
  db?: Pick<PoolClient, "query">,
): Promise<void> {
  if (!(await creditTransfersEnabled(db))) {
    throw new Error("Credit transfers are disabled by the site administrator");
  }
}

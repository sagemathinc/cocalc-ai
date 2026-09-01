/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { deleteAppSubdomainDns } from "@cocalc/server/cloud/dns";

const LEGACY_TABLE = "project_app_public_subdomains";

/**
 * Remove records left by the retired public-project-app experiment.
 *
 * This is intentionally cleanup-only: it neither creates the legacy table nor
 * provides reservation or lookup APIs. Keep it until every deployment has
 * completed project hard-delete cleanup for any historical rows.
 */
export async function releaseProjectAppPublicSubdomainsForProject(opts: {
  project_id: string;
}): Promise<{ released: number }> {
  const project_id = `${opts.project_id ?? ""}`.trim();
  if (!project_id) return { released: 0 };
  const pool = getPool();
  const { rows: relationRows } = await pool.query<{
    table_name: string | null;
  }>("SELECT to_regclass($1) AS table_name", [`public.${LEGACY_TABLE}`]);
  if (!relationRows[0]?.table_name) return { released: 0 };
  const { rows } = await pool.query(
    `DELETE FROM ${LEGACY_TABLE}
      WHERE project_id=$1
      RETURNING hostname, dns_record_id`,
    [project_id],
  );
  for (const row of rows) {
    await deleteAppSubdomainDns({
      record_id: row.dns_record_id ?? undefined,
      hostname: row.hostname ?? undefined,
    });
  }
  return { released: rows.length };
}

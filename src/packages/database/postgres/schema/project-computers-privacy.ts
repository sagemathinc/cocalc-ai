/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Retired: computers no longer depend on a project's public shares (only on
// its collaborators), so the public_project_paths trigger that counted
// shares and fenced share changes for computers is removed wherever an
// earlier development build installed it, together with its helper table.
// Share changes are then unrestricted again. The unused projects columns
// (computers_public_shares, computers_share_state_known,
// computers_privacy_revision) are left alone where they exist.
//
// Only the exact objects that build installed are touched: in schema
// "public", found and dropped by schema-qualified name, never through
// search_path (a same-named object elsewhere is left alone).

import type { Client } from "@cocalc/database/pool";

const TRIGGER = "public_project_paths_bump_computers_privacy_trigger";
const FUNCTION = "public.public_project_paths_bump_computers_privacy()";
const TABLE = "public.computers_local_bay";
const SHARES = "public.public_project_paths";

interface Retired {
  trigger: boolean;
  fn: boolean;
  table: boolean;
}

async function retiredObjects(db: Client): Promise<Retired> {
  const { rows } = await db.query<Retired>(
    `SELECT
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = $1 AND NOT tgisinternal
                  AND tgrelid = to_regclass($2)) AS trigger,
       to_regprocedure($3) IS NOT NULL AS fn,
       to_regclass($4) IS NOT NULL AS "table"`,
    [TRIGGER, SHARES, FUNCTION, TABLE],
  );
  return rows[0] ?? { trigger: false, fn: false, table: false };
}

export async function retireProjectComputersPrivacySchema(
  db: Client,
): Promise<void> {
  const present = await retiredObjects(db);
  if (!present.trigger && !present.fn && !present.table) return;
  await db.query("BEGIN");
  try {
    if (present.trigger) {
      await db.query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON ${SHARES}`);
    }
    if (present.fn) await db.query(`DROP FUNCTION IF EXISTS ${FUNCTION}`);
    if (present.table) await db.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export async function projectComputersPrivacySchemaNeedsSync(
  db: Client,
): Promise<boolean> {
  const present = await retiredObjects(db);
  return present.trigger || present.fn || present.table;
}

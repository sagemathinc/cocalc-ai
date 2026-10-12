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

import type { Client } from "@cocalc/database/pool";

const TRIGGER = "public_project_paths_bump_computers_privacy_trigger";
const FUNCTION = "public_project_paths_bump_computers_privacy";
const LOCAL_BAY_TABLE = "computers_local_bay";

async function retiredObjectsPresent(db: Client): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname=$1 AND NOT tgisinternal)
         OR EXISTS (SELECT 1 FROM pg_proc WHERE proname=$2)
         OR to_regclass($3) IS NOT NULL AS present`,
    [TRIGGER, FUNCTION, `public.${LOCAL_BAY_TABLE}`],
  );
  return rows[0]?.present === true;
}

export async function retireProjectComputersPrivacySchema(
  db: Client,
): Promise<void> {
  if (!(await retiredObjectsPresent(db))) return;
  await db.query("BEGIN");
  try {
    if (
      (await db.query("SELECT to_regclass('public.public_project_paths') AS t"))
        .rows[0]?.t != null
    ) {
      await db.query(
        `DROP TRIGGER IF EXISTS ${TRIGGER} ON public_project_paths`,
      );
    }
    await db.query(`DROP FUNCTION IF EXISTS ${FUNCTION}()`);
    await db.query(`DROP TABLE IF EXISTS ${LOCAL_BAY_TABLE}`);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export async function projectComputersPrivacySchemaNeedsSync(
  db: Client,
): Promise<boolean> {
  return await retiredObjectsPresent(db);
}

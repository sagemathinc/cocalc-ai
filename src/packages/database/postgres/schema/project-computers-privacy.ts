/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Computers attest a project's privacy epoch: runtime_authority_revision
// (bumped by a trigger on every change to projects.users) plus
// computers_privacy_revision, bumped here by a trigger on every change to the
// project's public shares, whatever code path makes it (including legacy
// replay). Both only grow, so the sum advances on any change that can make a
// project stop being private. The bump updates the projects row in the same
// transaction as the share change, so an attestation that reads the row FOR
// SHARE either sees the change or blocks it until it commits.
// Plan: src/.agents/computers-plan-2026-10-11.md ("Privacy fence").

import type { Client } from "@cocalc/database/pool";

const TRIGGER = "public_project_paths_bump_computers_privacy_trigger";
const FUNCTION = "public_project_paths_bump_computers_privacy";
const CONTRACT = "computers-privacy-contract-v1";

const FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${FUNCTION}()
   RETURNS TRIGGER AS $$
   -- ${CONTRACT}
   BEGIN
     IF TG_OP <> 'INSERT' THEN
       UPDATE projects
          SET computers_privacy_revision = COALESCE(computers_privacy_revision, 0) + 1
        WHERE project_id = OLD.project_id;
     END IF;
     IF TG_OP <> 'DELETE' AND
        (TG_OP = 'INSERT' OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
       UPDATE projects
          SET computers_privacy_revision = COALESCE(computers_privacy_revision, 0) + 1
        WHERE project_id = NEW.project_id;
     END IF;
     RETURN NULL;
   END;
   $$ LANGUAGE plpgsql`;

async function triggerExists(db: Client): Promise<boolean> {
  const { rows } = await db.query<{ trigger_exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgname=$1 AND tgrelid='public_project_paths'::regclass
          AND NOT tgisinternal
     ) AS trigger_exists`,
    [TRIGGER],
  );
  return rows[0]?.trigger_exists === true;
}

export async function ensureProjectComputersPrivacySchema(
  db: Client,
): Promise<void> {
  if (await triggerExists(db)) {
    await db.query(FUNCTION_SQL);
    return;
  }
  await db.query("BEGIN");
  try {
    // No share change may slip past while the trigger is being installed.
    await db.query(
      "LOCK TABLE public_project_paths IN SHARE ROW EXCLUSIVE MODE",
    );
    await db.query(FUNCTION_SQL);
    if (!(await triggerExists(db))) {
      await db.query(
        `CREATE TRIGGER ${TRIGGER}
           AFTER INSERT OR UPDATE OR DELETE
           ON public_project_paths
           FOR EACH ROW
           EXECUTE FUNCTION ${FUNCTION}()`,
      );
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export async function projectComputersPrivacySchemaNeedsSync(
  db: Client,
): Promise<boolean> {
  if (!(await triggerExists(db))) return true;
  const { rows } = await db.query<{ current: boolean }>(
    `SELECT position($1 IN pg_get_functiondef('${FUNCTION}()'::regprocedure)) > 0 AS current`,
    [CONTRACT],
  );
  return rows[0]?.current !== true;
}

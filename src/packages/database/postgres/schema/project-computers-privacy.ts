/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Computers attest a project's privacy (and its share state). The epoch:
// runtime_authority_revision
// (bumped by a trigger on every change to projects.users) plus
// computers_privacy_revision, bumped here by a trigger on every change to the
// project's public shares, whatever code path makes it (including legacy
// replay). Both only grow, so the sum advances on any change that can make a
// project stop being private. The bump updates the projects row in the same
// transaction as the share change, so an attestation that reads the row FOR
// SHARE either sees the change or blocks it until it commits.
// Plan: src/.agents/computers-plan-2026-10-11.md ("Privacy fence").

import type { Client } from "@cocalc/database/pool";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";

const TRIGGER = "public_project_paths_bump_computers_privacy_trigger";
const FUNCTION = "public_project_paths_bump_computers_privacy";
const CONTRACT = "computers-privacy-contract-v3";

// For each project the change touches:
// - take the project-rehome fence and refuse while a rehome of it runs, so
//   the project row a rehome copies can't miss a share change;
// - refuse to make a share active on a bay that no longer owns the project
//   (its share rows stay behind on a rehome), so a stale share can't come
//   back to life where the new owner can't see it; disabling is allowed;
// - advance computers_privacy_revision (the epoch);
// - recount computers_public_shares (the state, which moves with the row).
const FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${FUNCTION}()
   RETURNS TRIGGER AS $$
   -- ${CONTRACT}
   DECLARE
     pid uuid;
     running text;
   BEGIN
     FOR pid IN
       SELECT DISTINCT x FROM unnest(ARRAY[
         CASE WHEN TG_OP <> 'INSERT' THEN OLD.project_id END,
         CASE WHEN TG_OP <> 'DELETE' THEN NEW.project_id END]) AS x
        WHERE x IS NOT NULL
     LOOP
       PERFORM pg_advisory_xact_lock(hashtext('project-rehome'), hashtext(pid::text));
       IF TG_OP <> 'DELETE' AND pid = NEW.project_id
          AND NEW.disabled IS NOT TRUE
          AND NEW.visibility IS DISTINCT FROM 'disabled'
          AND EXISTS (
            SELECT 1 FROM projects p, computers_local_bay b
             WHERE p.project_id = pid
               AND NULLIF(btrim(p.owning_bay_id), '') IS NOT NULL
               AND p.owning_bay_id <> b.bay_id) THEN
         RAISE EXCEPTION 'project % is owned by another bay; change its public shares there', pid;
       END IF;
       IF to_regclass('public.project_rehome_operations') IS NOT NULL THEN
         EXECUTE 'SELECT op_id::text FROM project_rehome_operations
                   WHERE project_id = $1 AND status = ''running'' LIMIT 1'
           INTO running USING pid;
         IF running IS NOT NULL THEN
           RAISE EXCEPTION 'cannot change public shares of project % while project rehome % is running', pid, running;
         END IF;
       END IF;
       UPDATE projects
          SET computers_privacy_revision = COALESCE(computers_privacy_revision, 0) + 1,
              computers_public_shares = (
                SELECT count(*) FROM public_project_paths s
                 WHERE s.project_id = pid AND s.disabled IS NOT TRUE
                   AND s.visibility IS DISTINCT FROM 'disabled')
        WHERE project_id = pid;
     END LOOP;
     RETURN NULL;
   END;
   $$ LANGUAGE plpgsql`;

/** Shares that existed before the trigger: count them once. */
const BACKFILL_SQL = `UPDATE projects p
    SET computers_public_shares = c.n
   FROM (SELECT project_id, count(*) AS n FROM public_project_paths
          WHERE disabled IS NOT TRUE AND visibility IS DISTINCT FROM 'disabled'
          GROUP BY project_id) c
  WHERE p.project_id = c.project_id
    AND p.computers_public_shares IS DISTINCT FROM c.n`;

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

/** This bay's id, for the trigger's owner check (env as in bay-config). */
async function ensureLocalBay(db: Client): Promise<void> {
  const bay_id = `${process.env.COCALC_BAY_ID ?? ""}`.trim() || DEFAULT_BAY_ID;
  await db.query(
    "CREATE TABLE IF NOT EXISTS computers_local_bay (singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), bay_id TEXT NOT NULL)",
  );
  await db.query(
    `INSERT INTO computers_local_bay (singleton, bay_id) VALUES (true, $1)
     ON CONFLICT (singleton) DO UPDATE SET bay_id = EXCLUDED.bay_id
     WHERE computers_local_bay.bay_id IS DISTINCT FROM EXCLUDED.bay_id`,
    [bay_id],
  );
}

export async function ensureProjectComputersPrivacySchema(
  db: Client,
): Promise<void> {
  await ensureLocalBay(db);
  if (await triggerExists(db)) {
    if (await functionIsCurrent(db)) return;
    // Upgrading the function (e.g. v1 had no share count): replace it and
    // count existing shares, with share writers blocked so none is missed.
    await db.query("BEGIN");
    try {
      await db.query(
        "LOCK TABLE public_project_paths IN SHARE ROW EXCLUSIVE MODE",
      );
      await db.query(FUNCTION_SQL);
      await db.query(BACKFILL_SQL);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
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
    await db.query(BACKFILL_SQL);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

async function functionIsCurrent(db: Client): Promise<boolean> {
  const { rows } = await db.query<{ current: boolean }>(
    `SELECT position($1 IN pg_get_functiondef('${FUNCTION}()'::regprocedure)) > 0 AS current`,
    [CONTRACT],
  );
  return rows[0]?.current === true;
}

export async function projectComputersPrivacySchemaNeedsSync(
  db: Client,
): Promise<boolean> {
  if (!(await triggerExists(db))) return true;
  return !(await functionIsCurrent(db));
}

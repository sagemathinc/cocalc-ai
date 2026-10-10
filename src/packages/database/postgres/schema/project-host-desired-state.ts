/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/database/pool";

// A host's desired_state (in metadata) changes only together with
// desired_state_generation. Many writers save back whole metadata objects read
// earlier; without this guard a stale one could silently flip a stop back to
// running (or the reverse). Intentional changes bump the generation in the
// same statement; any other change to desired_state is reverted.
export const PROJECT_HOST_DESIRED_STATE_TRIGGER =
  "project_hosts_guard_desired_state_trigger";
const PROJECT_HOST_DESIRED_STATE_FUNCTION = "project_hosts_guard_desired_state";
const CONTRACT = "desired-state-generation-v1";

const CREATE_OR_REPLACE_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${PROJECT_HOST_DESIRED_STATE_FUNCTION}()
   RETURNS TRIGGER AS $$
   -- ${CONTRACT}
   BEGIN
     IF NEW.desired_state_generation IS NOT DISTINCT FROM OLD.desired_state_generation
        AND (NEW.metadata->'desired_state') IS DISTINCT FROM (OLD.metadata->'desired_state') THEN
       IF OLD.metadata ? 'desired_state' THEN
         NEW.metadata := jsonb_set(
           COALESCE(NEW.metadata, '{}'::jsonb),
           '{desired_state}',
           OLD.metadata->'desired_state'
         );
       ELSE
         NEW.metadata := NEW.metadata - 'desired_state';
       END IF;
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`;

async function triggerExists(db: Client): Promise<boolean> {
  const { rows } = await db.query<{ trigger_exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_trigger
        WHERE tgname=$1
          AND tgrelid='project_hosts'::regclass
          AND NOT tgisinternal
     ) AS trigger_exists`,
    [PROJECT_HOST_DESIRED_STATE_TRIGGER],
  );
  return rows[0]?.trigger_exists === true;
}

export async function ensureProjectHostDesiredStateSchema(
  db: Client,
): Promise<void> {
  if (await triggerExists(db)) {
    await db.query(CREATE_OR_REPLACE_FUNCTION_SQL);
    return;
  }
  await db.query("BEGIN");
  try {
    await db.query("LOCK TABLE project_hosts IN SHARE ROW EXCLUSIVE MODE");
    await db.query(CREATE_OR_REPLACE_FUNCTION_SQL);
    if (!(await triggerExists(db))) {
      await db.query(
        `CREATE TRIGGER ${PROJECT_HOST_DESIRED_STATE_TRIGGER}
           BEFORE UPDATE
           ON project_hosts
           FOR EACH ROW
           EXECUTE FUNCTION ${PROJECT_HOST_DESIRED_STATE_FUNCTION}()`,
      );
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export async function projectHostDesiredStateSchemaNeedsSync(
  db: Client,
): Promise<boolean> {
  if (!(await triggerExists(db))) return true;
  const { rows } = await db.query<{ current: boolean }>(
    `SELECT position($1 IN
       pg_get_functiondef('${PROJECT_HOST_DESIRED_STATE_FUNCTION}()'::regprocedure)) > 0 AS current`,
    [CONTRACT],
  );
  return rows[0]?.current !== true;
}

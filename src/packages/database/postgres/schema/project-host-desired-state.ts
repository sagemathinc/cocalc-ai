/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/database/pool";

// A host's desired_state (in metadata) is meant to change only together with
// desired_state_generation. Many writers save back whole metadata objects read
// earlier; a stale one could silently flip a stop back to running (or the
// reverse). Intentional changes bump the generation in the same statement.
//
// Rollout in two phases, because hub workers restart one at a time and an
// older worker's intentional change does not bump the generation:
//
// - Phase 1 (ENFORCE_DESIRED_STATE_GUARD = false, this release): the trigger
//   only records each change it would revert in cloud_vm_log, as action
//   'desired_state_unversioned_change'.
// - Phase 2 (a later release sets it to true): the trigger reverts them.
//
// Gate for phase 2 (every bay):
// (a) every process that writes project_hosts runs phase 1;
// (b) no unversioned start/stop work is left:
//       SELECT count(*) FROM cloud_vm_work
//        WHERE state IN ('queued','in_progress') AND action IN ('start','stop')
//          AND NULLIF(payload->>'intent_generation','') IS NULL;
// (c) no unversioned change for at least a day since (a):
//       SELECT count(*), max(ts) FROM cloud_vm_log
//        WHERE action='desired_state_unversioned_change' AND ts > <time of (a)>;
//     Any row names a writer to fix first (its runtime holds from/to).
export const ENFORCE_DESIRED_STATE_GUARD = false;

export const PROJECT_HOST_DESIRED_STATE_TRIGGER =
  "project_hosts_guard_desired_state_trigger";
const PROJECT_HOST_DESIRED_STATE_FUNCTION = "project_hosts_guard_desired_state";
function contract(enforce: boolean): string {
  return `desired-state-generation-v1-${enforce ? "enforce" : "observe"}`;
}
const CONTRACT = contract(ENFORCE_DESIRED_STATE_GUARD);

// Exported for tests of both modes.
export function desiredStateGuardFunctionSql(enforce: boolean): string {
  const onUnversionedChange = enforce
    ? `IF OLD.metadata ? 'desired_state' THEN
         NEW.metadata := jsonb_set(
           COALESCE(NEW.metadata, '{}'::jsonb),
           '{desired_state}',
           OLD.metadata->'desired_state'
         );
       ELSE
         NEW.metadata := NEW.metadata - 'desired_state';
       END IF;`
    : `INSERT INTO cloud_vm_log (id, vm_id, ts, action, status, runtime)
       VALUES (
         gen_random_uuid(),
         OLD.id::text,
         NOW(),
         'desired_state_unversioned_change',
         'warning',
         jsonb_build_object(
           'from', OLD.metadata->'desired_state',
           'to', NEW.metadata->'desired_state',
           'generation', OLD.desired_state_generation
         )
       );`;
  return `CREATE OR REPLACE FUNCTION ${PROJECT_HOST_DESIRED_STATE_FUNCTION}()
   RETURNS TRIGGER AS $$
   -- ${contract(enforce)}
   BEGIN
     IF NEW.desired_state_generation IS NOT DISTINCT FROM OLD.desired_state_generation
        AND (NEW.metadata->'desired_state') IS DISTINCT FROM (OLD.metadata->'desired_state') THEN
       ${onUnversionedChange}
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`;
}

const CREATE_OR_REPLACE_FUNCTION_SQL = desiredStateGuardFunctionSql(
  ENFORCE_DESIRED_STATE_GUARD,
);

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

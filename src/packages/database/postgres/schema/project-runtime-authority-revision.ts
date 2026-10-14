/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/database/pool";

export const PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER =
  "projects_bump_runtime_authority_revision_trigger";
const PROJECT_RUNTIME_AUTHORITY_REVISION_FUNCTION =
  "projects_bump_runtime_authority_revision";
const MEMBERSHIP_CONTRACT = "api-key-membership-contract-v2";
// Soft delete and undelete are authority changes too: a computer's daemon
// stops a project's work below the new revision (its privacy epoch).
const DELETED_CONTRACT = "authority-on-deleted-v1";

const CREATE_OR_REPLACE_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${PROJECT_RUNTIME_AUTHORITY_REVISION_FUNCTION}()
   RETURNS TRIGGER AS $$
   -- ${MEMBERSHIP_CONTRACT}
   -- ${DELETED_CONTRACT}
   DECLARE
     member RECORD;
   BEGIN
     IF NEW.users IS DISTINCT FROM OLD.users
        OR NEW.deleted IS DISTINCT FROM OLD.deleted THEN
       NEW.runtime_authority_revision :=
         COALESCE(OLD.runtime_authority_revision, 0) + 1;
     END IF;
     IF NEW.users IS DISTINCT FROM OLD.users THEN
       FOR member IN SELECT key, value FROM jsonb_each(COALESCE(OLD.users, '{}'::jsonb)) LOOP
         IF COALESCE(member.value->>'group', member.value#>>'{}') IN ('owner', 'collaborator')
            AND COALESCE(NEW.users->member.key->>'group', (NEW.users->member.key)#>>'{}', '') NOT IN ('owner', 'collaborator') THEN
           NEW.api_key_membership_revocations := jsonb_set(
             COALESCE(NEW.api_key_membership_revocations, '{}'::jsonb),
             ARRAY[member.key],
             COALESCE(OLD.api_key_membership_revocations->member.key, '{}'::jsonb) ||
               jsonb_build_object('generation', gen_random_uuid()::text, 'pending', true));
           NEW.api_key_membership_pending := true;
         END IF;
       END LOOP;
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
          AND tgrelid='projects'::regclass
          AND NOT tgisinternal
     ) AS trigger_exists`,
    [PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER],
  );
  return rows[0]?.trigger_exists === true;
}

/** The trigger exists and fires on both users and deleted. */
async function triggerCurrent(db: Client): Promise<boolean> {
  const { rows } = await db.query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_trigger t
        WHERE t.tgname=$1
          AND t.tgrelid='projects'::regclass
          AND NOT t.tgisinternal
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                 FROM pg_attribute a
                WHERE a.attrelid=t.tgrelid AND a.attnum = ANY(t.tgattr))
              = ARRAY['deleted','users']
     ) AS current`,
    [PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER],
  );
  return rows[0]?.current === true;
}

export async function ensureProjectRuntimeAuthorityRevisionSchema(
  db: Client,
): Promise<void> {
  await db.query(
    `CREATE INDEX IF NOT EXISTS projects_api_key_membership_pending_idx
       ON projects(project_id) WHERE api_key_membership_pending IS TRUE`,
  );
  if (await triggerCurrent(db)) {
    // CREATE OR REPLACE preserves the trigger binding and never exposes an
    // unprotected collaborator-update window during routine schema sync.
    await db.query(CREATE_OR_REPLACE_FUNCTION_SQL);
    return;
  }

  await db.query("BEGIN");
  try {
    // Block project-row writers while installation (or the upgrade of a
    // trigger that fired on users only) establishes the trigger boundary.
    // Reads and ordinary project starts continue.
    await db.query("LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE");
    await db.query(CREATE_OR_REPLACE_FUNCTION_SQL);
    if (!(await triggerCurrent(db))) {
      if (await triggerExists(db)) {
        await db.query(
          `DROP TRIGGER ${PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER} ON projects`,
        );
      }
      await db.query(
        `CREATE TRIGGER ${PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER}
           BEFORE UPDATE OF users, deleted
           ON projects
           FOR EACH ROW
           EXECUTE FUNCTION ${PROJECT_RUNTIME_AUTHORITY_REVISION_FUNCTION}()`,
      );
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export async function projectRuntimeAuthorityRevisionSchemaNeedsSync(
  db: Client,
): Promise<boolean> {
  if (!(await triggerCurrent(db))) return true;
  const { rows } = await db.query<{ current: boolean }>(
    `SELECT position($1 IN
       pg_get_functiondef('projects_bump_runtime_authority_revision()'::regprocedure)) > 0
       AND position($2 IN
       pg_get_functiondef('projects_bump_runtime_authority_revision()'::regprocedure)) > 0
       AND to_regclass('projects_api_key_membership_pending_idx') IS NOT NULL AS current`,
    [MEMBERSHIP_CONTRACT, DELETED_CONTRACT],
  );
  return rows[0]?.current !== true;
}

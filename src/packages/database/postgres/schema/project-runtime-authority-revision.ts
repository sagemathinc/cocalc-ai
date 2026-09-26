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

const CREATE_OR_REPLACE_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${PROJECT_RUNTIME_AUTHORITY_REVISION_FUNCTION}()
   RETURNS TRIGGER AS $$
   -- ${MEMBERSHIP_CONTRACT}
   DECLARE
     member RECORD;
   BEGIN
     IF NEW.users IS DISTINCT FROM OLD.users THEN
       NEW.runtime_authority_revision :=
         COALESCE(OLD.runtime_authority_revision, 0) + 1;
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

export async function ensureProjectRuntimeAuthorityRevisionSchema(
  db: Client,
): Promise<void> {
  await db.query(
    `CREATE INDEX IF NOT EXISTS projects_api_key_membership_pending_idx
       ON projects(project_id) WHERE api_key_membership_pending IS TRUE`,
  );
  if (await triggerExists(db)) {
    // CREATE OR REPLACE preserves the trigger binding and never exposes an
    // unprotected collaborator-update window during routine schema sync.
    await db.query(CREATE_OR_REPLACE_FUNCTION_SQL);
    return;
  }

  await db.query("BEGIN");
  try {
    // Block project-row writers while first installation establishes the
    // trigger boundary. Reads and ordinary project starts continue.
    await db.query("LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE");
    await db.query(CREATE_OR_REPLACE_FUNCTION_SQL);
    if (!(await triggerExists(db))) {
      await db.query(
        `CREATE TRIGGER ${PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER}
           BEFORE UPDATE OF users
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
  if (!(await triggerExists(db))) return true;
  const { rows } = await db.query<{ current: boolean }>(
    `SELECT position($1 IN
       pg_get_functiondef('projects_bump_runtime_authority_revision()'::regprocedure)) > 0
       AND to_regclass('projects_api_key_membership_pending_idx') IS NOT NULL AS current`,
    [MEMBERSHIP_CONTRACT],
  );
  return rows[0]?.current !== true;
}

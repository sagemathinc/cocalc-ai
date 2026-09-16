/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/database/pool";

export const PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER =
  "projects_bump_runtime_authority_revision_trigger";
const PROJECT_RUNTIME_AUTHORITY_REVISION_FUNCTION =
  "projects_bump_runtime_authority_revision";

export async function ensureProjectRuntimeAuthorityRevisionSchema(
  db: Client,
): Promise<void> {
  await db.query(
    `CREATE OR REPLACE FUNCTION ${PROJECT_RUNTIME_AUTHORITY_REVISION_FUNCTION}()
     RETURNS TRIGGER AS $$
     BEGIN
       IF NEW.users IS DISTINCT FROM OLD.users THEN
         NEW.runtime_authority_revision :=
           COALESCE(OLD.runtime_authority_revision, 0) + 1;
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
  );
  await db.query(
    `DROP TRIGGER IF EXISTS ${PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER}
       ON projects`,
  );
  await db.query(
    `CREATE TRIGGER ${PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER}
       BEFORE UPDATE OF users
       ON projects
       FOR EACH ROW
       EXECUTE FUNCTION ${PROJECT_RUNTIME_AUTHORITY_REVISION_FUNCTION}()`,
  );
}

export async function projectRuntimeAuthorityRevisionSchemaNeedsSync(
  db: Client,
): Promise<boolean> {
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
  return rows[0]?.trigger_exists !== true;
}

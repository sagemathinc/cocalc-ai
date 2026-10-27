/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
An audit record, kept on the bay and not deletable by project users, of every
grant of project access: one central_log row per project change, written by a
trigger on projects.users so that no code path can add someone silently.

- project_collaborator_added: accounts that became owner, collaborator or
  viewer of the project.
- project_collaborator_role_changed: accounts whose role changed (for example
  viewer to collaborator, or collaborator to owner in an ownership transfer).

Removals are recorded by the code that removes (project_collaborator_removed).
A writer says who acted and how with setProjectMembershipAuditContext in the
same transaction; a change without that context is recorded with via
"unattributed". The rows hold account and project ids only, and expire after
PROJECT_MEMBERSHIP_AUDIT_RETENTION, like the removal rows.

Recording never blocks a membership change: a failure raises a warning and is
counted in project_membership_audit_failures, which admin health reports.
*/

import type { Client } from "@cocalc/database/pool";

export const PROJECT_MEMBERSHIP_AUDIT_TRIGGER =
  "projects_audit_membership_trigger";
const PROJECT_MEMBERSHIP_AUDIT_FUNCTION = "projects_audit_membership";
// Bump when the function changes, so schema sync replaces it.
const MEMBERSHIP_AUDIT_CONTRACT = "project-membership-audit-v1";
const AUDIT_CONTEXT_SETTING = "cocalc.membership_audit";

export const PROJECT_MEMBERSHIP_ADDED_EVENT = "project_collaborator_added";
export const PROJECT_MEMBERSHIP_ROLE_CHANGED_EVENT =
  "project_collaborator_role_changed";
export const PROJECT_MEMBERSHIP_REMOVED_EVENT = "project_collaborator_removed";
export const PROJECT_MEMBERSHIP_AUDIT_EVENTS = [
  PROJECT_MEMBERSHIP_ADDED_EVENT,
  PROJECT_MEMBERSHIP_ROLE_CHANGED_EVENT,
  PROJECT_MEMBERSHIP_REMOVED_EVENT,
] as const;
// Personal data: 13 months, as for public share views (and never more than 2
// years).
export const PROJECT_MEMBERSHIP_AUDIT_RETENTION = "13 months";

export interface ProjectMembershipAuditContext {
  // Who made the change; null for system jobs.
  actor_account_id?: string | null;
  // How: e.g. invite-accept, admin-add, course-reconcile.
  via: string;
  // For an accepted invite, who sent it.
  invite_creator_account_id?: string | null;
}

// Attributes the membership changes made later in the current transaction.
// Must run on the same client, inside BEGIN ... COMMIT.
export async function setProjectMembershipAuditContext(
  db: Pick<Client, "query">,
  context: ProjectMembershipAuditContext,
): Promise<void> {
  await db.query("SELECT set_config($1, $2, true)", [
    AUDIT_CONTEXT_SETTING,
    JSON.stringify({
      actor_account_id: context.actor_account_id ?? null,
      via: context.via,
      invite_creator_account_id: context.invite_creator_account_id ?? null,
    }),
  ]);
}

// Roles that grant access. A legacy entry may be a bare string.
const GROUP_SQL = (entry: string) =>
  `CASE WHEN jsonb_typeof(${entry})='object' THEN ${entry}->>'group'
        WHEN jsonb_typeof(${entry})='string' THEN ${entry}#>>'{}' END`;

const CREATE_OR_REPLACE_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${PROJECT_MEMBERSHIP_AUDIT_FUNCTION}()
   RETURNS TRIGGER AS $$
   -- ${MEMBERSHIP_AUDIT_CONTRACT}
   DECLARE
     ctx jsonb;
     added jsonb;
     changed jsonb;
     previous jsonb;
     base jsonb;
   BEGIN
     IF TG_OP = 'UPDATE' AND NEW.users IS NOT DISTINCT FROM OLD.users THEN
       RETURN NULL;
     END IF;
     BEGIN
       ctx := NULLIF(current_setting('${AUDIT_CONTEXT_SETTING}', true), '')::jsonb;
     EXCEPTION WHEN OTHERS THEN
       ctx := NULL;
     END;
     WITH members AS (
       SELECT n.key AS account_id,
              ${GROUP_SQL("n.value")} AS grp,
              CASE WHEN TG_OP = 'UPDATE'
                   THEN ${GROUP_SQL("OLD.users->n.key")} END AS prev
         FROM jsonb_each(COALESCE(NEW.users, '{}'::jsonb)) AS n
     ), grants AS (
       SELECT account_id, grp,
              CASE WHEN prev IN ('owner','collaborator','viewer') THEN prev END AS prev
         FROM members
        WHERE grp IN ('owner','collaborator','viewer')
          -- A new project's owner is its creator, not a grant.
          AND NOT (TG_OP = 'INSERT' AND grp = 'owner')
     )
     SELECT jsonb_object_agg(account_id, grp) FILTER (WHERE prev IS NULL),
            jsonb_object_agg(account_id, grp) FILTER (WHERE prev IS NOT NULL AND prev <> grp),
            jsonb_object_agg(account_id, prev) FILTER (WHERE prev IS NOT NULL AND prev <> grp)
       INTO added, changed, previous
       FROM grants;
     IF added IS NULL AND changed IS NULL THEN
       RETURN NULL;
     END IF;
     base := jsonb_build_object(
       'project_id', NEW.project_id,
       'via', COALESCE(ctx->>'via', 'unattributed'),
       'actor_account_id', ctx->'actor_account_id',
       'invite_creator_account_id', ctx->'invite_creator_account_id');
     BEGIN
       IF added IS NOT NULL THEN
         INSERT INTO central_log(id, event, value, time, expire)
         VALUES (gen_random_uuid(), '${PROJECT_MEMBERSHIP_ADDED_EVENT}',
                 base || jsonb_build_object(
                   'added_account_ids',
                   (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(added) AS k),
                   'groups', added),
                 NOW(), NOW() + INTERVAL '${PROJECT_MEMBERSHIP_AUDIT_RETENTION}');
       END IF;
       IF changed IS NOT NULL THEN
         INSERT INTO central_log(id, event, value, time, expire)
         VALUES (gen_random_uuid(), '${PROJECT_MEMBERSHIP_ROLE_CHANGED_EVENT}',
                 base || jsonb_build_object(
                   'changed_account_ids',
                   (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(changed) AS k),
                   'groups', changed,
                   'previous_groups', previous),
                 NOW(), NOW() + INTERVAL '${PROJECT_MEMBERSHIP_AUDIT_RETENTION}');
       END IF;
     EXCEPTION WHEN OTHERS THEN
       RAISE WARNING 'project membership audit failed for %: %', NEW.project_id, SQLERRM;
       BEGIN
         INSERT INTO project_membership_audit_failures(day, failures, last_error, last_failed_at)
         VALUES (CURRENT_DATE, 1, left(SQLERRM, 500), NOW())
         ON CONFLICT (day) DO UPDATE
           SET failures = project_membership_audit_failures.failures + 1,
               last_error = EXCLUDED.last_error,
               last_failed_at = EXCLUDED.last_failed_at;
       EXCEPTION WHEN OTHERS THEN
         RAISE WARNING 'project membership audit failure count failed: %', SQLERRM;
       END;
     END;
     RETURN NULL;
   END;
   $$ LANGUAGE plpgsql`;

async function triggerExists(db: Pick<Client, "query">): Promise<boolean> {
  const { rows } = await db.query<{ trigger_exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_trigger
        WHERE tgname=$1
          AND tgrelid='projects'::regclass
          AND NOT tgisinternal
     ) AS trigger_exists`,
    [PROJECT_MEMBERSHIP_AUDIT_TRIGGER],
  );
  return rows[0]?.trigger_exists === true;
}

// Caps rows written before the fixed retention (they followed the PII
// retention setting, which may be longer or "never").
async function clampAuditRetention(db: Pick<Client, "query">): Promise<void> {
  await db.query(
    `UPDATE central_log
        SET expire = time + INTERVAL '${PROJECT_MEMBERSHIP_AUDIT_RETENTION}'
      WHERE event = ANY($1::text[])
        AND time IS NOT NULL
        AND (expire IS NULL
             OR expire > time + INTERVAL '${PROJECT_MEMBERSHIP_AUDIT_RETENTION}')`,
    [PROJECT_MEMBERSHIP_AUDIT_EVENTS],
  );
}

export async function ensureProjectMembershipAuditSchema(
  db: Client,
): Promise<void> {
  await clampAuditRetention(db);
  // Writers only fire the trigger; creating it needs no lock beyond the
  // trigger DDL itself, and a missed change during installation is no worse
  // than before.
  await db.query(CREATE_OR_REPLACE_FUNCTION_SQL);
  if (!(await triggerExists(db))) {
    await db.query(
      `CREATE TRIGGER ${PROJECT_MEMBERSHIP_AUDIT_TRIGGER}
         AFTER INSERT OR UPDATE OF users
         ON projects
         FOR EACH ROW
         EXECUTE FUNCTION ${PROJECT_MEMBERSHIP_AUDIT_FUNCTION}()`,
    );
  }
}

// A disabled trigger is not repaired here (someone disabled it on purpose);
// admin health reports it.
export async function projectMembershipAuditSchemaNeedsSync(
  db: Pick<Client, "query">,
): Promise<boolean> {
  const { state } = await getProjectMembershipAuditStatus(db);
  return state === "missing" || state === "outdated";
}

export interface ProjectMembershipAuditStatus {
  state: "ok" | "missing" | "disabled" | "outdated";
  // Recording failures in the last 7 days.
  recent_failures: number;
  last_error: string | null;
  last_failed_at: Date | null;
}

export async function getProjectMembershipAuditStatus(
  db: Pick<Client, "query">,
): Promise<ProjectMembershipAuditStatus> {
  const { rows } = await db.query<{
    enabled: string | null;
    current: boolean | null;
  }>(
    `SELECT t.tgenabled::text AS enabled,
            position($2 IN pg_get_functiondef(t.tgfoid)) > 0 AS current
       FROM pg_trigger t
      WHERE t.tgname=$1
        AND t.tgrelid='projects'::regclass
        AND NOT t.tgisinternal`,
    [PROJECT_MEMBERSHIP_AUDIT_TRIGGER, MEMBERSHIP_AUDIT_CONTRACT],
  );
  const trigger = rows[0];
  const state =
    trigger == null
      ? "missing"
      : trigger.enabled === "D"
        ? "disabled"
        : trigger.current
          ? "ok"
          : "outdated";
  let failures = { recent_failures: 0, last_error: null, last_failed_at: null };
  const exists = await db.query<{ exists: boolean }>(
    "SELECT to_regclass('project_membership_audit_failures') IS NOT NULL AS exists",
  );
  if (exists.rows[0]?.exists) {
    const { rows: failed } = await db.query(
      `SELECT COALESCE(SUM(failures), 0)::int AS recent_failures,
              (ARRAY_AGG(last_error ORDER BY last_failed_at DESC))[1] AS last_error,
              MAX(last_failed_at) AS last_failed_at
         FROM project_membership_audit_failures
        WHERE day >= CURRENT_DATE - 7`,
    );
    failures = failed[0] ?? failures;
  }
  return { state, ...failures };
}

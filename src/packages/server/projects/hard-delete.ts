import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import getLogger from "@cocalc/backend/logger";
import rustic from "@cocalc/backend/sandbox/rustic";
import { parseOutput } from "@cocalc/backend/sandbox/exec";
import getPool from "@cocalc/database/pool";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { deleteProjectDataOnHost, stopProjectOnHost } from "@cocalc/server/project-host/control";
import {
  getDeletedProjectBackupConfigForDeletion,
  getProjectBackupConfigForDeletion,
} from "@cocalc/server/project-backup";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:projects:hard-delete");

const RUSTIC_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_BACKUP_RETENTION_DAYS = 7;
const MAX_BACKUP_RETENTION_DAYS = 365;
let deletedProjectsSchemaReady: Promise<void> | undefined;

function backupIndexHost(project_id: string): string {
  return `project-${project_id}-index`;
}

type ProjectRow = {
  project_id: string;
  name: string | null;
  title: string | null;
  description: string | null;
  users: any;
  host_id: string | null;
  backup_bucket_id: string | null;
  created: Date | null;
  last_edited: Date | null;
};

type ProjectAccess = {
  project: ProjectRow;
  admin: boolean;
};

export type HardDeleteProjectProgressUpdate = {
  step: string;
  message?: string;
  detail?: Record<string, unknown>;
};

export type HardDeleteProjectResult = {
  project_id: string;
  host_id: string | null;
  already_deleted?: boolean;
  backup: {
    mode: "immediate" | "scheduled";
    retention_days: number;
    purge_due_at: string | null;
    purged_at: string | null;
    skipped: boolean;
    deleted_snapshots: number;
    deleted_index_snapshots: number;
    reason?: string;
  };
  purged_tables: string[];
};

function pool() {
  return getPool();
}

function isMissingTableError(err: unknown): boolean {
  return typeof err === "object" && err != null && (err as any).code === "42P01";
}

function normalizeUsers(users: any): Record<string, any> {
  if (!users) return {};
  if (typeof users === "object" && !Array.isArray(users)) {
    return users as Record<string, any>;
  }
  if (typeof users === "string") {
    try {
      const parsed = JSON.parse(users);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function ownerAccountIdFromUsers(usersRaw: any): string | null {
  const users = normalizeUsers(usersRaw);
  for (const [account_id, info] of Object.entries(users)) {
    if (
      info &&
      typeof info === "object" &&
      (info as Record<string, unknown>).group === "owner"
    ) {
      return account_id;
    }
  }
  return null;
}

function isOwner(usersRaw: any, account_id: string): boolean {
  const users = normalizeUsers(usersRaw);
  const group = users?.[account_id]?.group;
  return group === "owner";
}

async function ensureDeletedProjectsSchema(): Promise<void> {
  if (!deletedProjectsSchemaReady) {
    deletedProjectsSchemaReady = (async () => {
      await pool().query(`
        CREATE TABLE IF NOT EXISTS deleted_projects (
          project_id UUID PRIMARY KEY,
          name VARCHAR(100),
          title TEXT,
          description TEXT,
          owner_account_id UUID,
          host_id UUID,
          backup_bucket_id UUID,
          created TIMESTAMPTZ,
          last_edited TIMESTAMPTZ,
          deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_by UUID,
          backup_retention_days INTEGER NOT NULL DEFAULT 0,
          backup_purge_due_at TIMESTAMPTZ,
          backup_purge_started_at TIMESTAMPTZ,
          backups_purged_at TIMESTAMPTZ,
          backup_purge_status TEXT,
          backup_purge_error TEXT,
          metadata JSONB DEFAULT '{}'::jsonb
        )
      `);
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_bucket_id UUID",
      );
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_retention_days INTEGER NOT NULL DEFAULT 0",
      );
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_purge_due_at TIMESTAMPTZ",
      );
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_purge_started_at TIMESTAMPTZ",
      );
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backups_purged_at TIMESTAMPTZ",
      );
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_purge_status TEXT",
      );
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_purge_error TEXT",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS deleted_projects_deleted_at_idx ON deleted_projects(deleted_at)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS deleted_projects_deleted_by_idx ON deleted_projects(deleted_by)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS deleted_projects_owner_idx ON deleted_projects(owner_account_id)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS deleted_projects_backup_due_idx ON deleted_projects(backup_purge_due_at)",
      );
    })().catch((err) => {
      deletedProjectsSchemaReady = undefined;
      throw err;
    });
  }
  await deletedProjectsSchemaReady;
}

async function loadProject(project_id: string): Promise<ProjectRow | null> {
  const { rows } = await pool().query<ProjectRow>(
    `
      SELECT
        project_id,
        name,
        title,
        description,
        users,
        host_id,
        backup_bucket_id,
        created,
        last_edited
      FROM projects
      WHERE project_id=$1
      LIMIT 1
    `,
    [project_id],
  );
  return rows[0] ?? null;
}

async function loadDeletedProject(project_id: string): Promise<boolean> {
  await ensureDeletedProjectsSchema();
  const { rows } = await pool().query<{ project_id: string }>(
    "SELECT project_id FROM deleted_projects WHERE project_id=$1 LIMIT 1",
    [project_id],
  );
  return !!rows[0];
}

async function getProjectAccess({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<ProjectAccess | null> {
  const project = await loadProject(project_id);
  if (!project) return null;
  const admin = await userIsInGroup(account_id, "admin");
  if (admin || isOwner(project.users, account_id)) {
    return { project, admin };
  }
  throw new Error("must be a project owner (or admin) to permanently delete a workspace");
}

export async function assertHardDeleteProjectPermission({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<void> {
  if (!isValidUUID(project_id)) {
    throw new Error("project_id must be a valid uuid");
  }
  if (!isValidUUID(account_id)) {
    throw new Error("account_id must be a valid uuid");
  }
  const access = await getProjectAccess({ project_id, account_id });
  if (access) {
    return;
  }
  if (await loadDeletedProject(project_id)) {
    throw new Error("workspace is already permanently deleted");
  }
  throw new Error("workspace not found");
}

function extractSnapshotIds(payload: any): string[] {
  const ids = new Set<string>();
  if (!Array.isArray(payload)) return [];
  for (const row of payload) {
    const snapshots = Array.isArray(row?.snapshots)
      ? row.snapshots
      : Array.isArray(row?.[1])
        ? row[1]
        : [];
    for (const snapshot of snapshots) {
      const id = `${snapshot?.id ?? ""}`.trim();
      if (id) {
        ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

async function forgetAllSnapshotsForHost({
  repo,
  host,
}: {
  repo: string;
  host: string;
}): Promise<number> {
  const { stdout } = parseOutput(
    await rustic(["snapshots", "--json"], {
      repo,
      host,
      timeout: RUSTIC_TIMEOUT_MS,
      maxSize: 20_000_000,
    }),
  );
  let snapshots: any[] = [];
  try {
    snapshots = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`unable to parse rustic snapshot list for host '${host}': ${err}`);
  }
  const ids = extractSnapshotIds(snapshots);
  if (!ids.length) {
    return 0;
  }
  for (const id of ids) {
    parseOutput(
      await rustic(["forget", id], {
        repo,
        host,
        timeout: RUSTIC_TIMEOUT_MS,
      }),
    );
  }
  return ids.length;
}

type BackupDeletionResult = {
  skipped: boolean;
  deleted_snapshots: number;
  deleted_index_snapshots: number;
  reason?: string;
};

async function deleteProjectBackupsWithToml({
  project_id,
  toml,
}: {
  project_id: string;
  toml: string;
}): Promise<BackupDeletionResult> {
  if (!toml.trim()) {
    return {
      skipped: true,
      deleted_snapshots: 0,
      deleted_index_snapshots: 0,
      reason: "no backup configuration",
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "cocalc-hard-delete-"));
  const repoToml = join(tempDir, "repo.toml");
  try {
    await writeFile(repoToml, toml, { mode: 0o600 });
    const deletedSnapshots = await forgetAllSnapshotsForHost({
      repo: repoToml,
      host: `project-${project_id}`,
    });
    const deletedIndexSnapshots = await forgetAllSnapshotsForHost({
      repo: repoToml,
      host: backupIndexHost(project_id),
    });
    return {
      skipped: false,
      deleted_snapshots: deletedSnapshots,
      deleted_index_snapshots: deletedIndexSnapshots,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function deleteProjectBackups(project_id: string): Promise<BackupDeletionResult> {
  const { toml } = await getProjectBackupConfigForDeletion({ project_id });
  return await deleteProjectBackupsWithToml({ project_id, toml });
}

async function deleteProjectBackupsForDeletedProject({
  project_id,
  host_id,
  backup_bucket_id,
}: {
  project_id: string;
  host_id: string | null;
  backup_bucket_id: string | null;
}): Promise<BackupDeletionResult> {
  const { toml } = await getDeletedProjectBackupConfigForDeletion({
    project_id,
    host_id,
    backup_bucket_id,
  });
  return await deleteProjectBackupsWithToml({ project_id, toml });
}

async function runDeleteMaybeMissingTable({
  client,
  table,
  query,
  params,
  purged,
}: {
  client: any;
  table: string;
  query: string;
  params: any[];
  purged: string[];
}): Promise<void> {
  try {
    const result = await client.query(query, params);
    if ((result.rowCount ?? 0) > 0) {
      purged.push(table);
    }
  } catch (err) {
    if (isMissingTableError(err)) {
      return;
    }
    throw err;
  }
}

async function purgeProjectRows({
  project,
  deleted_by,
  backup,
  backup_retention_days,
  backup_purge_due_at,
  backup_purge_status,
  backups_purged_at,
  purge_backup_secrets_now,
}: {
  project: ProjectRow;
  deleted_by: string;
  backup: BackupDeletionResult;
  backup_retention_days: number;
  backup_purge_due_at: Date | null;
  backup_purge_status: string;
  backups_purged_at: Date | null;
  purge_backup_secrets_now: boolean;
}): Promise<string[]> {
  await ensureDeletedProjectsSchema();
  const purged: string[] = [];
  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    const owner_account_id = ownerAccountIdFromUsers(project.users);
    const metadata = {
      backup,
    };
    await client.query(
      `
        INSERT INTO deleted_projects
          (
            project_id, name, title, description, owner_account_id, host_id, backup_bucket_id,
            created, last_edited, deleted_at, deleted_by, backup_retention_days,
            backup_purge_due_at, backups_purged_at, backup_purge_status, backup_purge_started_at,
            backup_purge_error, metadata
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11, $12, $13, $14, NULL, NULL, $15::jsonb)
        ON CONFLICT (project_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          owner_account_id = EXCLUDED.owner_account_id,
          host_id = EXCLUDED.host_id,
          backup_bucket_id = EXCLUDED.backup_bucket_id,
          created = EXCLUDED.created,
          last_edited = EXCLUDED.last_edited,
          deleted_at = EXCLUDED.deleted_at,
          deleted_by = EXCLUDED.deleted_by,
          backup_retention_days = EXCLUDED.backup_retention_days,
          backup_purge_due_at = EXCLUDED.backup_purge_due_at,
          backups_purged_at = EXCLUDED.backups_purged_at,
          backup_purge_status = EXCLUDED.backup_purge_status,
          backup_purge_started_at = EXCLUDED.backup_purge_started_at,
          backup_purge_error = EXCLUDED.backup_purge_error,
          metadata = EXCLUDED.metadata
      `,
      [
        project.project_id,
        project.name,
        project.title,
        project.description,
        owner_account_id,
        project.host_id,
        project.backup_bucket_id,
        project.created,
        project.last_edited,
        deleted_by,
        backup_retention_days,
        backup_purge_due_at,
        backups_purged_at,
        backup_purge_status,
        JSON.stringify(metadata),
      ],
    );

    await runDeleteMaybeMissingTable({
      client,
      table: "project_collab_invites",
      query: "DELETE FROM project_collab_invites WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "project_invite_tokens",
      query: "DELETE FROM project_invite_tokens WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "project_log",
      query: "DELETE FROM project_log WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    if (purge_backup_secrets_now) {
      await runDeleteMaybeMissingTable({
        client,
        table: "project_backup_secrets",
        query: "DELETE FROM project_backup_secrets WHERE project_id=$1",
        params: [project.project_id],
        purged,
      });
    }
    await runDeleteMaybeMissingTable({
      client,
      table: "api_keys",
      query: "DELETE FROM api_keys WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "public_path_stars",
      query:
        "DELETE FROM public_path_stars WHERE public_path_id IN (SELECT id FROM public_paths WHERE project_id=$1)",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "public_paths",
      query: "DELETE FROM public_paths WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "project_copies",
      query:
        "DELETE FROM project_copies WHERE src_project_id=$1 OR dest_project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "project_moves",
      query: "DELETE FROM project_moves WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "long_running_operations",
      query:
        "DELETE FROM long_running_operations WHERE scope_type='project' AND scope_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "file_use",
      query: "DELETE FROM file_use WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "mentions",
      query: "DELETE FROM mentions WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "listings",
      query: "DELETE FROM listings WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "usage_info",
      query: "DELETE FROM usage_info WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });
    await runDeleteMaybeMissingTable({
      client,
      table: "external_credentials",
      query: "DELETE FROM external_credentials WHERE project_id=$1",
      params: [project.project_id],
      purged,
    });

    const deleted = await client.query(
      "DELETE FROM projects WHERE project_id=$1",
      [project.project_id],
    );
    if ((deleted.rowCount ?? 0) > 0) {
      purged.push("projects");
    }

    await client.query("COMMIT");
    return purged;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function clampBackupRetentionDays(days: number | undefined): number {
  if (days == null || !Number.isFinite(days)) {
    return DEFAULT_BACKUP_RETENTION_DAYS;
  }
  const rounded = Math.floor(days);
  return Math.max(0, Math.min(MAX_BACKUP_RETENTION_DAYS, rounded));
}

type DeletedProjectBackupPurgeRow = {
  project_id: string;
  host_id: string | null;
  backup_bucket_id: string | null;
  backup_purge_due_at: Date | null;
  backup_purge_status: string | null;
  backup_purge_started_at: Date | null;
};

async function claimDeletedProjectBackupPurge(
  project_id: string,
): Promise<DeletedProjectBackupPurgeRow | null> {
  const { rows } = await pool().query<DeletedProjectBackupPurgeRow>(
    `
      UPDATE deleted_projects
      SET
        backup_purge_status='running',
        backup_purge_started_at=NOW(),
        backup_purge_error=NULL
      WHERE project_id=$1
        AND backups_purged_at IS NULL
        AND backup_purge_due_at IS NOT NULL
        AND backup_purge_due_at <= NOW()
        AND (
          backup_purge_status IS NULL
          OR backup_purge_status IN ('scheduled', 'failed')
          OR (
            backup_purge_status='running'
            AND (
              backup_purge_started_at IS NULL
              OR backup_purge_started_at < NOW() - INTERVAL '15 minutes'
            )
          )
        )
      RETURNING
        project_id,
        host_id,
        backup_bucket_id,
        backup_purge_due_at,
        backup_purge_status,
        backup_purge_started_at
    `,
    [project_id],
  );
  return rows[0] ?? null;
}

async function markDeletedProjectBackupPurgeSuccess({
  project_id,
  result,
}: {
  project_id: string;
  result: BackupDeletionResult;
}): Promise<void> {
  await pool().query(
    `
      UPDATE deleted_projects
      SET
        backup_purge_status='purged',
        backups_purged_at=NOW(),
        backup_purge_started_at=NULL,
        backup_purge_error=NULL,
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{backup_purge_result}',
          $2::jsonb,
          true
        )
      WHERE project_id=$1
    `,
    [project_id, JSON.stringify(result)],
  );
}

async function markDeletedProjectBackupPurgeFailure({
  project_id,
  error,
}: {
  project_id: string;
  error: string;
}): Promise<void> {
  await pool().query(
    `
      UPDATE deleted_projects
      SET
        backup_purge_status='failed',
        backup_purge_started_at=NULL,
        backup_purge_error=$2
      WHERE project_id=$1
    `,
    [project_id, error.slice(0, 2000)],
  );
}

async function purgeDeletedProjectBackupSecret(project_id: string): Promise<void> {
  try {
    await pool().query(
      "DELETE FROM project_backup_secrets WHERE project_id=$1",
      [project_id],
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      return;
    }
    throw err;
  }
}

export async function processDueDeletedProjectBackupPurges({
  limit = 1,
}: {
  limit?: number;
} = {}): Promise<{
  processed: number;
  purged: number;
  failed: number;
}> {
  await ensureDeletedProjectsSchema();
  const batchSize = Math.max(1, Math.floor(limit));
  const { rows } = await pool().query<DeletedProjectBackupPurgeRow>(
    `
      SELECT
        project_id,
        host_id,
        backup_bucket_id,
        backup_purge_due_at,
        backup_purge_status,
        backup_purge_started_at
      FROM deleted_projects
      WHERE backup_purge_due_at IS NOT NULL
        AND backups_purged_at IS NULL
        AND backup_purge_due_at <= NOW()
        AND (
          backup_purge_status IS NULL
          OR backup_purge_status IN ('scheduled', 'failed')
          OR (
            backup_purge_status='running'
            AND (
              backup_purge_started_at IS NULL
              OR backup_purge_started_at < NOW() - INTERVAL '15 minutes'
            )
          )
        )
      ORDER BY backup_purge_due_at ASC
      LIMIT $1
    `,
    [batchSize],
  );
  let purged = 0;
  let failed = 0;
  let processed = 0;
  for (const row of rows) {
    const claimed = await claimDeletedProjectBackupPurge(row.project_id);
    if (!claimed) {
      continue;
    }
    processed += 1;
    try {
      const result = await deleteProjectBackupsForDeletedProject({
        project_id: claimed.project_id,
        host_id: claimed.host_id,
        backup_bucket_id: claimed.backup_bucket_id,
      });
      await markDeletedProjectBackupPurgeSuccess({
        project_id: claimed.project_id,
        result,
      });
      await purgeDeletedProjectBackupSecret(claimed.project_id);
      purged += 1;
    } catch (err) {
      await markDeletedProjectBackupPurgeFailure({
        project_id: claimed.project_id,
        error: `${err}`,
      });
      failed += 1;
    }
  }
  return { processed, purged, failed };
}

export async function hardDeleteProject({
  project_id,
  account_id,
  backup_retention_days,
  purge_backups_now = false,
  onProgress,
}: {
  project_id: string;
  account_id: string;
  backup_retention_days?: number;
  purge_backups_now?: boolean;
  onProgress?: (update: HardDeleteProjectProgressUpdate) => Promise<void> | void;
}): Promise<HardDeleteProjectResult> {
  if (!isValidUUID(project_id)) {
    throw new Error("project_id must be a valid uuid");
  }
  if (!isValidUUID(account_id)) {
    throw new Error("account_id must be a valid uuid");
  }
  const progress = onProgress ?? (() => {});
  const retentionDays = clampBackupRetentionDays(backup_retention_days);
  const purgeBackupsImmediately = !!purge_backups_now || retentionDays === 0;

  await progress({
    step: "validate",
    message: "validating permission",
    detail: { project_id },
  });
  const access = await getProjectAccess({ project_id, account_id });
  if (!access) {
    if (await loadDeletedProject(project_id)) {
      return {
        project_id,
        host_id: null,
        already_deleted: true,
        backup: {
          mode: "immediate",
          retention_days: 0,
          purge_due_at: null,
          purged_at: null,
          skipped: true,
          deleted_snapshots: 0,
          deleted_index_snapshots: 0,
          reason: "already deleted",
        },
        purged_tables: [],
      };
    }
    throw new Error("workspace not found");
  }
  const project = access.project;

  let backupDeleteResult: BackupDeletionResult;
  let backupPurgeStatus: string;
  let backupPurgeDueAt: Date | null;
  let backupsPurgedAt: Date | null;
  if (purgeBackupsImmediately) {
    await progress({
      step: "backups",
      message: "deleting backups",
      detail: { project_id },
    });
    backupDeleteResult = await deleteProjectBackups(project_id);
    backupPurgeStatus = "purged";
    backupPurgeDueAt = null;
    backupsPurgedAt = new Date();
  } else {
    backupPurgeDueAt = new Date(
      Date.now() + retentionDays * 24 * 60 * 60 * 1000,
    );
    backupPurgeStatus = "scheduled";
    backupsPurgedAt = null;
    backupDeleteResult = {
      skipped: true,
      deleted_snapshots: 0,
      deleted_index_snapshots: 0,
      reason: `scheduled for purge in ${retentionDays} day(s)`,
    };
    await progress({
      step: "backups",
      message: "scheduled backup purge",
      detail: {
        project_id,
        backup_retention_days: retentionDays,
        backup_purge_due_at: backupPurgeDueAt.toISOString(),
      },
    });
  }

  const backup: HardDeleteProjectResult["backup"] = {
    mode: purgeBackupsImmediately ? "immediate" : "scheduled",
    retention_days: purgeBackupsImmediately ? 0 : retentionDays,
    purge_due_at: backupPurgeDueAt ? backupPurgeDueAt.toISOString() : null,
    purged_at: backupsPurgedAt ? backupsPurgedAt.toISOString() : null,
    ...backupDeleteResult,
  };

  await progress({
    step: "host-cleanup",
    message: "deleting local host data",
    detail: { project_id, host_id: project.host_id },
  });
  if (project.host_id) {
    try {
      await stopProjectOnHost(project.project_id);
    } catch (err) {
      log.debug("hard delete stop project best-effort failed", {
        project_id: project.project_id,
        host_id: project.host_id,
        err: `${err}`,
      });
    }
    try {
      await deleteProjectDataOnHost({
        project_id: project.project_id,
        host_id: project.host_id,
      });
    } catch (err) {
      log.debug("hard delete host data cleanup best-effort failed", {
        project_id: project.project_id,
        host_id: project.host_id,
        err: `${err}`,
      });
    }
  }

  await progress({
    step: "db-cleanup",
    message: "purging database records",
    detail: { project_id },
  });
  const purged_tables = await purgeProjectRows({
    project,
    deleted_by: account_id,
    backup: backupDeleteResult,
    backup_retention_days: purgeBackupsImmediately ? 0 : retentionDays,
    backup_purge_due_at: backupPurgeDueAt,
    backup_purge_status: backupPurgeStatus,
    backups_purged_at: backupsPurgedAt,
    purge_backup_secrets_now: purgeBackupsImmediately,
  });

  await progress({
    step: "done",
    message: "workspace permanently deleted",
    detail: { project_id },
  });
  return {
    project_id,
    host_id: project.host_id,
    backup,
    purged_tables,
  };
}

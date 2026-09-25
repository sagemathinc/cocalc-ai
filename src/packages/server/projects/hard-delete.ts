import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import getLogger from "@cocalc/backend/logger";
import rustic from "@cocalc/backend/sandbox/rustic";
import { parseOutput } from "@cocalc/backend/sandbox/exec";
import { ConatError } from "@cocalc/conat/core/client";
import getPool from "@cocalc/database/pool";
import { publishProjectRemoveFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { releaseProjectAppPublicSubdomainsForProject } from "@cocalc/server/app-public-subdomains";
import { releaseProjectAppPrivateHostnamesForProject } from "@cocalc/server/app-private-hostnames";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  deleteProjectDataOnHost,
  stopProjectOnHost,
} from "@cocalc/server/project-host/control";
import {
  getDeletedProjectBackupConfigForDeletion,
  getProjectBackupConfigForDeletion,
  releaseProjectBackupRepoAssignment,
  resolveProjectBackupRepoAssignment,
} from "@cocalc/server/project-backup";
import { PROJECT_HARD_DELETE_PROJECT_ID_TABLES } from "@cocalc/server/projects/hard-delete-tables";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:projects:hard-delete");

const RUSTIC_TIMEOUT_MS = 2 * 60 * 1000;
const RUSTIC_FORGET_BATCH_SIZE = 100;
const RUSTIC_NICE = 15;
const DEFAULT_BACKUP_RETENTION_DAYS = 7;
const MAX_BACKUP_RETENTION_DAYS = 365;
const BACKUP_PURGE_MAX_ATTEMPTS = 5;
const BACKUP_PURGE_STALE_AFTER_MINUTES = 15;
const BACKUP_PURGE_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
] as const;
let deletedProjectsSchemaReady: Promise<void> | undefined;

function backupIndexHost(project_id: string): string {
  return `project-${project_id}-index`;
}

type ProjectRow = {
  project_id: string;
  title: string | null;
  description: string | null;
  users: any;
  host_id: string | null;
  region: string | null;
  backup_repo_id: string | null;
  created: Date | null;
  last_edited: Date | null;
  deletion_protection?: boolean | null;
};

type ProjectAccess = {
  project: ProjectRow;
};

async function releaseSeedProjectAppPublicSubdomains(project_id: string) {
  const seedBayId = getConfiguredClusterSeedBayId();
  if (getConfiguredBayId() === seedBayId) {
    return await releaseProjectAppPublicSubdomainsForProject({ project_id });
  }
  return await getInterBayBridge()
    .hostConnection(seedBayId, { timeout_ms: 30_000 })
    .releaseSeedProjectAppPublicSubdomains({ project_id });
}

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
  return (
    typeof err === "object" && err != null && (err as any).code === "42P01"
  );
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
      (info as Record<string, unknown>).group === "owner" &&
      isValidUUID(account_id)
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

function visibleAccountIdsFromUsers(usersRaw: any): string[] {
  const users = normalizeUsers(usersRaw);
  return Object.entries(users)
    .filter(
      ([account_id, info]) =>
        isValidUUID(account_id) &&
        ["owner", "collaborator"].includes(`${info?.group ?? ""}`),
    )
    .map(([account_id]) => account_id);
}

async function ensureDeletedProjectsSchema(): Promise<void> {
  if (!deletedProjectsSchemaReady) {
    deletedProjectsSchemaReady = (async () => {
      await pool().query(`
        CREATE TABLE IF NOT EXISTS deleted_projects (
          project_id UUID PRIMARY KEY,
          title TEXT,
          description TEXT,
          owner_account_id UUID,
          host_id UUID,
          backup_repo_id UUID,
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
          backup_purge_attempts INTEGER NOT NULL DEFAULT 0,
          backup_purge_next_attempt_at TIMESTAMPTZ,
          backup_purge_quarantined_at TIMESTAMPTZ,
          metadata JSONB DEFAULT '{}'::jsonb
        )
      `);
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_repo_id UUID",
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
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_purge_attempts INTEGER NOT NULL DEFAULT 0",
      );
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_purge_next_attempt_at TIMESTAMPTZ",
      );
      await pool().query(
        "ALTER TABLE deleted_projects ADD COLUMN IF NOT EXISTS backup_purge_quarantined_at TIMESTAMPTZ",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS deleted_projects_deleted_at_idx ON deleted_projects(deleted_at)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS deleted_projects_deleted_by_idx ON deleted_projects(deleted_by)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS deleted_projects_owner_account_id_idx ON deleted_projects(owner_account_id)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS deleted_projects_backup_purge_due_at_idx ON deleted_projects(backup_purge_due_at)",
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
        title,
        description,
        users,
        host_id,
        region,
        backup_repo_id,
        created,
        last_edited,
        deletion_protection
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
  if (isOwner(project.users, account_id)) {
    return { project };
  }
  throw new ConatError(
    "must be a project owner to permanently delete a workspace",
    { code: "project_delete_not_owner" },
  );
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

export async function assertProjectDeletionProtectionDisabled({
  project_id,
}: {
  project_id: string;
}): Promise<void> {
  if (!isValidUUID(project_id)) {
    throw new Error("project_id must be a valid uuid");
  }
  const project = await loadProject(project_id);
  if (!project) {
    if (await loadDeletedProject(project_id)) {
      throw new Error("workspace is already permanently deleted");
    }
    throw new Error("workspace not found");
  }
  if (project.deletion_protection === true) {
    throw new ConatError(
      "deletion protection is enabled for this workspace; disable it in project settings before deleting",
      { code: "project_deletion_protection_enabled" },
    );
  }
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
  onProgress,
}: {
  repo: string;
  host: string;
  onProgress?: () => Promise<void>;
}): Promise<number> {
  await onProgress?.();
  const { stdout } = parseOutput(
    await rustic(["snapshots", "--json"], {
      repo,
      host,
      timeout: RUSTIC_TIMEOUT_MS,
      maxSize: 20_000_000,
      nice: RUSTIC_NICE,
    }),
  );
  let snapshots: any[] = [];
  try {
    snapshots = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `unable to parse rustic snapshot list for host '${host}': ${err}`,
    );
  }
  const ids = extractSnapshotIds(snapshots);
  if (!ids.length) {
    return 0;
  }
  for (let i = 0; i < ids.length; i += RUSTIC_FORGET_BATCH_SIZE) {
    const batch = ids.slice(i, i + RUSTIC_FORGET_BATCH_SIZE);
    await onProgress?.();
    parseOutput(
      await rustic(["forget", ...batch], {
        repo,
        host,
        timeout: RUSTIC_TIMEOUT_MS,
        nice: RUSTIC_NICE,
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
  onProgress,
}: {
  project_id: string;
  toml: string;
  onProgress?: () => Promise<void>;
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
      onProgress,
    });
    const deletedIndexSnapshots = await forgetAllSnapshotsForHost({
      repo: repoToml,
      host: backupIndexHost(project_id),
      onProgress,
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

async function deleteProjectBackups(
  project_id: string,
): Promise<BackupDeletionResult> {
  const { toml } = await getProjectBackupConfigForDeletion({ project_id });
  return await deleteProjectBackupsWithToml({ project_id, toml });
}

async function deleteProjectBackupsForDeletedProject({
  project_id,
  host_id,
  backup_repo_id,
  onProgress,
}: {
  project_id: string;
  host_id: string | null;
  backup_repo_id: string | null;
  onProgress?: () => Promise<void>;
}): Promise<BackupDeletionResult> {
  const { toml } = await getDeletedProjectBackupConfigForDeletion({
    project_id,
    host_id,
    backup_repo_id,
  });
  return await deleteProjectBackupsWithToml({ project_id, toml, onProgress });
}

async function runDeleteMaybeMissingTable({
  client,
  table,
  query,
  lockQuery,
  params,
  purged,
}: {
  client: any;
  table: string;
  query: string;
  lockQuery?: string;
  params: any[];
  purged: string[];
}): Promise<void> {
  const savepoint = `hd_${table.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    if (lockQuery) await client.query(lockQuery, params);
    const result = await client.query(query, params);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    if ((result.rowCount ?? 0) > 0) {
      purged.push(table);
    }
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
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
}: {
  project: ProjectRow;
  deleted_by: string;
  backup: BackupDeletionResult;
  backup_retention_days: number;
  backup_purge_due_at: Date | null;
  backup_purge_status: string;
  backups_purged_at: Date | null;
}): Promise<string[]> {
  await ensureDeletedProjectsSchema();
  const purged: string[] = [];
  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    // Prevent new project references while dependency rows are being removed.
    await client.query(
      "SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE",
      [project.project_id],
    );

    const owner_account_id = ownerAccountIdFromUsers(project.users);
    const metadata = {
      backup,
    };
    await client.query(
      `
        INSERT INTO deleted_projects
          (
            project_id, title, description, owner_account_id, host_id, backup_repo_id,
            created, last_edited, deleted_at, deleted_by, backup_retention_days,
            backup_purge_due_at, backups_purged_at, backup_purge_status, backup_purge_started_at,
            backup_purge_error, backup_purge_attempts, backup_purge_next_attempt_at,
            backup_purge_quarantined_at, metadata
          )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11, $12, $13,
           NULL, NULL, 0, NULL, NULL, $14::jsonb)
        ON CONFLICT (project_id)
        DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          owner_account_id = EXCLUDED.owner_account_id,
          host_id = EXCLUDED.host_id,
          backup_repo_id = EXCLUDED.backup_repo_id,
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
          backup_purge_attempts = EXCLUDED.backup_purge_attempts,
          backup_purge_next_attempt_at = EXCLUDED.backup_purge_next_attempt_at,
          backup_purge_quarantined_at = EXCLUDED.backup_purge_quarantined_at,
          metadata = EXCLUDED.metadata
      `,
      [
        project.project_id,
        project.title,
        project.description,
        owner_account_id,
        project.host_id,
        project.backup_repo_id,
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

    // Runs reference identities, not projects. Lock identities against concurrent
    // run issuance and remove their credentials before deleting the identities.
    await runDeleteMaybeMissingTable({
      client,
      table: "agent_identity_runs",
      lockQuery:
        "SELECT agent_id FROM agent_identities WHERE project_id=$1 FOR UPDATE",
      query: `DELETE FROM agent_identity_runs WHERE agent_id IN (
        SELECT agent_id FROM agent_identities WHERE project_id=$1
      )`,
      params: [project.project_id],
      purged,
    });

    for (const table of PROJECT_HARD_DELETE_PROJECT_ID_TABLES) {
      await runDeleteMaybeMissingTable({
        client,
        table,
        query: `DELETE FROM ${table} WHERE project_id=$1`,
        params: [project.project_id],
        purged,
      });
    }

    const customProjectDeleteSpecs = [
      {
        table: "project_copies",
        query:
          "DELETE FROM project_copies WHERE src_project_id=$1 OR dest_project_id=$1",
      },
      {
        table: "long_running_operations",
        query:
          "DELETE FROM long_running_operations WHERE scope_type='project' AND scope_id=$1",
      },
      {
        table: "notification_events",
        query: "DELETE FROM notification_events WHERE source_project_id=$1",
      },
      {
        table: "blobs",
        query:
          "DELETE FROM blobs WHERE project_id=$1::text OR id IN (SELECT archived FROM syncstrings WHERE project_id=$1::uuid AND archived IS NOT NULL)",
      },
      {
        table: "patches",
        query:
          "DELETE FROM patches WHERE string_id IN (SELECT string_id FROM syncstrings WHERE project_id=$1)",
      },
      {
        table: "cursors",
        query:
          "DELETE FROM cursors WHERE string_id IN (SELECT string_id FROM syncstrings WHERE project_id=$1)",
      },
    ];
    for (const { table, query } of customProjectDeleteSpecs) {
      await runDeleteMaybeMissingTable({
        client,
        table,
        query,
        params: [project.project_id],
        purged,
      });
    }

    await runDeleteMaybeMissingTable({
      client,
      table: "syncstrings",
      query: "DELETE FROM syncstrings WHERE project_id=$1",
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
    log.error("purgeProjectRows failed", {
      project_id: project.project_id,
      err: `${err}`,
    });
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function publishProjectHardDeleteRemoveEvents(
  project: ProjectRow,
): Promise<void> {
  await publishProjectRemoveFeedEventsBestEffort({
    project_id: project.project_id,
    account_ids: visibleAccountIdsFromUsers(project.users),
    default_bay_id: getConfiguredBayId(),
  });
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
  backup_repo_id: string | null;
  backup_purge_due_at: Date | null;
  backup_purge_status: string | null;
  backup_purge_started_at: Date | null;
  backup_purge_attempts: number;
};

function backupPurgeRetryAt(attempts: number): Date | null {
  const delay = BACKUP_PURGE_RETRY_DELAYS_MS[attempts - 1];
  return delay == null ? null : new Date(Date.now() + delay);
}

async function recoverStaleDeletedProjectBackupPurges(): Promise<{
  recovered: number;
  quarantined: number;
}> {
  const { rows } = await pool().query<{ status: string }>(
    `
      UPDATE deleted_projects
      SET
        backup_purge_status = CASE
          WHEN backup_purge_attempts >= $1 THEN 'quarantined'
          ELSE 'failed'
        END,
        backup_purge_started_at = NULL,
        backup_purge_next_attempt_at = CASE
          WHEN backup_purge_attempts >= $1 THEN NULL
          ELSE NOW()
        END,
        backup_purge_quarantined_at = CASE
          WHEN backup_purge_attempts >= $1 THEN NOW()
          ELSE NULL
        END,
        backup_purge_error = COALESCE(
          backup_purge_error,
          'backup purge worker stopped before reporting a result'
        )
      WHERE backups_purged_at IS NULL
        AND backup_purge_status='running'
        AND (
          backup_purge_started_at IS NULL
          OR backup_purge_started_at < NOW() - ($2 * INTERVAL '1 minute')
        )
      RETURNING backup_purge_status AS status
    `,
    [BACKUP_PURGE_MAX_ATTEMPTS, BACKUP_PURGE_STALE_AFTER_MINUTES],
  );
  return {
    recovered: rows.length,
    quarantined: rows.filter(({ status }) => status === "quarantined").length,
  };
}

async function claimDeletedProjectBackupPurge(
  project_id: string,
): Promise<DeletedProjectBackupPurgeRow | null> {
  const { rows } = await pool().query<DeletedProjectBackupPurgeRow>(
    `
      UPDATE deleted_projects
      SET
        backup_purge_status='running',
        backup_purge_started_at=NOW(),
        backup_purge_error=NULL,
        backup_purge_attempts=backup_purge_attempts + 1,
        backup_purge_next_attempt_at=NULL,
        backup_purge_quarantined_at=NULL
      WHERE project_id=$1
        AND backups_purged_at IS NULL
        AND backup_purge_due_at IS NOT NULL
        AND backup_purge_due_at <= NOW()
        AND (
          backup_purge_status IS NULL
          OR backup_purge_status='scheduled'
          OR (
            backup_purge_status='failed'
            AND backup_purge_attempts < $2
            AND (
              backup_purge_next_attempt_at IS NULL
              OR backup_purge_next_attempt_at <= NOW()
            )
          )
        )
      RETURNING
        project_id,
        host_id,
        backup_repo_id,
        backup_purge_due_at,
        backup_purge_status,
        backup_purge_started_at,
        backup_purge_attempts
    `,
    [project_id, BACKUP_PURGE_MAX_ATTEMPTS],
  );
  return rows[0] ?? null;
}

async function markDeletedProjectBackupPurgeSuccess({
  project_id,
  result,
  attempts,
}: {
  project_id: string;
  result: BackupDeletionResult;
  attempts: number;
}): Promise<boolean> {
  const { rowCount } = await pool().query(
    `
      UPDATE deleted_projects
      SET
        backup_purge_status='purged',
        backups_purged_at=NOW(),
        backup_purge_started_at=NULL,
        backup_purge_error=NULL,
        backup_purge_next_attempt_at=NULL,
        backup_purge_quarantined_at=NULL,
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{backup_purge_result}',
          $2::jsonb,
          true
        )
      WHERE project_id=$1
        AND backup_purge_status='running'
        AND backup_purge_attempts=$3
    `,
    [project_id, JSON.stringify(result), attempts],
  );
  return (rowCount ?? 0) > 0;
}

async function touchDeletedProjectBackupPurge({
  project_id,
  attempts,
}: {
  project_id: string;
  attempts: number;
}): Promise<void> {
  const { rowCount } = await pool().query(
    `UPDATE deleted_projects
     SET backup_purge_started_at=NOW()
     WHERE project_id=$1
       AND backup_purge_status='running'
       AND backup_purge_attempts=$2`,
    [project_id, attempts],
  );
  if ((rowCount ?? 0) === 0) {
    throw new Error("deleted-project backup purge lease was lost");
  }
}

async function markDeletedProjectBackupPurgeFailure({
  project_id,
  error,
  attempts,
}: {
  project_id: string;
  error: string;
  attempts: number;
}): Promise<{ updated: boolean; quarantined: boolean }> {
  const quarantined = attempts >= BACKUP_PURGE_MAX_ATTEMPTS;
  const { rows } = await pool().query<{ status: string }>(
    `
      UPDATE deleted_projects
      SET
        backup_purge_status=$3,
        backup_purge_started_at=NULL,
        backup_purge_error=$2,
        backup_purge_next_attempt_at=$4,
        backup_purge_quarantined_at=CASE WHEN $3='quarantined' THEN NOW() ELSE NULL END
      WHERE project_id=$1
        AND backup_purge_status='running'
        AND backup_purge_attempts=$5
      RETURNING backup_purge_status AS status
    `,
    [
      project_id,
      error.slice(0, 2000),
      quarantined ? "quarantined" : "failed",
      quarantined ? null : backupPurgeRetryAt(attempts),
      attempts,
    ],
  );
  return {
    updated: rows.length > 0,
    quarantined: rows[0]?.status === "quarantined",
  };
}

export async function processDueDeletedProjectBackupPurges({
  limit = 1,
}: {
  limit?: number;
} = {}): Promise<{
  processed: number;
  purged: number;
  failed: number;
  quarantined: number;
  recovered_stale: number;
}> {
  await ensureDeletedProjectsSchema();
  const stale = await recoverStaleDeletedProjectBackupPurges();
  const batchSize = Math.max(1, Math.floor(limit));
  const { rows } = await pool().query<DeletedProjectBackupPurgeRow>(
    `
      SELECT
        project_id,
        host_id,
        backup_repo_id,
        backup_purge_due_at,
        backup_purge_status,
        backup_purge_started_at,
        backup_purge_attempts
      FROM deleted_projects
      WHERE backup_purge_due_at IS NOT NULL
        AND backups_purged_at IS NULL
        AND backup_purge_due_at <= NOW()
        AND (
          backup_purge_status IS NULL
          OR backup_purge_status='scheduled'
          OR (
            backup_purge_status='failed'
            AND backup_purge_attempts < $2
            AND (
              backup_purge_next_attempt_at IS NULL
              OR backup_purge_next_attempt_at <= NOW()
            )
          )
        )
      ORDER BY backup_purge_due_at ASC
      LIMIT $1
    `,
    [batchSize, BACKUP_PURGE_MAX_ATTEMPTS],
  );
  let purged = 0;
  let failed = 0;
  let processed = 0;
  let quarantined = stale.quarantined;
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
        backup_repo_id: claimed.backup_repo_id,
        onProgress: async () => {
          await touchDeletedProjectBackupPurge({
            project_id: claimed.project_id,
            attempts: claimed.backup_purge_attempts,
          });
        },
      });
      if (
        await markDeletedProjectBackupPurgeSuccess({
          project_id: claimed.project_id,
          result,
          attempts: claimed.backup_purge_attempts,
        })
      ) {
        purged += 1;
      }
    } catch (err) {
      const failure = await markDeletedProjectBackupPurgeFailure({
        project_id: claimed.project_id,
        error: `${err}`,
        attempts: claimed.backup_purge_attempts,
      });
      if (failure.quarantined) {
        quarantined += 1;
      }
      if (failure.updated) {
        failed += 1;
      }
    }
  }
  return {
    processed,
    purged,
    failed,
    quarantined,
    recovered_stale: stale.recovered,
  };
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
  onProgress?: (
    update: HardDeleteProjectProgressUpdate,
  ) => Promise<void> | void;
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
  let backupAssignmentReleased = false;
  try {
    const seedPurgedTables: string[] = [];
    if (project.backup_repo_id) {
      await releaseProjectBackupRepoAssignment({
        project_id: project.project_id,
      });
      backupAssignmentReleased = true;
    }
    const publicSubdomains = await releaseSeedProjectAppPublicSubdomains(
      project.project_id,
    );
    if (publicSubdomains.released > 0) {
      seedPurgedTables.push("project_app_public_subdomains");
    }
    const privateHostnames = await releaseProjectAppPrivateHostnamesForProject({
      project_id: project.project_id,
    });
    if (privateHostnames.released > 0) {
      seedPurgedTables.push("project_app_private_hostnames");
    }
    const purged_tables = await purgeProjectRows({
      project,
      deleted_by: account_id,
      backup: backupDeleteResult,
      backup_retention_days: purgeBackupsImmediately ? 0 : retentionDays,
      backup_purge_due_at: backupPurgeDueAt,
      backup_purge_status: backupPurgeStatus,
      backups_purged_at: backupsPurgedAt,
    });
    await publishProjectHardDeleteRemoveEvents(project).catch((err) => {
      log.warn("failed to publish hard-delete project removal events", {
        project_id,
        err: `${err}`,
      });
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
      purged_tables: [...seedPurgedTables, ...purged_tables],
    };
  } catch (err) {
    if (backupAssignmentReleased && project.backup_repo_id) {
      try {
        await resolveProjectBackupRepoAssignment({
          project_id: project.project_id,
          project_region: project.region,
          backup_repo_id: project.backup_repo_id,
        });
      } catch (restoreErr) {
        log.warn(
          "failed to restore backup shard assignment after hard delete failure",
          {
            project_id: project.project_id,
            err: `${restoreErr}`,
          },
        );
      }
    }
    throw err;
  }
}

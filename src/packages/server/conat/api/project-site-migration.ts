/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import createProject from "@cocalc/server/projects/create";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import {
  getSeedProjectBackupConfig,
  recordExternalProjectBackupIndex,
} from "@cocalc/server/project-backup";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { setProjectEntitlementOverrideLocal } from "@cocalc/server/membership/project-entitlement-overrides";
import { deleteProjectDataOnHost } from "@cocalc/server/project-host/control";
import { setProjectLabels } from "@cocalc/server/projects/labels";
import { createLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import {
  BACKUP_LRO_KIND,
  BACKUP_TIMEOUT_MS,
  backupLroDedupeKey,
} from "@cocalc/server/projects/backup-lro";
import { triggerBackupLroWorker } from "@cocalc/server/projects/backup-worker";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  BackupProjectToExternalRepositoryOptions,
  BackupProjectToExternalRepositoryResponse,
  FinalizeIncomingProjectBackupMigrationOptions,
  FinalizeIncomingProjectBackupMigrationResult,
  GetProjectSiteMigrationSourceProjectOptions,
  GetProjectSiteMigrationSourceProjectResult,
  GetProjectSiteMigrationStatusOptions,
  PrepareIncomingProjectBackupMigrationOptions,
  PrepareIncomingProjectBackupMigrationResult,
  ProjectSiteMigrationRecord,
  ProjectSiteMigrationStatus,
} from "@cocalc/conat/hub/api/projects";

import { requireDangerousProjectMutationAuth } from "./project-dangerous-auth";

const MIGRATION_LABEL_STATUS = "cocalc.ai/project-site-migration";
const MIGRATION_LABEL_ID = "cocalc.ai/project-site-migration/id";
const DEFAULT_DISK_MARGIN_MB = 1024;
const DEFAULT_CONFIG_TTL_SECONDS = 24 * 60 * 60;

let schemaReady: Promise<void> | undefined;

async function ensureProjectSiteMigrationSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_site_migrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_site TEXT NOT NULL,
        source_project_id UUID NOT NULL,
        destination_project_id UUID NOT NULL,
        destination_owner_account_id UUID NOT NULL,
        destination_backup_repo_id UUID,
        status TEXT NOT NULL,
        source_backup_op_id UUID,
        destination_restore_op_id UUID,
        snapshot_id TEXT,
        backup_index_key TEXT,
        source_project_title TEXT,
        source_project_description TEXT,
        source_usage_bytes BIGINT,
        backup_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS project_site_migrations_source_idx
         ON project_site_migrations(source_site, source_project_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS project_site_migrations_destination_project_idx
         ON project_site_migrations(destination_project_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS project_site_migrations_status_idx
         ON project_site_migrations(status)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS project_site_migrations_created_at_idx
         ON project_site_migrations(created_at)`,
    );
  })().catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  await schemaReady;
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value as any);
  if (Number.isFinite(date.getTime())) return date.toISOString();
  return new Date(0).toISOString();
}

function asNullableIso(value: unknown): string | null {
  if (value == null) return null;
  return asIso(value);
}

function asNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = asNullableNumber(value);
    if (n != null && n > 0) return n;
  }
  return null;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeMigrationRow(row: any): ProjectSiteMigrationRecord {
  return {
    id: row.id,
    source_site: row.source_site,
    source_project_id: row.source_project_id,
    destination_project_id: row.destination_project_id,
    destination_owner_account_id: row.destination_owner_account_id,
    destination_backup_repo_id: row.destination_backup_repo_id ?? null,
    status: row.status as ProjectSiteMigrationStatus,
    source_backup_op_id: row.source_backup_op_id ?? null,
    destination_restore_op_id: row.destination_restore_op_id ?? null,
    snapshot_id: row.snapshot_id ?? null,
    backup_index_key: row.backup_index_key ?? null,
    source_project_title: row.source_project_title ?? null,
    source_project_description: row.source_project_description ?? null,
    source_usage_bytes: asNullableNumber(row.source_usage_bytes),
    backup_summary: normalizeJsonObject(row.backup_summary),
    metadata: normalizeJsonObject(row.metadata),
    error: row.error ?? null,
    created_by: row.created_by ?? null,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    completed_at: asNullableIso(row.completed_at),
  };
}

function requireAccountId(account_id?: string): string {
  const accountId = `${account_id ?? ""}`.trim();
  if (!isValidUUID(accountId)) {
    throw new Error("account_id required");
  }
  return accountId;
}

async function requireAdmin(account_id?: string): Promise<string> {
  const accountId = requireAccountId(account_id);
  if (!(await isAdmin(accountId))) {
    throw new Error("must be an admin");
  }
  return accountId;
}

async function requireFreshAuthAdmin({
  account_id,
  browser_id,
  session_hash,
}: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
}): Promise<string> {
  const accountId = await requireAdmin(account_id);
  await requireDangerousProjectMutationAuth({
    account_id: accountId,
    browser_id,
    session_hash,
  });
  return accountId;
}

function lroResponse({
  op,
  project_id,
}: {
  op: LroSummary;
  project_id: string;
}): BackupProjectToExternalRepositoryResponse {
  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

async function publishQueuedMigrationBackupLro({
  op,
  project_id,
}: {
  op: LroSummary;
  project_id: string;
}): Promise<void> {
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch {
    // Best-effort. The durable LRO row is the source of truth.
  }
  void publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued project site migration backup",
      progress: 0,
      detail: { project_id },
    },
  }).catch(() => {});
}

function normalizeSourceSite(source_site: string): string {
  const sourceSite = `${source_site ?? ""}`.trim();
  if (!sourceSite || sourceSite.length > 256) {
    throw new Error("source_site must be 1-256 characters");
  }
  return sourceSite;
}

function normalizeSourceProjectId(source_project_id: string): string {
  const projectId = `${source_project_id ?? ""}`.trim();
  if (!isValidUUID(projectId)) {
    throw new Error("source_project_id must be a valid uuid");
  }
  return projectId;
}

function normalizeOptionalText(
  value: unknown,
  maxLength: number,
): string | null {
  const text = `${value ?? ""}`.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new Error(`text value must be at most ${maxLength} characters`);
  }
  return text;
}

async function resolveDestinationOwner(owner: string): Promise<string> {
  const value = `${owner ?? ""}`.trim();
  if (!value) {
    throw new Error("owner is required");
  }
  const pool = getPool();
  if (isValidUUID(value)) {
    const { rows } = await pool.query<{ account_id: string }>(
      `SELECT account_id
         FROM accounts
        WHERE account_id=$1
          AND COALESCE(deleted, false)=false
        LIMIT 1`,
      [value],
    );
    if (!rows[0]?.account_id) {
      throw new Error(`destination owner account ${value} not found`);
    }
    return rows[0].account_id;
  }
  const email = value.toLowerCase();
  if (!isValidEmailAddress(email)) {
    throw new Error("owner must be an account_id or email address");
  }
  const { rows } = await pool.query<{ account_id: string }>(
    `SELECT account_id
       FROM accounts
      WHERE lower(email_address)=lower($1)
        AND COALESCE(deleted, false)=false
      ORDER BY created DESC
      LIMIT 1`,
    [email],
  );
  if (!rows[0]?.account_id) {
    throw new Error(`destination owner account with email ${email} not found`);
  }
  return rows[0].account_id;
}

function computeDiskOverrideMb({
  disk_mb,
  source_usage_bytes,
  warnings,
  missing_source_usage_message,
}: {
  disk_mb?: number | "auto";
  source_usage_bytes?: number | null;
  warnings: string[];
  missing_source_usage_message?: string;
}): number | null {
  if (disk_mb == null) return null;
  if (disk_mb === "auto") {
    if (
      typeof source_usage_bytes !== "number" ||
      !Number.isFinite(source_usage_bytes) ||
      source_usage_bytes <= 0
    ) {
      warnings.push(
        missing_source_usage_message ??
          "disk_mb=auto requested but source_usage_bytes was not provided; no disk override was set",
      );
      return null;
    }
    return Math.ceil(source_usage_bytes / 1024 / 1024) + DEFAULT_DISK_MARGIN_MB;
  }
  if (
    typeof disk_mb !== "number" ||
    !Number.isFinite(disk_mb) ||
    disk_mb <= 0
  ) {
    throw new Error("disk_mb must be a positive finite number or 'auto'");
  }
  return Math.ceil(disk_mb);
}

function inferSourceUsageBytesFromBackupResult(
  sourceBackup: Record<string, unknown>,
): number | null {
  const backupSummary = normalizeJsonObject(sourceBackup.backup_summary);
  const summary = normalizeJsonObject(sourceBackup.summary);
  return positiveNumber(
    backupSummary.total_bytes_processed,
    backupSummary.total_bytes,
    summary.total_bytes_processed,
    summary.total_bytes,
    sourceBackup.total_bytes_processed,
    sourceBackup.total_bytes,
  );
}

async function maybeSetFinalizeDiskOverride({
  actorAccountId,
  migration,
  destination_project_id,
  sourceBackup,
  warnings,
}: {
  actorAccountId: string;
  migration: ProjectSiteMigrationRecord;
  destination_project_id: string;
  sourceBackup: Record<string, unknown>;
  warnings: string[];
}): Promise<{
  source_usage_bytes: number | null;
  disk_override_mb: number | null;
}> {
  const requestedDisk = migration.metadata?.disk_mb;
  const existingDiskOverride = positiveNumber(
    migration.metadata?.disk_override_mb,
  );
  if (requestedDisk !== "auto" || existingDiskOverride != null) {
    return {
      source_usage_bytes: migration.source_usage_bytes,
      disk_override_mb: existingDiskOverride,
    };
  }
  const sourceUsageBytes =
    migration.source_usage_bytes ??
    inferSourceUsageBytesFromBackupResult(sourceBackup);
  const diskOverrideMb = computeDiskOverrideMb({
    disk_mb: "auto",
    source_usage_bytes: sourceUsageBytes,
    warnings,
    missing_source_usage_message:
      "disk_mb=auto requested but neither source_usage_bytes nor backup summary size was available; no disk override was set",
  });
  if (diskOverrideMb == null) {
    return {
      source_usage_bytes: sourceUsageBytes,
      disk_override_mb: null,
    };
  }
  await setProjectEntitlementOverrideLocal({
    project_id: destination_project_id,
    actor_account_id: actorAccountId,
    reason: "project site migration disk quota",
    source: "project-site-migration",
    override: {
      project_defaults: {
        disk_quota: { mode: "minimum", value: diskOverrideMb },
      },
      metadata: {
        migration_id: migration.id,
        source_site: migration.source_site,
        source_project_id: migration.source_project_id,
        finalized_from_backup: true,
      },
    },
  });
  return {
    source_usage_bytes: sourceUsageBytes,
    disk_override_mb: diskOverrideMb,
  };
}

async function loadDestinationProjectRegion(
  project_id: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ region: string | null }>(
    "SELECT region FROM projects WHERE project_id=$1",
    [project_id],
  );
  return rows[0]?.region ?? null;
}

async function markDestinationProjectArchivedForMigration({
  project_id,
}: {
  project_id: string;
}): Promise<void> {
  const checkedAt = new Date();
  const state = {
    state: "archived",
    time: checkedAt.toISOString(),
  };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
        UPDATE projects
           SET state = $2::jsonb,
               provisioned = FALSE,
               provisioned_checked_at = $3
         WHERE project_id = $1
           AND deleted IS NULL
      `,
      [project_id, state, checkedAt],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`destination project ${project_id} not found`);
    }
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.state_changed",
      project_id,
      default_bay_id: getConfiguredBayId(),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: getConfiguredBayId(),
  });
}

async function deleteDestinationProjectHostDataForMigration({
  project_id,
  host_id,
}: {
  project_id: string;
  host_id: string | null | undefined;
}): Promise<void> {
  const normalizedHostId = `${host_id ?? ""}`.trim();
  if (!normalizedHostId) {
    return;
  }
  await deleteProjectDataOnHost({
    project_id,
    host_id: normalizedHostId,
  });
}

function normalizeMigrationTags({
  tags,
  source_site,
  source_project_id,
  destination_site,
  destination_project_id,
  migration_id,
}: {
  tags?: string[];
  source_site: string;
  source_project_id: string;
  destination_site: string;
  destination_project_id: string;
  migration_id: string;
}): string[] {
  const result = new Set<string>();
  for (const tag of tags ?? []) {
    const normalized = `${tag ?? ""}`.trim();
    if (normalized) result.add(normalized);
  }
  for (const tag of [
    "cocalc-project-migration",
    `migration:${migration_id}`,
    `source-site:${source_site}`,
    `source-project:${source_project_id}`,
    `destination-site:${destination_site}`,
    `destination-project:${destination_project_id}`,
  ]) {
    result.add(tag);
  }
  return Array.from(result);
}

async function assertLocalSourceProjectForMigration(
  project_id: string,
): Promise<{ bay_id: string; epoch?: number }> {
  const ownership = await resolveProjectBay(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  if (ownership.bay_id !== getConfiguredBayId()) {
    throw new Error(
      "project site migration source backup must be requested on the source project's owning bay in v1",
    );
  }
  return ownership;
}

async function stopSourceProjectForMigration({
  project_id,
  ownership,
}: {
  project_id: string;
  ownership: { bay_id: string; epoch?: number };
}): Promise<void> {
  await getInterBayBridge().projectControl(ownership.bay_id).stop({
    project_id,
    epoch: ownership.epoch,
  });
}

async function loadMigrationRecord(
  migration_id: string,
): Promise<ProjectSiteMigrationRecord> {
  if (!isValidUUID(migration_id)) {
    throw new Error("migration_id must be a valid uuid");
  }
  await ensureProjectSiteMigrationSchema();
  const { rows } = await getPool().query(
    `SELECT *
       FROM project_site_migrations
      WHERE id=$1
      LIMIT 1`,
    [migration_id],
  );
  if (!rows[0]) {
    throw new Error(`project site migration ${migration_id} not found`);
  }
  return normalizeMigrationRow(rows[0]);
}

async function loadReusablePreparedMigration({
  sourceSite,
  sourceProjectId,
  ownerAccountId,
}: {
  sourceSite: string;
  sourceProjectId: string;
  ownerAccountId: string;
}): Promise<ProjectSiteMigrationRecord | null> {
  await ensureProjectSiteMigrationSchema();
  const { rows } = await getPool().query(
    `SELECT m.*
       FROM project_site_migrations m
       JOIN projects p
         ON p.project_id = m.destination_project_id
      WHERE m.source_site = $1
        AND m.source_project_id = $2
        AND m.destination_owner_account_id = $3
        AND m.status = 'prepared'
        AND m.snapshot_id IS NULL
        AND p.deleted IS NULL
      ORDER BY m.updated_at DESC
      LIMIT 1`,
    [sourceSite, sourceProjectId, ownerAccountId],
  );
  return rows[0] ? normalizeMigrationRow(rows[0]) : null;
}

export async function getProjectSiteMigrationSourceProject({
  account_id,
  project_id,
}: GetProjectSiteMigrationSourceProjectOptions): Promise<GetProjectSiteMigrationSourceProjectResult> {
  await requireAdmin(account_id);
  const projectId = normalizeSourceProjectId(project_id);
  await assertLocalSourceProjectForMigration(projectId);
  const { rows } = await getPool().query<{
    project_id: string;
    title: string | null;
    description: string | null;
  }>(
    `SELECT project_id, title, description
       FROM projects
      WHERE project_id=$1
        AND deleted IS NULL
      LIMIT 1`,
    [projectId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`project ${projectId} not found`);
  }
  return {
    project_id: row.project_id,
    title: row.title ?? null,
    description: row.description ?? null,
  };
}

export async function prepareIncomingProjectBackupMigration({
  account_id,
  browser_id,
  session_hash,
  source_site,
  source_project_id,
  owner,
  title,
  description,
  disk_mb,
  source_usage_bytes,
  restore_after_finalize,
}: PrepareIncomingProjectBackupMigrationOptions): Promise<PrepareIncomingProjectBackupMigrationResult> {
  const actorAccountId = await requireFreshAuthAdmin({
    account_id,
    browser_id,
    session_hash,
  });
  const sourceSite = normalizeSourceSite(source_site);
  const sourceProjectId = normalizeSourceProjectId(source_project_id);
  const ownerAccountId = await resolveDestinationOwner(owner);
  const warnings: string[] = [];
  const reusable = await loadReusablePreparedMigration({
    sourceSite,
    sourceProjectId,
    ownerAccountId,
  });
  if (reusable) {
    const destinationProjectId = reusable.destination_project_id;
    warnings.push(`reusing prepared migration ${reusable.id}`);
    await markDestinationProjectArchivedForMigration({
      project_id: destinationProjectId,
    });
    const projectRegion =
      await loadDestinationProjectRegion(destinationProjectId);
    const backupConfig = await getSeedProjectBackupConfig({
      project_id: destinationProjectId,
      project_region: projectRegion,
    });
    if (!backupConfig.backup_repo_id || !backupConfig.toml) {
      throw new Error("unable to assign destination project backup repository");
    }
    try {
      await setProjectLabels({
        project_id: destinationProjectId,
        account_id: actorAccountId,
        labels: {
          [MIGRATION_LABEL_STATUS]: "prepared",
          [MIGRATION_LABEL_ID]: reusable.id,
        },
      });
    } catch (err) {
      warnings.push(`unable to set project migration labels: ${err}`);
    }
    const ttlSeconds =
      backupConfig.ttl_seconds > 0
        ? backupConfig.ttl_seconds
        : DEFAULT_CONFIG_TTL_SECONDS;
    return {
      migration_id: reusable.id,
      destination_project_id: destinationProjectId,
      destination_backup_repo_id: backupConfig.backup_repo_id,
      rustic_repo_toml: backupConfig.toml,
      backup_index_store: backupConfig.index_store ?? null,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      warnings,
    };
  }
  const destinationProjectId = await createProject({
    account_id: ownerAccountId,
    title:
      normalizeOptionalText(title, 1024) ??
      `Migrated project ${sourceProjectId.slice(0, 8)}`,
    description: normalizeOptionalText(description, 4096) ?? "",
    start: false,
    skip_project_count_limit: true,
  });
  await markDestinationProjectArchivedForMigration({
    project_id: destinationProjectId,
  });
  const projectRegion =
    await loadDestinationProjectRegion(destinationProjectId);
  const backupConfig = await getSeedProjectBackupConfig({
    project_id: destinationProjectId,
    project_region: projectRegion,
  });
  if (!backupConfig.backup_repo_id || !backupConfig.toml) {
    throw new Error("unable to assign destination project backup repository");
  }
  const diskOverrideMb = computeDiskOverrideMb({
    disk_mb,
    source_usage_bytes,
    warnings,
    missing_source_usage_message:
      "disk_mb=auto requested but source_usage_bytes was not provided; disk override may be set during finalization from the backup summary",
  });
  const migrationId = randomUUID();
  if (diskOverrideMb != null) {
    await setProjectEntitlementOverrideLocal({
      project_id: destinationProjectId,
      actor_account_id: actorAccountId,
      reason: "project site migration disk quota",
      source: "project-site-migration",
      override: {
        project_defaults: {
          disk_quota: { mode: "minimum", value: diskOverrideMb },
        },
        metadata: {
          migration_id: migrationId,
          source_site: sourceSite,
          source_project_id: sourceProjectId,
        },
      },
    });
  }
  await ensureProjectSiteMigrationSchema();
  await getPool().query(
    `INSERT INTO project_site_migrations (
       id,
       source_site,
       source_project_id,
       destination_project_id,
       destination_owner_account_id,
       destination_backup_repo_id,
       status,
       source_project_title,
       source_project_description,
       source_usage_bytes,
       metadata,
       created_by
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
    [
      migrationId,
      sourceSite,
      sourceProjectId,
      destinationProjectId,
      ownerAccountId,
      backupConfig.backup_repo_id,
      "prepared",
      normalizeOptionalText(title, 1024),
      normalizeOptionalText(description, 4096),
      source_usage_bytes ?? null,
      JSON.stringify({
        restore_after_finalize: !!restore_after_finalize,
        disk_mb: disk_mb ?? null,
        disk_override_mb: diskOverrideMb,
        warnings,
      }),
      actorAccountId,
    ],
  );
  try {
    await setProjectLabels({
      project_id: destinationProjectId,
      account_id: actorAccountId,
      labels: {
        [MIGRATION_LABEL_STATUS]: "prepared",
        [MIGRATION_LABEL_ID]: migrationId,
      },
    });
  } catch (err) {
    warnings.push(`unable to set project migration labels: ${err}`);
  }
  const ttlSeconds =
    backupConfig.ttl_seconds > 0
      ? backupConfig.ttl_seconds
      : DEFAULT_CONFIG_TTL_SECONDS;
  return {
    migration_id: migrationId,
    destination_project_id: destinationProjectId,
    destination_backup_repo_id: backupConfig.backup_repo_id,
    rustic_repo_toml: backupConfig.toml,
    backup_index_store: backupConfig.index_store ?? null,
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    warnings,
  };
}

export async function getProjectSiteMigrationStatus({
  account_id,
  migration_id,
}: GetProjectSiteMigrationStatusOptions): Promise<ProjectSiteMigrationRecord> {
  await requireAdmin(account_id);
  return await loadMigrationRecord(migration_id);
}

export async function backupProjectToExternalRepository({
  account_id,
  browser_id,
  session_hash,
  project_id,
  destination_site,
  destination_project_id,
  migration_id,
  rustic_repo_toml,
  backup_index_store,
  exclude_rootfs_state,
  stop_source,
  require_source_stopped,
  tags,
}: BackupProjectToExternalRepositoryOptions): Promise<BackupProjectToExternalRepositoryResponse> {
  await requireFreshAuthAdmin({
    account_id,
    browser_id,
    session_hash,
  });
  const sourceProjectId = normalizeSourceProjectId(project_id);
  const destinationSite = normalizeSourceSite(destination_site);
  const destinationProjectId = normalizeSourceProjectId(destination_project_id);
  const migrationId = normalizeSourceProjectId(migration_id);
  if (exclude_rootfs_state !== true) {
    throw new Error("exclude_rootfs_state=true is required");
  }
  if (!`${rustic_repo_toml ?? ""}`.trim()) {
    throw new Error("rustic_repo_toml is required");
  }
  const ownership = await assertLocalSourceProjectForMigration(sourceProjectId);
  const shouldStopSource = stop_source !== false;
  if (!shouldStopSource && require_source_stopped) {
    throw new Error(
      "require_source_stopped without stop_source is not implemented in v1",
    );
  }
  if (shouldStopSource) {
    await stopSourceProjectForMigration({
      project_id: sourceProjectId,
      ownership,
    });
  }
  const migrationTags = normalizeMigrationTags({
    tags,
    source_site: getConfiguredBayId(),
    source_project_id: sourceProjectId,
    destination_site: destinationSite,
    destination_project_id: destinationProjectId,
    migration_id: migrationId,
  });
  const op = await createLro({
    kind: BACKUP_LRO_KIND,
    scope_type: "project",
    scope_id: sourceProjectId,
    created_by: account_id,
    routing: "hub",
    input: {
      project_id: sourceProjectId,
      tags: migrationTags,
      managed_egress_override: "admin-site-migration",
      external_migration: {
        destination_site: destinationSite,
        destination_project_id: destinationProjectId,
        migration_id: migrationId,
        rustic_repo_toml,
        backup_index_store: backup_index_store ?? null,
        exclude_rootfs_state: true,
        stopped_source: shouldStopSource,
      },
    },
    status: "queued",
    dedupe_key: backupLroDedupeKey(sourceProjectId),
    expires_at: new Date(Date.now() + BACKUP_TIMEOUT_MS),
  });
  await publishQueuedMigrationBackupLro({
    op,
    project_id: sourceProjectId,
  });
  triggerBackupLroWorker();
  return lroResponse({ op, project_id: sourceProjectId });
}

export async function finalizeIncomingProjectBackupMigration({
  account_id,
  browser_id,
  session_hash,
  migration_id,
  destination_project_id,
  snapshot_id,
  backup_index_key,
  source_backup_result,
  restore,
}: FinalizeIncomingProjectBackupMigrationOptions): Promise<FinalizeIncomingProjectBackupMigrationResult> {
  const actorAccountId = await requireFreshAuthAdmin({
    account_id,
    browser_id,
    session_hash,
  });
  if (!isValidUUID(destination_project_id)) {
    throw new Error("destination_project_id must be a valid uuid");
  }
  const snapshotId = `${snapshot_id ?? ""}`.trim();
  if (!snapshotId) {
    throw new Error("snapshot_id is required");
  }
  const migration = await loadMigrationRecord(migration_id);
  if (migration.destination_project_id !== destination_project_id) {
    throw new Error("destination_project_id does not match migration");
  }
  if (
    migration.snapshot_id &&
    migration.snapshot_id !== snapshotId &&
    migration.status !== "failed"
  ) {
    throw new Error("migration already finalized with a different snapshot_id");
  }
  const { rows } = await getPool().query<{
    backup_repo_id: string | null;
    host_id: string | null;
  }>("SELECT backup_repo_id, host_id FROM projects WHERE project_id=$1", [
    destination_project_id,
  ]);
  if (!rows[0]) {
    throw new Error(`destination project ${destination_project_id} not found`);
  }
  if (
    migration.destination_backup_repo_id &&
    rows[0].backup_repo_id !== migration.destination_backup_repo_id
  ) {
    throw new Error("destination project backup repo changed during migration");
  }
  const sourceBackup = normalizeJsonObject(source_backup_result);
  const sourceBackupId = `${sourceBackup.id ?? ""}`.trim();
  if (sourceBackupId && sourceBackupId !== snapshotId) {
    throw new Error("source_backup_result.id does not match snapshot_id");
  }
  const sourceBackupOpId = `${sourceBackup.source_backup_op_id ?? ""}`.trim();
  if (sourceBackupOpId && !isValidUUID(sourceBackupOpId)) {
    throw new Error("source_backup_result.source_backup_op_id must be a uuid");
  }
  const sourceBackupTime =
    typeof sourceBackup.time === "string" || sourceBackup.time instanceof Date
      ? sourceBackup.time
      : new Date();
  const sourceBackupIndex = normalizeJsonObject(sourceBackup.backup_index);
  const warnings: string[] = [];
  const finalizeDisk = await maybeSetFinalizeDiskOverride({
    actorAccountId,
    migration,
    destination_project_id,
    sourceBackup,
    warnings,
  });
  if (sourceBackupIndex.object_key) {
    await recordExternalProjectBackupIndex({
      project_id: destination_project_id,
      backup_id: snapshotId,
      backup_time: sourceBackupTime,
      status: "complete",
      object_key: `${sourceBackupIndex.object_key}`,
      compression:
        typeof sourceBackupIndex.compression === "string"
          ? sourceBackupIndex.compression
          : null,
      sqlite_bytes: asNullableNumber(sourceBackupIndex.sqlite_bytes),
      object_bytes: asNullableNumber(sourceBackupIndex.object_bytes),
      sha256:
        typeof sourceBackupIndex.sha256 === "string"
          ? sourceBackupIndex.sha256
          : null,
    });
  }
  await deleteDestinationProjectHostDataForMigration({
    project_id: destination_project_id,
    host_id: rows[0].host_id,
  });
  if (restore) {
    warnings.push(
      "restore after finalize is not implemented yet; migration was finalized archive-only",
    );
  }
  await markDestinationProjectArchivedForMigration({
    project_id: destination_project_id,
  });
  await getPool().query(
    `UPDATE project_site_migrations
        SET status='finalized',
            snapshot_id=$2,
            backup_index_key=$3,
            backup_summary=$4::jsonb,
            metadata=COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
            source_backup_op_id=COALESCE(source_backup_op_id, $6),
            source_usage_bytes=COALESCE(source_usage_bytes, $7),
            error=NULL,
            updated_at=NOW(),
            completed_at=COALESCE(completed_at, NOW())
      WHERE id=$1`,
    [
      migration_id,
      snapshotId,
      backup_index_key ?? null,
      JSON.stringify(source_backup_result ?? {}),
      JSON.stringify({
        finalized_by: actorAccountId,
        restore_requested: !!restore,
        finalize_warnings: warnings,
        finalize_source_usage_bytes: finalizeDisk.source_usage_bytes,
        finalize_disk_override_mb: finalizeDisk.disk_override_mb,
      }),
      sourceBackupOpId || null,
      finalizeDisk.source_usage_bytes,
    ],
  );
  try {
    await setProjectLabels({
      project_id: destination_project_id,
      account_id: actorAccountId,
      labels: {
        [MIGRATION_LABEL_STATUS]: "finalized",
        [MIGRATION_LABEL_ID]: migration_id,
      },
    });
  } catch (err) {
    warnings.push(`unable to update project migration labels: ${err}`);
  }
  return {
    migration_id,
    destination_project_id,
    snapshot_id: snapshotId,
    status: "finalized",
    warnings,
  };
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";
import createProject from "@cocalc/server/projects/create";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getSeedProjectBackupConfig } from "@cocalc/server/project-backup";
import { setProjectEntitlementOverrideLocal } from "@cocalc/server/membership/project-entitlement-overrides";
import { setProjectLabels } from "@cocalc/server/projects/labels";
import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  FinalizeIncomingProjectBackupMigrationOptions,
  FinalizeIncomingProjectBackupMigrationResult,
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
}: {
  disk_mb?: number | "auto";
  source_usage_bytes?: number | null;
  warnings: string[];
}): number | null {
  if (disk_mb == null) return null;
  if (disk_mb === "auto") {
    if (
      typeof source_usage_bytes !== "number" ||
      !Number.isFinite(source_usage_bytes) ||
      source_usage_bytes <= 0
    ) {
      warnings.push(
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

async function loadDestinationProjectRegion(
  project_id: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ region: string | null }>(
    "SELECT region FROM projects WHERE project_id=$1",
    [project_id],
  );
  return rows[0]?.region ?? null;
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
  const destinationProjectId = await createProject({
    account_id: ownerAccountId,
    title:
      normalizeOptionalText(title, 1024) ??
      `Migrated project ${sourceProjectId.slice(0, 8)}`,
    description: normalizeOptionalText(description, 4096) ?? "",
    start: false,
    skip_project_count_limit: true,
  });
  await getPool().query(
    "UPDATE projects SET provisioned=FALSE WHERE project_id=$1",
    [destinationProjectId],
  );
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
          disk_quota: { mode: "set", value: diskOverrideMb },
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
  }>("SELECT backup_repo_id FROM projects WHERE project_id=$1", [
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
  const warnings: string[] = [];
  if (restore) {
    warnings.push(
      "restore after finalize is not implemented yet; migration was finalized archive-only",
    );
  }
  await getPool().query(
    `UPDATE project_site_migrations
        SET status='finalized',
            snapshot_id=$2,
            backup_index_key=$3,
            backup_summary=$4::jsonb,
            metadata=COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
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
      }),
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

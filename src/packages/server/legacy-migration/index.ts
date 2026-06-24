/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import createProject from "@cocalc/server/projects/create";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import {
  ensureProjectFileServerClientReady,
  getProjectFileServerClient,
} from "@cocalc/server/conat/file-server-client";
import {
  assertCanAddAccountStorage,
  assertCanIncreaseAccountStorage,
  getAccountStorageRemainingBytes,
} from "@cocalc/server/membership/project-limits";
import { issueSignedObjectDownload } from "@cocalc/server/project-backup/r2";
import type {
  ProjectArchiveIndexResult,
  ProjectArchiveRestoreResult,
  SignedProjectArchiveDownload,
} from "@cocalc/conat/files/file-server";
import type {
  LegacyMigrationArchiveIndex,
  LegacyMigrationImportProjectResult,
  LegacyMigrationImportProjectsOptions,
  LegacyMigrationImportProjectsResponse,
  LegacyMigrationListProjectsOptions,
  LegacyMigrationListProjectsResponse,
  LegacyMigrationPrepareArchiveSelectionOptions,
  LegacyMigrationPrepareArchiveSelectionResponse,
  LegacyMigrationProjectRestoreMode,
  LegacyMigrationProjectRestoreStatus,
  LegacyMigrationProjectSummary,
  LegacyMigrationRestoreArchiveSelectionOptions,
  LegacyMigrationRestoreArchiveSelectionResponse,
} from "@cocalc/conat/hub/api/legacy-migration";

import { assertLegacyMigrationEnabled } from "./enabled";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_LEGACY_PROJECTS_BUCKET = "cocalc-projects";
const FILE_SERVER_READY_TIMEOUT_MS = 60_000;
const PROJECT_ARCHIVE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ARCHIVE_INDEX_MAX_ENTRIES = 5_000;
const MAX_ARCHIVE_INDEX_MAX_ENTRIES = 50_000;

type AccountEmailRow = {
  email_address: string | null;
  email_address_verified: Record<string, unknown> | null;
};

type LegacyProjectRow = {
  legacy_project_id: string;
  title: string | null;
  description: string | null;
  owner_legacy_account_id: string | null;
  legacy_users: Record<string, unknown> | null;
  hidden: boolean | null;
  last_edited: Date | string | null;
  last_active: Date | string | null;
  artifact_bucket: string | null;
  artifact_key: string | null;
  manifest_key: string | null;
  artifact_status: string | null;
  artifact_manifest: Record<string, any> | null;
  matched_legacy_account_ids?: string[] | null;
  project_id?: string | null;
  owner_account_id?: string | null;
  status?: string | null;
  restore_mode?: LegacyMigrationProjectRestoreMode | null;
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
  restore_error?: string | null;
  restore_result?: Record<string, any> | null;
  joined?: boolean | null;
  total_count?: number | null;
};

let importSchemaReady: Promise<void> | undefined;

async function ensureLegacyMigrationProjectImportSchema(): Promise<void> {
  importSchemaReady ??= (async () => {
    await getPool().query(`
      ALTER TABLE legacy_migration_project_imports
        ADD COLUMN IF NOT EXISTS restore_mode VARCHAR(32),
        ADD COLUMN IF NOT EXISTS restore_attempts INTEGER,
        ADD COLUMN IF NOT EXISTS restore_worker_id VARCHAR(64),
        ADD COLUMN IF NOT EXISTS restore_claimed_until TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_started TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_finished TIMESTAMP,
        ADD COLUMN IF NOT EXISTS restore_result JSONB
    `);
  })();
  await importSchemaReady;
}

function normalizeEmail(value: unknown): string {
  return `${value ?? ""}`.trim().toLowerCase();
}

function gmailCanonicalEmail(email: string): string | null {
  const [local, domain] = email.split("@");
  if (!local || !domain) return null;
  if (domain !== "gmail.com" && domain !== "googlemail.com") return null;
  const base = local.split("+")[0]?.replace(/\./g, "");
  return base ? `${base}@gmail.com` : null;
}

function limitValue(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function projectTitle(
  row: Pick<LegacyProjectRow, "title" | "legacy_project_id">,
) {
  const title = `${row.title ?? ""}`.trim();
  return title || `Imported CoCalc project ${row.legacy_project_id}`;
}

function projectDescription(row: LegacyProjectRow): string {
  const parts = [`Imported from cocalc.com project ${row.legacy_project_id}.`];
  const description = `${row.description ?? ""}`.trim();
  if (description) {
    parts.push("", description);
  }
  return parts.join("\n");
}

function restoreStatusForProject(
  row: Pick<LegacyProjectRow, "artifact_status" | "artifact_key">,
  restore_mode: LegacyMigrationProjectRestoreMode = "full",
): LegacyMigrationProjectRestoreStatus {
  if (row.artifact_status !== "available" || !row.artifact_key) {
    return "skipped";
  }
  return restore_mode === "select" ? "selection-pending" : "pending";
}

function normalizeRestoreMode(
  mode: unknown,
): LegacyMigrationProjectRestoreMode {
  if (mode == null || mode === "") return "full";
  if (mode === "full" || mode === "select") return mode;
  throw new Error(`unsupported legacy project restore mode '${mode}'`);
}

function positiveInteger(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function nestedValue(obj: any, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

export function legacyProjectArchiveUncompressedBytes(
  manifest: Record<string, any> | null | undefined,
): number | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  const paths = [
    ["uncompressed_bytes"],
    ["uncompressed_size_bytes"],
    ["total_uncompressed_bytes"],
    ["expanded_bytes"],
    ["logical_bytes"],
    ["file_bytes"],
    ["files_bytes"],
    ["total_file_bytes"],
    ["project_size_bytes"],
    ["project_uncompressed_bytes"],
    ["archive_uncompressed_bytes"],
    ["tar_bytes"],
    ["tar", "bytes"],
    ["tar", "uncompressed_bytes"],
    ["archive", "uncompressed_bytes"],
    ["archive", "tar_bytes"],
    ["stats", "uncompressed_bytes"],
    ["stats", "total_file_bytes"],
  ];
  for (const path of paths) {
    const value = positiveInteger(nestedValue(manifest, path));
    if (value != null) return value;
  }
  return undefined;
}

function manifestNumber(
  manifest: Record<string, any> | null | undefined,
  paths: string[][],
): number | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  for (const path of paths) {
    const value = positiveInteger(nestedValue(manifest, path));
    if (value != null) return value;
  }
  return undefined;
}

function manifestCompressedBytes(
  manifest: Record<string, any> | null | undefined,
): number | undefined {
  return manifestNumber(manifest, [
    ["compressed_bytes"],
    ["compressed_size_bytes"],
    ["artifact_bytes"],
    ["object_bytes"],
    ["r2_bytes"],
    ["archive", "compressed_bytes"],
    ["archive", "object_bytes"],
    ["artifact", "bytes"],
  ]);
}

function manifestSha256(
  manifest: Record<string, any> | null | undefined,
): string | undefined {
  if (manifest == null || typeof manifest !== "object") return undefined;
  const paths = [
    ["sha256"],
    ["content_sha256"],
    ["artifact_sha256"],
    ["compressed_sha256"],
    ["object_sha256"],
    ["archive", "sha256"],
    ["archive", "compressed_sha256"],
    ["artifact", "sha256"],
  ];
  for (const path of paths) {
    const value = `${nestedValue(manifest, path) ?? ""}`.trim();
    if (value) return value.toLowerCase();
  }
  return undefined;
}

async function assertLegacyProjectArchiveFitsAccount({
  account_id,
  legacy,
}: {
  account_id: string;
  legacy: LegacyProjectRow;
}): Promise<void> {
  if (restoreStatusForProject(legacy) !== "pending") return;
  await assertCanIncreaseAccountStorage({ account_id });
  const bytes = legacyProjectArchiveUncompressedBytes(legacy.artifact_manifest);
  if (bytes == null) return;
  await assertCanAddAccountStorage({
    account_id,
    additional_bytes: bytes,
    fresh: true,
    reason: `legacy project '${projectTitle(legacy)}' import`,
  });
}

function importStatus(row: LegacyProjectRow): LegacyMigrationProjectSummary {
  return {
    legacy_project_id: row.legacy_project_id,
    title: projectTitle(row),
    description: row.description,
    last_edited: row.last_edited,
    last_active: row.last_active,
    hidden: row.hidden,
    artifact_status: row.artifact_status,
    artifact_bucket: row.artifact_bucket,
    artifact_key: row.artifact_key,
    manifest_key: row.manifest_key,
    artifact_manifest: row.artifact_manifest,
    matched_legacy_account_ids: row.matched_legacy_account_ids ?? [],
    project_id: row.project_id,
    owner_account_id: row.owner_account_id,
    import_status:
      row.status === "creating" || row.status === "failed"
        ? row.status
        : row.project_id
          ? "imported"
          : "not-imported",
    restore_status: row.restore_status,
    restore_error: row.restore_error,
    restore_mode: row.restore_mode,
    restore_result: row.restore_result,
    joined: !!row.joined,
  };
}

async function verifiedAccountEmails(account_id: string): Promise<string[]> {
  const { rows } = await getPool().query<AccountEmailRow>(
    `SELECT email_address, email_address_verified
       FROM accounts
      WHERE account_id=$1`,
    [account_id],
  );
  const row = rows[0];
  const verified = row?.email_address_verified ?? {};
  const emails = new Set<string>();
  for (const [email, value] of Object.entries(verified)) {
    if (value) {
      const normalized = normalizeEmail(email);
      if (normalized) emails.add(normalized);
    }
  }
  const primary = normalizeEmail(row?.email_address);
  if (primary && verified[primary]) emails.add(primary);
  return [...emails].sort();
}

async function ensureVerifiedEmailLinks(account_id: string): Promise<void> {
  const emails = await verifiedAccountEmails(account_id);
  if (emails.length === 0) return;
  const gmailCanonicalEmails = Array.from(
    new Set(
      emails
        .map(gmailCanonicalEmail)
        .filter((email): email is string => email != null),
    ),
  );
  await getPool().query(
    `
    WITH candidates AS (
      SELECT legacy_account_id,
             email_address,
             lower(email_address) AS exact_email,
             CASE
               WHEN split_part(lower(email_address), '@', 2) IN ('gmail.com', 'googlemail.com')
                 THEN replace(split_part(split_part(lower(email_address), '@', 1), '+', 1), '.', '') || '@gmail.com'
               ELSE NULL
             END AS gmail_canonical_email
        FROM legacy_migration_accounts
       WHERE COALESCE(email_address_verified, false)=true
    )
    INSERT INTO legacy_migration_account_links
      (legacy_account_id, account_id, claim_method, metadata, created, updated)
    SELECT legacy_account_id,
           $1::UUID,
           'verified-email',
           jsonb_build_object(
             'email_address', email_address,
             'match_method',
             CASE
               WHEN exact_email=ANY($2::TEXT[]) THEN 'exact-email'
               ELSE 'gmail-canonical'
             END,
             'gmail_canonical_email', gmail_canonical_email
           ),
           NOW(),
           NOW()
      FROM candidates
     WHERE exact_email=ANY($2::TEXT[])
        OR (
          gmail_canonical_email IS NOT NULL
          AND gmail_canonical_email=ANY($3::TEXT[])
        )
    ON CONFLICT (legacy_account_id, account_id)
    DO UPDATE SET updated=NOW()
    `,
    [account_id, emails, gmailCanonicalEmails],
  );
}

async function legacyAccountIds(account_id: string): Promise<string[]> {
  await ensureVerifiedEmailLinks(account_id);
  const { rows } = await getPool().query<{ legacy_account_id: string }>(
    `SELECT legacy_account_id
       FROM legacy_migration_account_links
      WHERE account_id=$1
      ORDER BY legacy_account_id`,
    [account_id],
  );
  return rows.map((row) => row.legacy_account_id);
}

export async function listProjects({
  account_id,
  include_hidden,
  limit,
  query,
}: LegacyMigrationListProjectsOptions): Promise<LegacyMigrationListProjectsResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await ensureLegacyMigrationProjectImportSchema();
  const legacy_account_ids = await legacyAccountIds(account_id);
  if (legacy_account_ids.length === 0) {
    return { legacy_account_ids, projects: [], total_count: 0 };
  }
  const search = `%${`${query ?? ""}`.trim().toLowerCase()}%`;
  const useSearch = search !== "%%";
  const { rows } = await getPool().query<LegacyProjectRow>(
    `
    WITH matched AS (
      SELECT p.legacy_project_id,
             ARRAY_AGG(DISTINCT linked.legacy_account_id ORDER BY linked.legacy_account_id)
               AS matched_legacy_account_ids
        FROM legacy_migration_projects p
        JOIN legacy_migration_account_links linked
          ON linked.account_id=$1
         AND (
           p.owner_legacy_account_id=linked.legacy_account_id
           OR COALESCE(p.legacy_users, '{}'::jsonb) ? linked.legacy_account_id
         )
       WHERE ($2::BOOLEAN OR COALESCE(p.hidden, false)=false)
         AND (
           NOT $3::BOOLEAN
           OR lower(COALESCE(p.title, '')) LIKE $4
           OR lower(p.legacy_project_id) LIKE $4
         )
       GROUP BY p.legacy_project_id
    )
    SELECT p.legacy_project_id,
           p.title,
           p.description,
           p.owner_legacy_account_id,
           p.legacy_users,
           p.hidden,
           p.last_edited,
           p.last_active,
           p.artifact_bucket,
           p.artifact_key,
           p.manifest_key,
           p.artifact_status,
           p.artifact_manifest,
           matched.matched_legacy_account_ids,
           i.project_id,
           i.owner_account_id,
           i.status,
           i.restore_mode,
           i.restore_status,
           i.restore_error,
           i.restore_result,
           COUNT(*) OVER()::INTEGER AS total_count,
           EXISTS (
             SELECT 1
               FROM legacy_migration_project_import_accounts a
              WHERE a.legacy_project_id=p.legacy_project_id
                AND a.account_id=$1
           ) AS joined
      FROM legacy_migration_projects p
      JOIN matched
        ON matched.legacy_project_id=p.legacy_project_id
      LEFT JOIN legacy_migration_project_imports i
        ON i.legacy_project_id=p.legacy_project_id
     ORDER BY p.last_edited DESC NULLS LAST, p.legacy_project_id
     LIMIT $5
    `,
    [account_id, !!include_hidden, useSearch, search, limitValue(limit)],
  );
  return {
    legacy_account_ids,
    projects: rows.map(importStatus),
    total_count: rows[0]?.total_count ?? 0,
  };
}

async function authorizedLegacyProject({
  account_id,
  legacy_project_id,
}: {
  account_id: string;
  legacy_project_id: string;
}): Promise<(LegacyProjectRow & { matched_legacy_account_id: string }) | null> {
  await ensureVerifiedEmailLinks(account_id);
  const { rows } = await getPool().query<
    LegacyProjectRow & { matched_legacy_account_id: string }
  >(
    `
    SELECT p.*,
           linked.legacy_account_id AS matched_legacy_account_id
      FROM legacy_migration_projects p
      JOIN legacy_migration_account_links linked
        ON linked.account_id=$1
       AND (
         p.owner_legacy_account_id=linked.legacy_account_id
         OR COALESCE(p.legacy_users, '{}'::jsonb) ? linked.legacy_account_id
       )
     WHERE p.legacy_project_id=$2
     ORDER BY linked.legacy_account_id
     LIMIT 1
    `,
    [account_id, legacy_project_id],
  );
  return rows[0] ?? null;
}

async function addMigrationCollaborator({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `
    UPDATE projects
       SET users=jsonb_set(
             COALESCE(users, '{}'::jsonb),
             ARRAY[$2::TEXT],
             COALESCE(users -> $2::TEXT, '{}'::jsonb) ||
               jsonb_build_object('group', 'collaborator'),
             true
           ),
           last_edited=NOW()
     WHERE project_id=$1
       AND COALESCE(users -> $2::TEXT ->> 'group', '') <> 'owner'
    `,
    [project_id, account_id],
  );
  if (rowCount && rowCount > 0) {
    await syncProjectUsersOnHost({ project_id });
    await publishProjectAccountFeedEventsBestEffort({ project_id });
  }
}

async function recordImportAccount({
  account_id,
  legacy_account_id,
  legacy_project_id,
  project_id,
  role,
}: {
  account_id: string;
  legacy_account_id: string;
  legacy_project_id: string;
  project_id: string;
  role: "owner" | "collaborator";
}): Promise<void> {
  await getPool().query(
    `
    INSERT INTO legacy_migration_project_import_accounts
      (legacy_project_id, account_id, project_id, legacy_account_id, role, created, updated)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT (legacy_project_id, account_id)
    DO UPDATE SET project_id=EXCLUDED.project_id,
                  legacy_account_id=EXCLUDED.legacy_account_id,
                  role=EXCLUDED.role,
                  updated=NOW()
    `,
    [legacy_project_id, account_id, project_id, legacy_account_id, role],
  );
}

async function importOneProject({
  account_id,
  legacy_project_id,
  restore_mode,
  rootfs_image,
  rootfs_image_id,
}: {
  account_id: string;
  legacy_project_id: string;
  restore_mode: LegacyMigrationProjectRestoreMode;
  rootfs_image?: string;
  rootfs_image_id?: string;
}): Promise<LegacyMigrationImportProjectResult> {
  await ensureLegacyMigrationProjectImportSchema();
  const legacy = await authorizedLegacyProject({
    account_id,
    legacy_project_id,
  });
  if (legacy == null) {
    return {
      legacy_project_id,
      status: "failed",
      error: "legacy project is not available for this account",
    };
  }
  try {
    if (restore_mode === "full") {
      await assertLegacyProjectArchiveFitsAccount({ account_id, legacy });
    } else {
      await assertCanIncreaseAccountStorage({ account_id });
    }
  } catch (err) {
    return {
      legacy_project_id,
      status: "failed",
      error: `${err}`,
    };
  }

  const pool = getPool();
  const created = await pool.query<{ legacy_project_id: string }>(
    `
    INSERT INTO legacy_migration_project_imports
      (legacy_project_id, owner_account_id, status, restore_mode, restore_status,
       rootfs_image, rootfs_image_id, created, updated)
    VALUES ($1, $2, 'creating', $3, $4, $5, $6, NOW(), NOW())
    ON CONFLICT (legacy_project_id) DO NOTHING
    RETURNING legacy_project_id
    `,
    [
      legacy_project_id,
      account_id,
      restore_mode,
      restoreStatusForProject(legacy, restore_mode),
      rootfs_image ?? null,
      rootfs_image_id ?? null,
    ],
  );

  if (created.rowCount === 0) {
    const { rows } = await pool.query<{
      project_id: string | null;
      restore_status: LegacyMigrationProjectRestoreStatus | null;
      restore_mode: LegacyMigrationProjectRestoreMode | null;
      status: string | null;
    }>(
      `SELECT project_id, restore_mode, restore_status, status
         FROM legacy_migration_project_imports
        WHERE legacy_project_id=$1`,
      [legacy_project_id],
    );
    const migration = rows[0];
    if (!migration?.project_id) {
      return {
        legacy_project_id,
        status: migration?.status === "creating" ? "creating" : "failed",
        error:
          migration?.status === "creating"
            ? undefined
            : "legacy project import has no target project",
      };
    }
    await addMigrationCollaborator({
      account_id,
      project_id: migration.project_id,
    });
    await recordImportAccount({
      account_id,
      legacy_account_id: legacy.matched_legacy_account_id,
      legacy_project_id,
      project_id: migration.project_id,
      role: "collaborator",
    });
    return {
      legacy_project_id,
      project_id: migration.project_id,
      status: "joined",
      restore_status: migration.restore_status,
    };
  }

  try {
    const project_id = await createProject({
      account_id,
      title: projectTitle(legacy),
      description: projectDescription(legacy),
      rootfs_image,
      rootfs_image_id,
      skip_project_count_limit: true,
      start: false,
    });
    const restore_status = restoreStatusForProject(legacy, restore_mode);
    await pool.query(
      `
      UPDATE legacy_migration_project_imports
         SET project_id=$2,
             status='imported',
             restore_mode=$4,
             restore_status=$3,
             restore_error=NULL,
             updated=NOW()
       WHERE legacy_project_id=$1
      `,
      [legacy_project_id, project_id, restore_status, restore_mode],
    );
    await recordImportAccount({
      account_id,
      legacy_account_id: legacy.matched_legacy_account_id,
      legacy_project_id,
      project_id,
      role: "owner",
    });
    return {
      legacy_project_id,
      project_id,
      status: "imported",
      restore_status,
    };
  } catch (err) {
    await pool.query(
      `
      UPDATE legacy_migration_project_imports
         SET status='failed',
             restore_status='failed',
             restore_error=$2,
             updated=NOW()
       WHERE legacy_project_id=$1
      `,
      [legacy_project_id, `${err}`],
    );
    return {
      legacy_project_id,
      status: "failed",
      error: `${err}`,
    };
  }
}

export async function importProjects({
  account_id,
  legacy_project_ids,
  restore_mode,
  rootfs_image,
  rootfs_image_id,
}: LegacyMigrationImportProjectsOptions): Promise<LegacyMigrationImportProjectsResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  await ensureLegacyMigrationProjectImportSchema();
  const mode = normalizeRestoreMode(restore_mode);
  const ids = Array.from(
    new Set(
      (legacy_project_ids ?? [])
        .map((id) => `${id ?? ""}`.trim())
        .filter(Boolean),
    ),
  );
  if (ids.length === 0) {
    throw Error("select at least one legacy project");
  }
  const results: LegacyMigrationImportProjectResult[] = [];
  for (const legacy_project_id of ids) {
    results.push(
      await importOneProject({
        account_id,
        legacy_project_id,
        restore_mode: mode,
        rootfs_image,
        rootfs_image_id,
      }),
    );
  }
  return { results };
}

function clean(value: unknown): string | undefined {
  const s = `${value ?? ""}`.trim();
  return s || undefined;
}

function archiveIndexSummary(
  index: ProjectArchiveIndexResult,
): Record<string, any> {
  return {
    cache_id: index.cache_id,
    bytes: index.bytes,
    sha256: index.sha256,
    file_count: index.file_count,
    uncompressed_bytes: index.uncompressed_bytes,
    entries_returned: index.entries.length,
    truncated: index.truncated,
    duration_ms: index.duration_ms,
  };
}

function archiveIndexFromRestoreResult(
  restore_result: Record<string, any> | null | undefined,
): Record<string, any> | undefined {
  const index = restore_result?.archive_index;
  return index && typeof index === "object" ? index : undefined;
}

function normalizePathList(paths?: string[]): string[] | undefined {
  const normalized = Array.from(
    new Set(
      (paths ?? []).map((path) => `${path ?? ""}`.trim()).filter(Boolean),
    ),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function maxArchiveIndexEntries(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_ARCHIVE_INDEX_MAX_ENTRIES;
  }
  return Math.min(MAX_ARCHIVE_INDEX_MAX_ENTRIES, Math.floor(n));
}

async function getR2Credentials(): Promise<{
  endpoint: string;
  accessKey: string;
  secretKey: string;
}> {
  const settings = await getServerSettings();
  const accountId = clean((settings as any).r2_account_id);
  const accessKey = clean((settings as any).r2_access_key_id);
  const secretKey = clean((settings as any).r2_secret_access_key);
  const endpoint =
    clean(process.env.COCALC_LEGACY_PROJECTS_R2_ENDPOINT) ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error("missing R2 credentials for legacy project restore");
  }
  return { endpoint, accessKey, secretKey };
}

async function signedLegacyArchiveDownload(
  row: Pick<
    LegacyProjectRow,
    "artifact_bucket" | "artifact_key" | "artifact_manifest"
  >,
): Promise<SignedProjectArchiveDownload> {
  const bucket =
    clean(row.artifact_bucket) ??
    clean(process.env.COCALC_LEGACY_PROJECTS_BUCKET) ??
    DEFAULT_LEGACY_PROJECTS_BUCKET;
  const key = clean(row.artifact_key);
  if (!key) {
    throw new Error("legacy project archive key is missing");
  }
  const { endpoint, accessKey, secretKey } = await getR2Credentials();
  return {
    ...issueSignedObjectDownload({
      endpoint,
      accessKey,
      secretKey,
      bucket,
      key,
    }),
    bucket,
    key,
    bytes: manifestCompressedBytes(row.artifact_manifest),
    sha256: manifestSha256(row.artifact_manifest),
  };
}

async function importedProjectForAccount({
  account_id,
  legacy_project_id,
}: {
  account_id: string;
  legacy_project_id: string;
}): Promise<LegacyProjectRow | null> {
  await ensureLegacyMigrationProjectImportSchema();
  const { rows } = await getPool().query<LegacyProjectRow>(
    `
    SELECT p.legacy_project_id,
           p.title,
           p.description,
           p.owner_legacy_account_id,
           p.legacy_users,
           p.hidden,
           p.last_edited,
           p.last_active,
           p.artifact_bucket,
           p.artifact_key,
           p.manifest_key,
           p.artifact_status,
           p.artifact_manifest,
           i.project_id,
           i.owner_account_id,
           i.status,
           i.restore_mode,
           i.restore_status,
           i.restore_error,
           i.restore_result
      FROM legacy_migration_project_imports i
      JOIN legacy_migration_projects p
        ON p.legacy_project_id=i.legacy_project_id
     WHERE i.legacy_project_id=$1
       AND (
         i.owner_account_id=$2
         OR EXISTS (
           SELECT 1
             FROM legacy_migration_project_import_accounts a
            WHERE a.legacy_project_id=i.legacy_project_id
              AND a.account_id=$2
         )
       )
     LIMIT 1
    `,
    [legacy_project_id, account_id],
  );
  return rows[0] ?? null;
}

function requireSelectableImport(
  row: LegacyProjectRow | null,
): LegacyProjectRow {
  if (row == null) {
    throw new Error("legacy project import is not available for this account");
  }
  if (!row.project_id) {
    throw new Error("legacy project has no target project yet");
  }
  if (row.restore_mode !== "select") {
    throw new Error("legacy project was not imported for selective restore");
  }
  if (row.artifact_status !== "available" || !row.artifact_key) {
    throw new Error("legacy project archive is not available");
  }
  return row;
}

async function setArchiveSelectionState({
  legacy_project_id,
  restore_status,
  restore_error = null,
  restore_result,
}: {
  legacy_project_id: string;
  restore_status: LegacyMigrationProjectRestoreStatus;
  restore_error?: string | null;
  restore_result?: Record<string, any>;
}): Promise<void> {
  await getPool().query(
    `
    UPDATE legacy_migration_project_imports
       SET restore_status=$2,
           restore_error=$3,
           restore_result=COALESCE($4::JSONB, restore_result),
           restore_claimed_until=NULL,
           restore_worker_id=NULL,
           updated=NOW()
     WHERE legacy_project_id=$1
    `,
    [
      legacy_project_id,
      restore_status,
      restore_error,
      restore_result == null ? null : JSON.stringify(restore_result),
    ],
  );
}

async function projectFileServerForArchive({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}) {
  const client = await getProjectFileServerClient({
    project_id,
    account_id,
    timeout: PROJECT_ARCHIVE_TIMEOUT_MS,
  });
  await ensureProjectFileServerClientReady({
    project_id,
    client,
    maxWait: FILE_SERVER_READY_TIMEOUT_MS,
  });
  return client;
}

function toLegacyMigrationArchiveIndex(
  index: ProjectArchiveIndexResult,
): LegacyMigrationArchiveIndex {
  return index;
}

export async function prepareArchiveSelection({
  account_id,
  legacy_project_id,
  max_entries,
}: LegacyMigrationPrepareArchiveSelectionOptions): Promise<LegacyMigrationPrepareArchiveSelectionResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const row = requireSelectableImport(
    await importedProjectForAccount({ account_id, legacy_project_id }),
  );
  const project_id = row.project_id!;
  await setArchiveSelectionState({
    legacy_project_id,
    restore_status: "indexing",
    restore_error: null,
  });
  try {
    const client = await projectFileServerForArchive({
      account_id,
      project_id,
    });
    const index = await client.cacheProjectArchive({
      project_id,
      download: await signedLegacyArchiveDownload(row),
      max_entries: maxArchiveIndexEntries(max_entries),
    });
    await setArchiveSelectionState({
      legacy_project_id,
      restore_status: "indexed",
      restore_error: null,
      restore_result: {
        ...(row.restore_result ?? {}),
        archive_index: archiveIndexSummary(index),
        indexed_at: new Date().toISOString(),
      },
    });
    return {
      legacy_project_id,
      project_id,
      index: toLegacyMigrationArchiveIndex(index),
    };
  } catch (err) {
    await setArchiveSelectionState({
      legacy_project_id,
      restore_status: "selection-pending",
      restore_error: `${err}`.slice(0, 4000),
    });
    throw err;
  }
}

export async function restoreArchiveSelection({
  account_id,
  legacy_project_id,
  include_paths,
  exclude_paths,
}: LegacyMigrationRestoreArchiveSelectionOptions): Promise<LegacyMigrationRestoreArchiveSelectionResponse> {
  await assertLegacyMigrationEnabled();
  if (!account_id) {
    throw Error("account_id is required");
  }
  const row = requireSelectableImport(
    await importedProjectForAccount({ account_id, legacy_project_id }),
  );
  const project_id = row.project_id!;
  const include = normalizePathList(include_paths);
  const exclude = normalizePathList(exclude_paths);
  if (include == null && exclude == null) {
    throw new Error("select at least one include or exclude path");
  }
  const archiveIndex = archiveIndexFromRestoreResult(row.restore_result);
  const cache_id = clean(archiveIndex?.cache_id);
  if (!cache_id) {
    throw new Error("index the archive before restoring selected files");
  }
  await setArchiveSelectionState({
    legacy_project_id,
    restore_status: "restoring",
    restore_error: null,
  });
  try {
    const max_uncompressed_bytes = await getAccountStorageRemainingBytes({
      account_id: row.owner_account_id ?? account_id,
      fresh: true,
    });
    const client = await projectFileServerForArchive({
      account_id,
      project_id,
    });
    const result = await client.restoreProjectArchive({
      project_id,
      cache_id,
      include_paths: include,
      exclude_paths: exclude,
      max_uncompressed_bytes,
    });
    const restoreResult: Record<string, any> = {
      ...(row.restore_result ?? {}),
      archive_index: archiveIndex,
      restore: selectedRestoreSummary({
        result,
        include_paths: include,
        exclude_paths: exclude,
      }),
      restored_at: new Date().toISOString(),
    };
    await setArchiveSelectionState({
      legacy_project_id,
      restore_status: "restored",
      restore_error: null,
      restore_result: restoreResult,
    });
    return {
      legacy_project_id,
      project_id,
      restore_status: "restored",
      result: restoreResult,
    };
  } catch (err) {
    await setArchiveSelectionState({
      legacy_project_id,
      restore_status: "indexed",
      restore_error: `${err}`.slice(0, 4000),
    });
    throw err;
  }
}

function selectedRestoreSummary({
  result,
  include_paths,
  exclude_paths,
}: {
  result: ProjectArchiveRestoreResult;
  include_paths?: string[];
  exclude_paths?: string[];
}): Record<string, any> {
  return {
    bytes: result.bytes,
    sha256: result.sha256,
    file_count: result.file_count,
    uncompressed_bytes: result.uncompressed_bytes,
    duration_ms: result.duration_ms,
    include_paths: include_paths ?? [],
    exclude_paths: exclude_paths ?? [],
  };
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import createProject from "@cocalc/server/projects/create";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import {
  assertCanAddAccountStorage,
  assertCanIncreaseAccountStorage,
} from "@cocalc/server/membership/project-limits";
import type {
  LegacyMigrationImportProjectResult,
  LegacyMigrationImportProjectsOptions,
  LegacyMigrationImportProjectsResponse,
  LegacyMigrationListProjectsOptions,
  LegacyMigrationListProjectsResponse,
  LegacyMigrationProjectRestoreStatus,
  LegacyMigrationProjectSummary,
} from "@cocalc/conat/hub/api/legacy-migration";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

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
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
  restore_error?: string | null;
  joined?: boolean | null;
};

function normalizeEmail(value: unknown): string {
  return `${value ?? ""}`.trim().toLowerCase();
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
): LegacyMigrationProjectRestoreStatus {
  return row.artifact_status === "available" && !!row.artifact_key
    ? "pending"
    : "skipped";
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
  const email = normalizeEmail(row?.email_address);
  if (!email || !row?.email_address_verified?.[email]) {
    return [];
  }
  return [email];
}

async function ensureVerifiedEmailLinks(account_id: string): Promise<void> {
  const emails = await verifiedAccountEmails(account_id);
  if (emails.length === 0) return;
  await getPool().query(
    `
    INSERT INTO legacy_migration_account_links
      (legacy_account_id, account_id, claim_method, metadata, created, updated)
    SELECT legacy_account_id,
           $1::UUID,
           'verified-email',
           jsonb_build_object('email_address', email_address),
           NOW(),
           NOW()
      FROM legacy_migration_accounts
     WHERE COALESCE(email_address_verified, false)=true
       AND lower(email_address)=ANY($2::TEXT[])
    ON CONFLICT (legacy_account_id, account_id)
    DO UPDATE SET updated=NOW()
    `,
    [account_id, emails],
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
  if (!account_id) {
    throw Error("account_id is required");
  }
  const legacy_account_ids = await legacyAccountIds(account_id);
  if (legacy_account_ids.length === 0) {
    return { legacy_account_ids, projects: [] };
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
           i.restore_status,
           i.restore_error,
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
  rootfs_image,
  rootfs_image_id,
}: {
  account_id: string;
  legacy_project_id: string;
  rootfs_image?: string;
  rootfs_image_id?: string;
}): Promise<LegacyMigrationImportProjectResult> {
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
    await assertLegacyProjectArchiveFitsAccount({ account_id, legacy });
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
      (legacy_project_id, owner_account_id, status, restore_status,
       rootfs_image, rootfs_image_id, created, updated)
    VALUES ($1, $2, 'creating', $3, $4, $5, NOW(), NOW())
    ON CONFLICT (legacy_project_id) DO NOTHING
    RETURNING legacy_project_id
    `,
    [
      legacy_project_id,
      account_id,
      restoreStatusForProject(legacy),
      rootfs_image ?? null,
      rootfs_image_id ?? null,
    ],
  );

  if (created.rowCount === 0) {
    const { rows } = await pool.query<{
      project_id: string | null;
      restore_status: LegacyMigrationProjectRestoreStatus | null;
      status: string | null;
    }>(
      `SELECT project_id, restore_status, status
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
    const restore_status = restoreStatusForProject(legacy);
    await pool.query(
      `
      UPDATE legacy_migration_project_imports
         SET project_id=$2,
             status='imported',
             restore_status=$3,
             restore_error=NULL,
             updated=NOW()
       WHERE legacy_project_id=$1
      `,
      [legacy_project_id, project_id, restore_status],
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
  rootfs_image,
  rootfs_image_id,
}: LegacyMigrationImportProjectsOptions): Promise<LegacyMigrationImportProjectsResponse> {
  if (!account_id) {
    throw Error("account_id is required");
  }
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
        rootfs_image,
        rootfs_image_id,
      }),
    );
  }
  return { results };
}

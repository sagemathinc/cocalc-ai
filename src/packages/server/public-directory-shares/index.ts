/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { assertCollab } from "@cocalc/server/conat/api/util";
import { createLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import {
  assertCanIncreaseAccountStorage,
  getProjectOwnerAccountId,
} from "@cocalc/server/membership/project-limits";
import { triggerCopyLroWorker } from "@cocalc/server/projects/copy-worker";
import { is_valid_uuid_string as isValidUUID } from "@cocalc/util/misc";
import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";
import type {
  ListMyPublicDirectorySharesOptions,
  ListPublicDirectorySharesOptions,
  ListPublicDirectorySharesResponse,
  PublicDirectoryShareAvailability,
  PublicDirectoryShareSummary,
  PublicDirectoryShareVisibility,
  CopyPublicDirectoryShareToProjectOptions,
  CopyPublicDirectoryShareToProjectResponse,
  ResolvePublicDirectoryShareOptions,
  ResolvedPublicDirectoryShare,
  UpsertPublicDirectoryShareOptions,
} from "@cocalc/conat/hub/api/public-directory-shares";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type PublicDirectoryShareRow = PublicDirectoryShareSummary & {
  metadata?: Record<string, unknown> | null;
  total_count?: number | string | null;
};

let schemaReady: Promise<void> | undefined;

export function normalizePublicDirectoryShareSlug(slug: string): string {
  const trimmed = `${slug ?? ""}`.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    throw Error("slug must be nonempty");
  }
  if (trimmed.includes("//")) {
    throw Error("slug must not contain duplicate slashes");
  }
  for (const part of trimmed.split("/")) {
    if (!part || part === "." || part === "..") {
      throw Error("slug must not contain empty, '.', or '..' path segments");
    }
    if (/[\x00-\x1f\x7f]/.test(part)) {
      throw Error("slug must not contain control characters");
    }
  }
  return trimmed;
}

export function normalizePublicDirectorySharePath(path: string): string {
  const trimmed = `${path ?? ""}`.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed === ".") {
    return ".";
  }
  if (trimmed.includes("//")) {
    throw Error("path must not contain duplicate slashes");
  }
  for (const part of trimmed.split("/")) {
    if (!part || part === "." || part === "..") {
      throw Error("path must not contain empty, '.', or '..' path segments");
    }
    if (/[\x00-\x1f\x7f]/.test(part)) {
      throw Error("path must not contain control characters");
    }
  }
  return trimmed;
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? DEFAULT_LIMIT)));
}

function normalizeOffset(offset?: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.trunc(offset ?? 0));
}

function normalizeVisibility(
  visibility?: PublicDirectoryShareVisibility,
): PublicDirectoryShareVisibility {
  if (
    visibility === "listed" ||
    visibility === "unlisted" ||
    visibility === "private" ||
    visibility === "disabled"
  ) {
    return visibility;
  }
  return "unlisted";
}

function normalizeAvailability(
  availability?: PublicDirectoryShareAvailability,
): PublicDirectoryShareAvailability {
  if (
    availability === "available" ||
    availability === "pending" ||
    availability === "unavailable" ||
    availability === "unknown"
  ) {
    return availability;
  }
  return "unknown";
}

function readPolicyForPath(path: string): ProjectViewerReadPolicy {
  const include =
    path === "."
      ? [{ action: "include" as const, path: "." }]
      : [
          { action: "include" as const, path },
          { action: "include" as const, path: `${path}/**` },
        ];
  return {
    rules: [
      ...include,
      { action: "exclude", path: ".snapshots" },
      { action: "exclude", path: ".snapshots/**" },
      { action: "exclude", path: ".ssh" },
      { action: "exclude", path: ".ssh/**" },
      { action: "exclude", path: ".local/share/cocalc" },
      { action: "exclude", path: ".local/share/cocalc/**" },
    ],
  };
}

function rowToSummary(
  row: PublicDirectoryShareRow,
): PublicDirectoryShareSummary {
  return {
    id: row.id,
    project_id: row.project_id,
    path: row.path,
    slug: row.slug,
    visibility: row.visibility,
    requires_auth: row.requires_auth,
    availability_status: row.availability_status,
    availability_message: row.availability_message ?? null,
    title: row.title ?? null,
    description: row.description ?? null,
    license: row.license ?? null,
    image: row.image ?? null,
    redirect: row.redirect ?? null,
    legacy_public_path_id: row.legacy_public_path_id ?? null,
    legacy_url: row.legacy_url ?? null,
    site_license_id: row.site_license_id ?? null,
    site_license_pool_id: row.site_license_pool_id ?? null,
    site_license_membership_tier_id:
      row.site_license_membership_tier_id ?? null,
    site_license_duration_days: row.site_license_duration_days ?? null,
    site_license_grant_on_copy: row.site_license_grant_on_copy === true,
    site_license_copy_requires_grant:
      row.site_license_copy_requires_grant === true,
    disabled: row.disabled === true,
    last_edited: row.last_edited ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export async function ensurePublicDirectorySharesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public_project_paths (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL,
        path TEXT NOT NULL,
        slug TEXT NOT NULL,
        visibility VARCHAR(16) NOT NULL DEFAULT 'unlisted',
        requires_auth BOOLEAN NOT NULL DEFAULT TRUE,
        availability_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
        availability_message TEXT,
        title TEXT,
        description TEXT,
        license TEXT,
        image TEXT,
        redirect TEXT,
        site_license_id UUID,
        site_license_pool_id UUID,
        site_license_membership_tier_id TEXT,
        site_license_duration_days INTEGER,
        site_license_grant_on_copy BOOLEAN NOT NULL DEFAULT FALSE,
        site_license_copy_requires_grant BOOLEAN NOT NULL DEFAULT FALSE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        legacy_public_path_id TEXT,
        legacy_url TEXT,
        created_by UUID,
        updated_by UUID,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_edited TIMESTAMP,
        disabled BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS public_project_paths_slug_unique
        ON public_project_paths (lower(slug))
        WHERE disabled IS FALSE
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_paths_project_path_idx
        ON public_project_paths(project_id, path)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_paths_visibility_idx
        ON public_project_paths(visibility)
        WHERE disabled IS FALSE
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_paths_availability_status_idx
        ON public_project_paths(availability_status)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_paths_legacy_public_path_id_idx
        ON public_project_paths(legacy_public_path_id)
        WHERE legacy_public_path_id IS NOT NULL
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS public_project_paths_legacy_public_path_id_unique
        ON public_project_paths(legacy_public_path_id)
        WHERE legacy_public_path_id IS NOT NULL
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_paths_site_license_id_idx
        ON public_project_paths(site_license_id)
        WHERE site_license_id IS NOT NULL
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public_project_path_slugs (
        slug_lower TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        owning_bay_id TEXT NOT NULL,
        public_project_path_id UUID NOT NULL,
        project_id UUID NOT NULL,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_path_slugs_project_id_idx
        ON public_project_path_slugs(project_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_path_slugs_public_project_path_id_idx
        ON public_project_path_slugs(public_project_path_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_path_slugs_owning_bay_id_idx
        ON public_project_path_slugs(owning_bay_id)
    `);
  })();
  await schemaReady;
}

async function assertEnabled(): Promise<void> {
  const settings = await getServerSettings();
  if (settings.public_directory_shares_enabled !== true) {
    throw Error("public directory shares are not enabled");
  }
}

async function assertAdmin(account_id: string | undefined): Promise<void> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("user must be an admin");
  }
}

export async function resolve({
  account_id,
  slug,
}: ResolvePublicDirectoryShareOptions): Promise<ResolvedPublicDirectoryShare> {
  await assertEnabled();
  await ensurePublicDirectorySharesSchema();
  const normalizedSlug = normalizePublicDirectoryShareSlug(slug);
  const { rows } = await getPool().query<PublicDirectoryShareRow>(
    `
      SELECT p.*
      FROM public_project_path_slugs s
      JOIN public_project_paths p ON p.id=s.public_project_path_id
      WHERE s.slug_lower=lower($1)
        AND s.disabled IS FALSE
        AND p.disabled IS FALSE
        AND p.visibility <> 'disabled'
      LIMIT 1
    `,
    [normalizedSlug],
  );
  const row = rows[0];
  if (!row) {
    throw Error("public directory share not found");
  }
  if (row.requires_auth !== true) {
    // First release intentionally requires sign-in; the Conat auth layer has
    // already attached account_id, but keep this explicit for future safety.
    throw Error("anonymous public directory shares are not supported");
  }
  if (!account_id) {
    throw Error("user must be signed in");
  }
  if (row.visibility === "private") {
    const privateAccess = await getPool().query<{ allowed: boolean }>(
      `
        SELECT (COALESCE(users -> $2::text ->> 'group', '') IN ('owner', 'collaborator')) AS allowed
        FROM projects
        WHERE project_id=$1
        LIMIT 1
      `,
      [row.project_id, account_id],
    );
    if (!privateAccess.rows[0]?.allowed && !(await isAdmin(account_id))) {
      throw Error("public directory share not found");
    }
  }
  const summary = rowToSummary(row);
  return {
    ...summary,
    available: summary.availability_status === "available",
    read_policy: readPolicyForPath(summary.path),
  };
}

export async function list({
  prefix,
  limit,
  offset,
  include_unlisted,
  include_unavailable = true,
}: ListPublicDirectorySharesOptions = {}): Promise<ListPublicDirectorySharesResponse> {
  await assertEnabled();
  await ensurePublicDirectorySharesSchema();
  const normalizedLimit = normalizeLimit(limit);
  const normalizedOffset = normalizeOffset(offset);
  const params: unknown[] = [];
  const clauses = ["disabled IS FALSE", "visibility <> 'disabled'"];
  if (include_unlisted !== true) {
    clauses.push("visibility = 'listed'");
  } else {
    clauses.push("visibility IN ('listed', 'unlisted')");
  }
  if (include_unavailable !== true) {
    clauses.push("availability_status = 'available'");
  }
  if (prefix?.trim()) {
    params.push(`${normalizePublicDirectoryShareSlug(prefix)}%`);
    clauses.push(`slug ILIKE $${params.length}`);
  }
  params.push(normalizedLimit, normalizedOffset);
  const limitParam = params.length - 1;
  const offsetParam = params.length;
  const { rows } = await getPool().query<PublicDirectoryShareRow>(
    `
      SELECT *, count(*) OVER() AS total_count
      FROM public_project_paths
      WHERE ${clauses.join(" AND ")}
      ORDER BY lower(slug)
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `,
    params,
  );
  return {
    shares: rows.map(rowToSummary),
    total_count: Number(rows[0]?.total_count ?? 0),
  };
}

export async function listMine({
  account_id,
  limit,
  offset,
  include_disabled = false,
}: ListMyPublicDirectorySharesOptions = {}): Promise<ListPublicDirectorySharesResponse> {
  await assertEnabled();
  await ensurePublicDirectorySharesSchema();
  if (!account_id) {
    throw Error("user must be signed in");
  }
  const normalizedLimit = normalizeLimit(limit);
  const normalizedOffset = normalizeOffset(offset);
  const { rows } = await getPool().query<PublicDirectoryShareRow>(
    `
      SELECT pps.*, count(*) OVER() AS total_count
      FROM public_project_paths pps
      JOIN projects p ON p.project_id=pps.project_id
      WHERE COALESCE(p.users -> $1::text ->> 'group', '') IN ('owner', 'collaborator')
        AND ($2::boolean OR pps.disabled IS FALSE)
      ORDER BY pps.updated_at DESC, lower(pps.slug)
      LIMIT $3 OFFSET $4
    `,
    [account_id, include_disabled, normalizedLimit, normalizedOffset],
  );
  return {
    shares: rows.map(rowToSummary),
    total_count: Number(rows[0]?.total_count ?? 0),
  };
}

export async function upsert(
  opts: UpsertPublicDirectoryShareOptions,
): Promise<PublicDirectoryShareSummary> {
  await assertAdmin(opts.account_id);
  await ensurePublicDirectorySharesSchema();
  if (!isValidUUID(opts.project_id)) {
    throw Error("invalid project_id");
  }
  const slug = normalizePublicDirectoryShareSlug(opts.slug);
  const path = normalizePublicDirectorySharePath(opts.path);
  const visibility = normalizeVisibility(opts.visibility);
  const availabilityStatus = normalizeAvailability(opts.availability_status);
  const disabled = opts.disabled === true || visibility === "disabled";
  const id = opts.id && isValidUUID(opts.id) ? opts.id : undefined;
  const bayId = getConfiguredBayId();
  const params = [
    id,
    opts.project_id,
    path,
    slug,
    visibility,
    opts.requires_auth !== false,
    availabilityStatus,
    opts.availability_message ?? null,
    opts.title ?? null,
    opts.description ?? null,
    opts.license ?? null,
    opts.image ?? null,
    opts.redirect ?? null,
    opts.site_license_id ?? null,
    opts.site_license_pool_id ?? null,
    opts.site_license_membership_tier_id ?? null,
    opts.site_license_duration_days ?? null,
    opts.site_license_grant_on_copy === true,
    opts.site_license_copy_requires_grant === true,
    JSON.stringify(opts.metadata ?? {}),
    opts.legacy_public_path_id ?? null,
    opts.legacy_url ?? null,
    opts.account_id ?? null,
    opts.last_edited ?? null,
    disabled,
  ];
  const { rows } = await getPool().query<PublicDirectoryShareRow>(
    `
      INSERT INTO public_project_paths (
        id, project_id, path, slug, visibility, requires_auth,
        availability_status, availability_message, title, description, license,
        image, redirect, site_license_id, site_license_pool_id,
        site_license_membership_tier_id, site_license_duration_days,
        site_license_grant_on_copy, site_license_copy_requires_grant, metadata,
        legacy_public_path_id, legacy_url, created_by, updated_by, last_edited,
        disabled
      )
      VALUES (
        COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21,
        $22, $23, $23, $24, $25
      )
      ON CONFLICT (id) DO UPDATE SET
        project_id=EXCLUDED.project_id,
        path=EXCLUDED.path,
        slug=EXCLUDED.slug,
        visibility=EXCLUDED.visibility,
        requires_auth=EXCLUDED.requires_auth,
        availability_status=EXCLUDED.availability_status,
        availability_message=EXCLUDED.availability_message,
        title=EXCLUDED.title,
        description=EXCLUDED.description,
        license=EXCLUDED.license,
        image=EXCLUDED.image,
        redirect=EXCLUDED.redirect,
        site_license_id=EXCLUDED.site_license_id,
        site_license_pool_id=EXCLUDED.site_license_pool_id,
        site_license_membership_tier_id=EXCLUDED.site_license_membership_tier_id,
        site_license_duration_days=EXCLUDED.site_license_duration_days,
        site_license_grant_on_copy=EXCLUDED.site_license_grant_on_copy,
        site_license_copy_requires_grant=EXCLUDED.site_license_copy_requires_grant,
        metadata=EXCLUDED.metadata,
        legacy_public_path_id=EXCLUDED.legacy_public_path_id,
        legacy_url=EXCLUDED.legacy_url,
        updated_by=EXCLUDED.updated_by,
        updated_at=NOW(),
        last_edited=EXCLUDED.last_edited,
        disabled=EXCLUDED.disabled
      RETURNING *
    `,
    params,
  );
  const row = rows[0];
  await getPool().query(
    `
      INSERT INTO public_project_path_slugs (
        slug_lower, slug, owning_bay_id, public_project_path_id, project_id,
        disabled, updated_at
      )
      VALUES (lower($1), $1, $2, $3, $4, $5, NOW())
      ON CONFLICT (slug_lower) DO UPDATE SET
        slug=EXCLUDED.slug,
        owning_bay_id=EXCLUDED.owning_bay_id,
        public_project_path_id=EXCLUDED.public_project_path_id,
        project_id=EXCLUDED.project_id,
        disabled=EXCLUDED.disabled,
        updated_at=NOW()
    `,
    [slug, bayId, row.id, row.project_id, row.disabled],
  );
  return rowToSummary(row);
}

export async function copyToProject({
  account_id,
  slug,
  destination_project_id,
  destination_path,
  options,
}: CopyPublicDirectoryShareToProjectOptions): Promise<CopyPublicDirectoryShareToProjectResponse> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  if (!isValidUUID(destination_project_id)) {
    throw Error("invalid destination_project_id");
  }
  const share = await resolve({ account_id, slug });
  if (!share.available) {
    throw Error(
      share.availability_message ||
        "This shared directory is not available for copying yet.",
    );
  }
  await assertCollab({
    account_id,
    project_id: destination_project_id,
  });
  const ownerAccountId = await getProjectOwnerAccountId(destination_project_id);
  if (ownerAccountId) {
    await assertCanIncreaseAccountStorage({ account_id: ownerAccountId });
  }
  const destPath = normalizePublicDirectorySharePath(destination_path ?? ".");
  const op = await createLro({
    kind: "copy-path-between-projects",
    scope_type: "project",
    scope_id: destination_project_id,
    created_by: account_id,
    routing: "hub",
    input: {
      src: {
        project_id: share.project_id,
        path: share.path,
      },
      src_read_policy: share.read_policy,
      dests: [
        {
          project_id: destination_project_id,
          path: destPath,
        },
      ],
      options: {
        recursive: true,
        ...options,
      },
      public_directory_share: {
        id: share.id,
        slug: share.slug,
        legacy_public_path_id: share.legacy_public_path_id,
      },
    },
    status: "queued",
  });
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch {
    // Progress display is best-effort; the durable LRO row is authoritative.
  }
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch(() => {});
  triggerCopyLroWorker();
  return {
    destination_project_id,
    op_id: op.op_id,
    scope_type: "project",
    scope_id: destination_project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
    site_license_grant: share.site_license_grant_on_copy
      ? {
          granted: false,
          message:
            "Temporary site-license grant on copy is not implemented yet; the files are being copied without extra access.",
        }
      : undefined,
  };
}

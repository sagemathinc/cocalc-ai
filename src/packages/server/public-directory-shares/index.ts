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
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { assertCollab } from "@cocalc/server/conat/api/util";
import { getSiteLicenseOverview } from "@cocalc/server/conat/api/purchases";
import { getExplicitProjectRoutedClient } from "@cocalc/server/conat/route-client";
import createProject from "@cocalc/server/projects/create";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { resolveProjectBayAcrossCluster } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { createLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { assignSiteLicensePoolSeat as assignSiteLicensePoolSeatDirect } from "@cocalc/server/membership/site-licenses";
import {
  assertCanIncreaseAccountStorage,
  getProjectOwnerAccountId,
} from "@cocalc/server/membership/project-limits";
import { triggerCopyLroWorker } from "@cocalc/server/projects/copy-worker";
import { is_valid_uuid_string as isValidUUID } from "@cocalc/util/misc";
import {
  viewerReadPolicyAllowsPath,
  type ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";
import { projectRuntimeHomeRelativePath } from "@cocalc/util/project-runtime";
import { posix } from "node:path";
import type {
  HostConnectionInfo,
  HostStatus,
} from "@cocalc/conat/hub/api/hosts";
import type {
  ListMyPublicDirectorySharesOptions,
  ListProjectPublicDirectorySharesOptions,
  ListPublicDirectoryShareDirectoryOptions,
  ListPublicDirectoryShareDirectoryResponse,
  ListPublicDirectorySharesOptions,
  ListPublicDirectorySharesResponse,
  PublicDirectoryShareAvailability,
  PublicDirectoryShareDirectoryEntry,
  PublicDirectoryShareSummary,
  PublicDirectoryShareVisibility,
  CopyPublicDirectoryShareToNewProjectOptions,
  CopyPublicDirectoryShareToNewProjectResponse,
  CopyPublicDirectoryShareToProjectOptions,
  CopyPublicDirectoryShareToProjectResponse,
  AuthorizePublicDirectoryShareReadOptions,
  AuthorizePublicDirectoryShareReadResponse,
  CreatePublicDirectoryShareOptions,
  ResolvePublicDirectoryShareOptions,
  ResolvedPublicDirectoryShare,
  UpdatePublicDirectoryShareOptions,
  UpsertPublicDirectoryShareOptions,
} from "@cocalc/conat/hub/api/public-directory-shares";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type PublicDirectoryShareRow = PublicDirectoryShareSummary & {
  metadata?: Record<string, unknown> | null;
  created_by?: string | null;
  updated_by?: string | null;
  project_title?: string | null;
  host_id?: string | null;
  owning_bay_id?: string | null;
  host_bay_id?: string | null;
  host_name?: string | null;
  host_public_url?: string | null;
  host_internal_url?: string | null;
  host_ssh_server?: string | null;
  host_region?: string | null;
  host_tier?: number | null;
  host_status?: HostStatus | "active" | null;
  host_last_seen?: Date | string | null;
  host_metadata?: Record<string, any> | null;
  total_count?: number | string | null;
};

type PostgresErrorLike = Error & {
  code?: string;
  constraint?: string;
};

interface ResolvedPublicDirectoryShareRow {
  row: PublicDirectoryShareRow;
  share: ResolvedPublicDirectoryShare;
}

interface SiteLicenseGrantConfig {
  site_license_id: string;
  site_license_pool_id: string;
  site_license_membership_tier_id: string;
  duration_days: number;
  copy_requires_grant: boolean;
}

function isSlugUniqueViolation(err: unknown): boolean {
  const error = err as PostgresErrorLike | undefined;
  return (
    error?.code === "23505" &&
    `${error.constraint ?? error.message ?? ""}`.includes(
      "public_project_paths_slug_unique",
    )
  );
}

function slugTakenError(slug: string): Error {
  return Error(
    `The share path "${slug}" is already taken. Choose a different share path.`,
  );
}

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
  const raw = `${path ?? ""}`.trim().replace(/\\/g, "/");
  const runtimeHomeRelative = projectRuntimeHomeRelativePath(raw);
  const normalizedPath =
    runtimeHomeRelative == null ? raw : runtimeHomeRelative;
  const trimmed = normalizedPath.trim().replace(/^\/+|\/+$/g, "");
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

function defaultTitleForPath(path: string): string {
  if (path === ".") return "Project files";
  return posix.basename(path) || path;
}

function defaultCopiedProjectTitle(
  share: ResolvedPublicDirectoryShare,
): string {
  return `Copy of ${share.title?.trim() || share.slug}`;
}

function isHostPlacementFailure(err: unknown): boolean {
  const message = `${(err as Error).message ?? err ?? ""}`;
  return (
    /\bhost\b.*\bunavailable\b/i.test(message) ||
    /\bnot allowed to place a project on that host\b/i.test(message) ||
    /\bhost\b.*\bnot found\b/i.test(message)
  );
}

export function publicDirectoryShareReadPolicyForPath(
  path: string,
): ProjectViewerReadPolicy {
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

function joinProjectSharePath(rootPath: string, relativePath: string): string {
  if (relativePath === ".") {
    return rootPath;
  }
  if (rootPath === ".") {
    return relativePath;
  }
  return posix.join(rootPath, relativePath);
}

function childRelativePath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function entryAllowed({
  share,
  relativePath,
}: {
  share: ResolvedPublicDirectoryShare;
  relativePath: string;
}): boolean {
  return viewerReadPolicyAllowsPath({
    policy: share.read_policy,
    path: joinProjectSharePath(share.path, relativePath),
  });
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

function normalizeSiteLicenseDurationDays(value: unknown): number {
  if (!Number.isFinite(Number(value))) {
    return 30;
  }
  return Math.max(1, Math.min(365, Math.trunc(Number(value))));
}

function siteLicenseGrantExpiresAt(durationDays: number): Date {
  return new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
}

function seedSiteLicenseClient() {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: getConfiguredClusterSeedBayId(),
  });
}

async function validateSiteLicenseGrantConfig(
  opts: CreatePublicDirectoryShareOptions,
): Promise<SiteLicenseGrantConfig | undefined> {
  const grantRequested =
    opts.site_license_grant_on_copy === true ||
    opts.site_license_id != null ||
    opts.site_license_pool_id != null;
  if (!grantRequested) {
    return undefined;
  }
  if (!opts.account_id) {
    throw Error("user must be signed in");
  }
  const siteLicenseId = `${opts.site_license_id ?? ""}`.trim();
  const siteLicensePoolId = `${opts.site_license_pool_id ?? ""}`.trim();
  if (!isValidUUID(siteLicenseId)) {
    throw Error("site_license_id is required for temporary membership grants");
  }
  if (!isValidUUID(siteLicensePoolId)) {
    throw Error(
      "site_license_pool_id is required for temporary membership grants",
    );
  }
  const overview = await getSiteLicenseOverview({
    account_id: opts.account_id,
    site_license_id: siteLicenseId,
  });
  if (overview.viewer_role !== "admin" && overview.viewer_role !== "manager") {
    throw Error("you must be a site-license manager to publish this grant");
  }
  const pool = overview.pools.find((pool) => pool.id === siteLicensePoolId);
  if (pool == null) {
    throw Error("site-license membership pool not found");
  }
  return {
    site_license_id: siteLicenseId,
    site_license_pool_id: siteLicensePoolId,
    site_license_membership_tier_id: pool.membership_class,
    duration_days: normalizeSiteLicenseDurationDays(
      opts.site_license_duration_days,
    ),
    copy_requires_grant: opts.site_license_copy_requires_grant !== false,
  };
}

async function assignSiteLicenseGrantForShare({
  row,
  account_id,
}: {
  row: PublicDirectoryShareRow;
  account_id: string;
}): Promise<
  NonNullable<CopyPublicDirectoryShareToProjectResponse["site_license_grant"]>
> {
  const packageId = `${row.site_license_pool_id ?? ""}`.trim();
  const actorAccountId = `${row.created_by ?? ""}`.trim();
  if (!isValidUUID(packageId)) {
    throw Error("shared directory is missing a site-license membership pool");
  }
  if (!isValidUUID(actorAccountId)) {
    throw Error("shared directory is missing its publishing manager");
  }
  const durationDays = normalizeSiteLicenseDurationDays(
    row.site_license_duration_days,
  );
  const expiresAt = siteLicenseGrantExpiresAt(durationDays);
  if (getConfiguredBayId() === getConfiguredClusterSeedBayId()) {
    await assignSiteLicensePoolSeatDirect({
      actor_account_id: actorAccountId,
      package_id: packageId,
      target_account_id: account_id,
      grant_expires_at: expiresAt,
    });
  } else {
    await seedSiteLicenseClient().assignSiteLicensePoolSeat({
      actor_account_id: actorAccountId,
      package_id: packageId,
      target_account_id: account_id,
      grant_expires_at: expiresAt,
    });
  }
  const membershipClass = row.site_license_membership_tier_id ?? null;
  return {
    granted: true,
    expires_at: expiresAt,
    membership_class: membershipClass,
    site_license_id: row.site_license_id ?? null,
    package_id: packageId,
    message: `Temporary ${membershipClass ?? "site-license"} membership granted until ${expiresAt.toISOString().slice(0, 10)}.`,
  };
}

function isSiteLicenseCapacityError(err: unknown): boolean {
  return /\bno seats available\b/i.test((err as Error).message ?? "");
}

function publicShareHostConnection(
  row: PublicDirectoryShareRow,
): HostConnectionInfo | null {
  if (!row.host_id) return null;
  const metadata = row.host_metadata ?? {};
  const machine = metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const localProxy =
    metadata?.local === true ||
    metadata?.provider === "star" ||
    metadata?.cloud_provider === "star" ||
    (machine?.cloud === "self-host" && effectiveSelfHostMode === "local");
  const connectUrl = row.host_public_url ?? row.host_internal_url ?? null;
  const status =
    row.host_status === "active" ? "running" : (row.host_status ?? null);
  return {
    host_id: row.host_id,
    bay_id: row.host_bay_id ?? null,
    name: row.host_name ?? null,
    can_place: false,
    region: row.host_region ?? null,
    size: typeof metadata?.size === "string" ? metadata.size : null,
    ssh_server: row.host_ssh_server ?? null,
    connect_url: localProxy ? null : connectUrl,
    host_session_id: `${metadata?.host_session_id ?? ""}`.trim() || undefined,
    local_proxy: localProxy,
    ready: localProxy || !!connectUrl,
    status,
    tier: typeof row.host_tier === "number" ? row.host_tier : null,
    pricing_model: "on_demand",
    desired_state: status === "off" ? "stopped" : "running",
    last_seen: row.host_last_seen
      ? new Date(row.host_last_seen).toISOString()
      : undefined,
    online: status === "running",
  };
}

async function resolveRow({
  account_id,
  slug,
}: ResolvePublicDirectoryShareOptions): Promise<ResolvedPublicDirectoryShareRow> {
  await assertEnabled();
  await ensurePublicDirectorySharesSchema();
  const normalizedSlug = normalizePublicDirectoryShareSlug(slug);
  const { rows } = await getPool().query<PublicDirectoryShareRow>(
    `
      SELECT
        p.*,
        projects.title AS project_title,
        projects.host_id,
        projects.owning_bay_id,
        project_hosts.bay_id AS host_bay_id,
        project_hosts.name AS host_name,
        project_hosts.public_url AS host_public_url,
        project_hosts.internal_url AS host_internal_url,
        project_hosts.ssh_server AS host_ssh_server,
        project_hosts.region AS host_region,
        project_hosts.tier AS host_tier,
        project_hosts.status AS host_status,
        project_hosts.last_seen AS host_last_seen,
        project_hosts.metadata AS host_metadata
      FROM public_project_path_slugs s
      JOIN public_project_paths p ON p.id=s.public_project_path_id
      LEFT JOIN projects ON projects.project_id=p.project_id
      LEFT JOIN project_hosts ON project_hosts.id=projects.host_id
        AND project_hosts.deleted IS NULL
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
  let availabilityStatus = summary.availability_status;
  let availabilityMessage = summary.availability_message ?? null;
  let owningBayId = row.owning_bay_id ?? null;
  if (availabilityStatus !== "available") {
    const ownership = await resolveProjectBayAcrossCluster(row.project_id);
    if (ownership?.bay_id) {
      availabilityStatus = "available";
      availabilityMessage = null;
      owningBayId = ownership.bay_id;
    }
  }
  return {
    row,
    share: {
      ...summary,
      availability_status: availabilityStatus,
      availability_message: availabilityMessage,
      available: availabilityStatus === "available",
      read_policy: publicDirectoryShareReadPolicyForPath(summary.path),
      project_title: row.project_title ?? null,
      host_id: row.host_id ?? null,
      host_connection:
        availabilityStatus === "available"
          ? publicShareHostConnection(row)
          : null,
      owning_bay_id: owningBayId,
    },
  };
}

export async function resolve(
  opts: ResolvePublicDirectoryShareOptions,
): Promise<ResolvedPublicDirectoryShare> {
  return (await resolveRow(opts)).share;
}

export async function authorizeRead({
  account_id,
  project_id,
  share_id,
}: AuthorizePublicDirectoryShareReadOptions): Promise<AuthorizePublicDirectoryShareReadResponse> {
  await assertEnabled();
  await ensurePublicDirectorySharesSchema();
  if (!account_id) {
    throw Error("user must be signed in");
  }
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  if (!isValidUUID(share_id)) {
    throw Error("invalid public directory share id");
  }
  const { rows } = await getPool().query<PublicDirectoryShareRow>(
    `
      SELECT *
      FROM public_project_paths
      WHERE id=$1
        AND project_id=$2
        AND disabled IS FALSE
        AND visibility <> 'disabled'
      LIMIT 1
    `,
    [share_id, project_id],
  );
  const row = rows[0];
  if (!row) {
    throw Error("public directory share not found");
  }
  if (row.requires_auth !== true) {
    throw Error("anonymous public directory shares are not supported");
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
  let availabilityStatus = summary.availability_status;
  if (availabilityStatus !== "available") {
    const ownership = await resolveProjectBayAcrossCluster(row.project_id);
    if (ownership?.bay_id) {
      availabilityStatus = "available";
    }
  }
  if (availabilityStatus !== "available") {
    throw Error(
      summary.availability_message ||
        "This shared directory is not available yet.",
    );
  }
  return {
    project_id: summary.project_id,
    share_id: summary.id,
    read_policy: publicDirectoryShareReadPolicyForPath(summary.path),
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

export async function listProject({
  account_id,
  project_id,
  path,
  limit,
  offset,
  include_disabled = false,
}: ListProjectPublicDirectorySharesOptions): Promise<ListPublicDirectorySharesResponse> {
  await assertEnabled();
  await ensurePublicDirectorySharesSchema();
  if (!account_id) {
    throw Error("user must be signed in");
  }
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  await assertCollab({ account_id, project_id });
  const normalizedLimit = normalizeLimit(limit);
  const normalizedOffset = normalizeOffset(offset);
  const normalizedPath =
    path == null ? undefined : normalizePublicDirectorySharePath(path);
  const { rows } = await getPool().query<PublicDirectoryShareRow>(
    `
      SELECT *, count(*) OVER() AS total_count
      FROM public_project_paths
      WHERE project_id=$1
        AND ($2::boolean OR disabled IS FALSE)
        AND ($3::text IS NULL OR path=$3)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT $4 OFFSET $5
    `,
    [
      project_id,
      include_disabled,
      normalizedPath ?? null,
      normalizedLimit,
      normalizedOffset,
    ],
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
  return await savePublicDirectoryShare(opts);
}

async function savePublicDirectoryShare(
  opts: UpsertPublicDirectoryShareOptions,
): Promise<PublicDirectoryShareSummary> {
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
  let rows: PublicDirectoryShareRow[];
  try {
    ({ rows } = await getPool().query<PublicDirectoryShareRow>(
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
    ));
  } catch (err) {
    if (isSlugUniqueViolation(err)) {
      throw slugTakenError(slug);
    }
    throw err;
  }
  const row = rows[0];
  await getPool().query(
    `
      DELETE FROM public_project_path_slugs
      WHERE public_project_path_id=$1 AND slug_lower <> lower($2)
    `,
    [row.id, slug],
  );
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

export async function update(
  opts: UpdatePublicDirectoryShareOptions,
): Promise<PublicDirectoryShareSummary> {
  await assertEnabled();
  await ensurePublicDirectorySharesSchema();
  if (!opts.account_id) {
    throw Error("user must be signed in");
  }
  if (!isValidUUID(opts.id)) {
    throw Error("invalid public directory share id");
  }
  const { rows } = await getPool().query<PublicDirectoryShareRow>(
    "SELECT * FROM public_project_paths WHERE id=$1 LIMIT 1",
    [opts.id],
  );
  const current = rows[0];
  if (!current) {
    throw Error("public directory share not found");
  }
  await assertCollab({
    account_id: opts.account_id,
    project_id: current.project_id,
  });

  let siteLicenseGrant: SiteLicenseGrantConfig | undefined;
  if (opts.site_license_grant_on_copy === true) {
    siteLicenseGrant = await validateSiteLicenseGrantConfig({
      account_id: opts.account_id,
      project_id: current.project_id,
      path: current.path,
      slug: opts.slug ?? current.slug,
      site_license_grant_on_copy: true,
      site_license_copy_requires_grant: opts.site_license_copy_requires_grant,
      site_license_id: opts.site_license_id ?? undefined,
      site_license_pool_id: opts.site_license_pool_id ?? undefined,
      site_license_duration_days: opts.site_license_duration_days ?? undefined,
    });
  }

  const disabled = opts.disabled === true;
  return await savePublicDirectoryShare({
    account_id: opts.account_id,
    id: current.id,
    project_id: current.project_id,
    path: current.path,
    slug: opts.slug ?? current.slug,
    visibility: disabled ? "disabled" : current.visibility,
    requires_auth: current.requires_auth,
    availability_status: current.availability_status,
    availability_message: current.availability_message ?? null,
    title: opts.title ?? current.title ?? null,
    description: opts.description ?? current.description ?? null,
    license: opts.license ?? current.license ?? null,
    image: current.image ?? null,
    redirect: current.redirect ?? null,
    legacy_public_path_id: current.legacy_public_path_id ?? null,
    legacy_url: current.legacy_url ?? null,
    site_license_id: siteLicenseGrant?.site_license_id ?? null,
    site_license_pool_id: siteLicenseGrant?.site_license_pool_id ?? null,
    site_license_membership_tier_id:
      siteLicenseGrant?.site_license_membership_tier_id ?? null,
    site_license_duration_days: siteLicenseGrant?.duration_days ?? null,
    site_license_grant_on_copy: siteLicenseGrant != null,
    site_license_copy_requires_grant:
      siteLicenseGrant?.copy_requires_grant ?? false,
    metadata: current.metadata ?? {},
    last_edited: current.last_edited ?? null,
    disabled,
  });
}

export async function create(
  opts: CreatePublicDirectoryShareOptions,
): Promise<PublicDirectoryShareSummary> {
  await assertEnabled();
  await ensurePublicDirectorySharesSchema();
  if (!opts.account_id) {
    throw Error("user must be signed in");
  }
  if (!isValidUUID(opts.project_id)) {
    throw Error("invalid project_id");
  }
  await assertCollab({
    account_id: opts.account_id,
    project_id: opts.project_id,
  });
  const slug = normalizePublicDirectoryShareSlug(opts.slug);
  const path = normalizePublicDirectorySharePath(opts.path);
  const fs = (
    await getExplicitProjectRoutedClient({
      account_id: opts.account_id,
      project_id: opts.project_id,
    })
  ).fs({
    project_id: opts.project_id,
  });
  try {
    await fs.getListing(path);
  } catch (err) {
    throw Error(
      `shared path must be an existing directory (${(err as Error).message})`,
    );
  }
  const siteLicenseGrant = await validateSiteLicenseGrantConfig(opts);
  return await savePublicDirectoryShare({
    account_id: opts.account_id,
    project_id: opts.project_id,
    path,
    slug,
    visibility: "unlisted",
    requires_auth: true,
    availability_status: "available",
    title: opts.title?.trim() || defaultTitleForPath(path),
    description: opts.description?.trim() || null,
    license: opts.license?.trim() || null,
    site_license_id: siteLicenseGrant?.site_license_id ?? null,
    site_license_pool_id: siteLicenseGrant?.site_license_pool_id ?? null,
    site_license_membership_tier_id:
      siteLicenseGrant?.site_license_membership_tier_id ?? null,
    site_license_duration_days: siteLicenseGrant?.duration_days ?? null,
    site_license_grant_on_copy: siteLicenseGrant != null,
    site_license_copy_requires_grant:
      siteLicenseGrant?.copy_requires_grant ?? false,
    metadata: {
      source: "project-file-browser",
      site_license_grant_configured_by: siteLicenseGrant
        ? opts.account_id
        : undefined,
    },
  });
}

export async function copyToProject({
  account_id,
  slug,
  path,
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
  const { row, share } = await resolveRow({ account_id, slug });
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
  let siteLicenseGrant:
    | CopyPublicDirectoryShareToProjectResponse["site_license_grant"]
    | undefined;
  if (share.site_license_grant_on_copy) {
    try {
      siteLicenseGrant = await assignSiteLicenseGrantForShare({
        row,
        account_id,
      });
    } catch (err) {
      if (
        share.site_license_copy_requires_grant &&
        !isSiteLicenseCapacityError(err)
      ) {
        throw Error(
          `Temporary site-license membership could not be granted, so the share was not copied: ${(err as Error).message}`,
        );
      }
      siteLicenseGrant = {
        granted: false,
        message: `Temporary site-license membership could not be granted: ${(err as Error).message}`,
      };
    }
  }
  const relativePath = normalizePublicDirectorySharePath(path ?? ".");
  if (!entryAllowed({ share, relativePath })) {
    throw Error("path is not part of this shared directory");
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
        path: joinProjectSharePath(share.path, relativePath),
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
        path: relativePath,
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
    site_license_grant: siteLicenseGrant,
  };
}

export async function copyToNewProject({
  account_id,
  slug,
  path,
  title,
  options,
}: CopyPublicDirectoryShareToNewProjectOptions): Promise<CopyPublicDirectoryShareToNewProjectResponse> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  const { share } = await resolveRow({ account_id, slug });
  if (!share.available) {
    throw Error(
      share.availability_message ||
        "This shared directory is not available for copying yet.",
    );
  }
  const { rows } = await getPool().query<{
    host_id: string | null;
    region: string | null;
    rootfs_image: string | null;
    rootfs_image_id: string | null;
  }>(
    `
      SELECT host_id, region, rootfs_image, rootfs_image_id
      FROM projects
      WHERE project_id=$1
      LIMIT 1
    `,
    [share.project_id],
  );
  const sourceProject = rows[0];
  const currentRootfsRows = await getPool().query<{
    image: string | null;
    image_id: string | null;
  }>(
    `
      SELECT runtime_image AS image, image_id
      FROM project_rootfs_states
      WHERE project_id=$1 AND state_role='current'
      LIMIT 1
    `,
    [share.project_id],
  );
  const sourceRootfs = currentRootfsRows.rows[0];
  const createOpts = {
    account_id,
    title: title?.trim() || defaultCopiedProjectTitle(share),
    description: `Copied from published folder ${share.slug}.`,
    rootfs_image:
      sourceRootfs?.image ?? sourceProject?.rootfs_image ?? undefined,
    rootfs_image_id:
      sourceRootfs?.image_id ?? sourceProject?.rootfs_image_id ?? undefined,
    host_id: sourceProject?.host_id ?? undefined,
    region: sourceProject?.region ?? undefined,
    start: false,
  };
  let destinationProjectId: string;
  let placedOnRequestedHost = !!createOpts.host_id;
  try {
    destinationProjectId = await createProject(createOpts);
  } catch (err) {
    if (!createOpts.host_id || !isHostPlacementFailure(err)) {
      throw err;
    }
    placedOnRequestedHost = false;
    destinationProjectId = await createProject({
      ...createOpts,
      host_id: undefined,
    });
  }
  const copy = await copyToProject({
    account_id,
    slug,
    path,
    destination_project_id: destinationProjectId,
    destination_path: ".",
    options: { recursive: true, ...options },
  });
  return {
    ...copy,
    created_project: true,
    requested_host_id: createOpts.host_id ?? null,
    placed_on_requested_host: placedOnRequestedHost,
  };
}

export async function listDirectory({
  account_id,
  slug,
  path,
}: ListPublicDirectoryShareDirectoryOptions): Promise<ListPublicDirectoryShareDirectoryResponse> {
  const share = await resolve({ account_id, slug });
  if (!share.available) {
    throw Error(
      share.availability_message ||
        "This shared directory is not available yet.",
    );
  }
  const relativePath = normalizePublicDirectorySharePath(path ?? ".");
  if (!entryAllowed({ share, relativePath })) {
    throw Error("path is not part of this shared directory");
  }
  const fs = (
    await getExplicitProjectRoutedClient({
      project_id: share.project_id,
    })
  ).fs({
    project_id: share.project_id,
  });
  const projectPath = joinProjectSharePath(share.path, relativePath);
  const listing = await fs.getListing(projectPath);
  const entries: PublicDirectoryShareDirectoryEntry[] = [];
  for (const [name, data] of Object.entries(listing.files ?? {})) {
    const entryPath = childRelativePath(relativePath, name);
    if (!entryAllowed({ share, relativePath: entryPath })) {
      continue;
    }
    entries.push({
      name,
      path: entryPath,
      type: data.type,
      size: data.size,
      mtime: data.mtime,
      isDir: data.isDir,
      isSymLink: data.isSymLink,
      linkTarget: data.linkTarget,
    });
  }
  entries.sort((left, right) => {
    const leftDir = left.type === "d" || left.isDir === true;
    const rightDir = right.type === "d" || right.isDir === true;
    if (leftDir !== rightDir) return leftDir ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return {
    share,
    path: relativePath,
    entries,
    truncated: listing.truncated,
  };
}

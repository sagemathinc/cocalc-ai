/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { lroStreamName } from "@cocalc/conat/lro/names";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { requireFreshAuthForSessionHash } from "@cocalc/server/auth/auth-sessions";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { assertCollab } from "@cocalc/server/conat/api/util";
import { getSiteLicenseOverview } from "@cocalc/server/conat/api/purchases";
import { getProjectFsClient } from "@cocalc/server/conat/file-server-client";
import createProject from "@cocalc/server/projects/create";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import {
  resolveHostBayAcrossCluster,
  resolveProjectBayAcrossCluster,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { createLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import {
  assignSiteLicensePoolSeat as assignSiteLicensePoolSeatDirect,
  revokeSiteLicensePoolSeat as revokeSiteLicensePoolSeatDirect,
} from "@cocalc/server/membership/site-licenses";
import {
  assertCanIncreaseAccountStorage,
  getProjectOwnerAccountId,
  getPublicDirectoryShareLimitForAccount,
} from "@cocalc/server/membership/project-limits";
import { triggerCopyLroWorker } from "@cocalc/server/projects/copy-worker";
import {
  getProjectLabels,
  setProjectLabels,
  type ProjectLabelPatch,
} from "@cocalc/server/projects/labels";
import { is_valid_uuid_string as isValidUUID } from "@cocalc/util/misc";
import {
  DEFAULT_MAX_PUBLIC_DIRECTORY_SHARES_PER_ACCOUNT,
  MAX_PUBLIC_DIRECTORY_SHARE_DESCRIPTION_LENGTH,
  MAX_PUBLIC_DIRECTORY_SHARE_LICENSE_LENGTH,
  MAX_PUBLIC_DIRECTORY_SHARE_PROJECT_PATH_LENGTH,
  MAX_PUBLIC_DIRECTORY_SHARE_SLUG_LENGTH,
  MAX_PUBLIC_DIRECTORY_SHARE_TITLE_LENGTH,
  PUBLIC_DIRECTORY_SHARE_LABEL_PREFIX,
  publicDirectoryShareProjectLabelKey,
  publicDirectoryShareProjectLabelValue,
} from "@cocalc/util/public-directory-share-labels";
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
  PublicDirectoryShareTheme,
  PublicDirectoryShareVisibility,
  CopyPublicDirectoryShareToNewProjectOptions,
  CopyPublicDirectoryShareToNewProjectResponse,
  CopyPublicDirectoryShareToProjectOptions,
  CopyPublicDirectoryShareToProjectResponse,
  DisableMyPublicDirectorySharesByActorOptions,
  DisableMyPublicDirectorySharesByActorResponse,
  AuthorizePublicDirectoryShareReadOptions,
  AuthorizePublicDirectoryShareReadResponse,
  CreatePublicDirectoryShareOptions,
  GetTemporaryViewerReadPolicyOptions,
  GetTemporaryViewerReadPolicyResponse,
  GrantTemporaryViewerAccessOptions,
  GrantTemporaryViewerAccessResponse,
  ResolvePublicDirectoryShareOptions,
  ResolvedPublicDirectoryShare,
  UpdatePublicDirectoryShareOptions,
  UpsertPublicDirectoryShareOptions,
} from "@cocalc/conat/hub/api/public-directory-shares";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_TEMPORARY_VIEWER_GRANT_DAYS = 7;
const DISABLED_PREVIOUS_VISIBILITY_METADATA_KEY =
  "public_share_previous_visibility";
const log = getLogger("server:public-directory-shares");

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

type TemporaryViewerGrantRow = {
  id: string;
  public_project_path_id: string;
  project_id: string;
  account_id: string;
  read_policy: ProjectViewerReadPolicy;
  status: string;
  expires_at: Date | string;
};

type PublicShareSiteLicenseGrantRow = {
  id: string;
  public_project_path_id: string;
  assignment_id: string;
  package_id: string;
  target_account_id: string;
  actor_account_id: string;
  status: string;
};

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
  if (trimmed.length > MAX_PUBLIC_DIRECTORY_SHARE_SLUG_LENGTH) {
    throw Error(
      `slug must be at most ${MAX_PUBLIC_DIRECTORY_SHARE_SLUG_LENGTH} characters`,
    );
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
  if (
    posix.isAbsolute(raw) &&
    raw !== "/home/user" &&
    !raw.startsWith("/home/user/")
  ) {
    throw Error("path must be in /home/user");
  }
  const runtimeHomeRelative = projectRuntimeHomeRelativePath(raw);
  const normalizedPath =
    runtimeHomeRelative == null ? raw : runtimeHomeRelative;
  const trimmed = normalizedPath.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed === ".") {
    return ".";
  }
  if (trimmed.length > MAX_PUBLIC_DIRECTORY_SHARE_PROJECT_PATH_LENGTH) {
    throw Error(
      `path must be at most ${MAX_PUBLIC_DIRECTORY_SHARE_PROJECT_PATH_LENGTH} characters`,
    );
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

function isActiveShareVisibility(
  visibility: unknown,
): visibility is Exclude<PublicDirectoryShareVisibility, "disabled"> {
  return (
    visibility === "listed" ||
    visibility === "unlisted" ||
    visibility === "private"
  );
}

function previousVisibilityFromMetadata(
  metadata?: Record<string, unknown> | null,
): Exclude<PublicDirectoryShareVisibility, "disabled"> {
  const previous = metadata?.[DISABLED_PREVIOUS_VISIBILITY_METADATA_KEY];
  return isActiveShareVisibility(previous) ? previous : "unlisted";
}

function metadataWithPreviousVisibility(
  current: PublicDirectoryShareRow,
): Record<string, unknown> {
  const metadata = { ...(current.metadata ?? {}) };
  if (isActiveShareVisibility(current.visibility)) {
    metadata[DISABLED_PREVIOUS_VISIBILITY_METADATA_KEY] = current.visibility;
  }
  return metadata;
}

function metadataWithoutPreviousVisibility(
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next[DISABLED_PREVIOUS_VISIBILITY_METADATA_KEY];
  return next;
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

function normalizeOptionalPublicShareText({
  field,
  maxLength,
  value,
}: {
  field: string;
  maxLength: number;
  value?: string | null;
}): string | null {
  const text = `${value ?? ""}`.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw Error(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function normalizePublicShareTitle({
  fallback,
  value,
}: {
  fallback: string;
  value?: string | null;
}): string {
  const fallbackTitle = fallback.slice(
    0,
    MAX_PUBLIC_DIRECTORY_SHARE_TITLE_LENGTH,
  );
  return (
    normalizeOptionalPublicShareText({
      field: "title",
      maxLength: MAX_PUBLIC_DIRECTORY_SHARE_TITLE_LENGTH,
      value,
    }) ?? fallbackTitle
  );
}

function normalizePublicShareDescription(value?: string | null): string | null {
  return normalizeOptionalPublicShareText({
    field: "description",
    maxLength: MAX_PUBLIC_DIRECTORY_SHARE_DESCRIPTION_LENGTH,
    value,
  });
}

function normalizePublicShareLicense(value?: string | null): string | null {
  return normalizeOptionalPublicShareText({
    field: "license",
    maxLength: MAX_PUBLIC_DIRECTORY_SHARE_LICENSE_LENGTH,
    value,
  });
}

function normalizePublicShareThemeString({
  field,
  value,
  maxLength = 256,
}: {
  field: string;
  value?: string | null;
  maxLength?: number;
}): string | null {
  const text = `${value ?? ""}`.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw Error(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function normalizePublicShareThemeStyle(
  theme?: PublicDirectoryShareTheme | null,
): PublicDirectoryShareTheme | null {
  if (theme == null) return null;
  const normalized: PublicDirectoryShareTheme = {
    color: normalizePublicShareThemeString({
      field: "theme color",
      value: theme.color,
      maxLength: 64,
    }),
    accent_color: normalizePublicShareThemeString({
      field: "theme accent color",
      value: theme.accent_color,
      maxLength: 64,
    }),
    icon: normalizePublicShareThemeString({
      field: "theme icon",
      value: theme.icon,
      maxLength: 128,
    }),
    image_blob: normalizePublicShareThemeString({
      field: "theme image",
      value: theme.image_blob,
      maxLength: 256,
    }),
  };
  return Object.values(normalized).some((value) => value != null)
    ? normalized
    : null;
}

function publicShareThemeFromMetadata(
  metadata?: Record<string, unknown> | null,
): PublicDirectoryShareTheme | null {
  const theme = metadata?.theme as PublicDirectoryShareTheme | undefined | null;
  return normalizePublicShareThemeStyle(theme);
}

function publicShareMetadataWithTheme({
  metadata,
  theme,
}: {
  metadata?: Record<string, unknown> | null;
  theme?: PublicDirectoryShareTheme | null;
}): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (theme !== undefined) {
    const normalized = normalizePublicShareThemeStyle(theme);
    if (normalized == null) {
      delete next.theme;
    } else {
      next.theme = normalized;
    }
  }
  return next;
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
      { action: "exclude", path: ".backups" },
      { action: "exclude", path: ".backups/**" },
      { action: "exclude", path: ".ssh" },
      { action: "exclude", path: ".ssh/**" },
      { action: "exclude", path: ".cache" },
      { action: "exclude", path: ".cache/**" },
      { action: "exclude", path: ".local" },
      { action: "exclude", path: ".local/**" },
    ],
  };
}

function assertPublicDirectorySharePathAllowed(path: string): void {
  const readPolicy = publicDirectoryShareReadPolicyForPath(path);
  if (!viewerReadPolicyAllowsPath({ policy: readPolicy, path })) {
    throw Error("path is excluded from public sharing");
  }
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

async function copySourceForPublicDirectoryShare({
  account_id,
  share,
  relativePath,
}: {
  account_id: string;
  share: ResolvedPublicDirectoryShare;
  relativePath: string;
}): Promise<{
  project_id: string;
  path: string | string[];
  base_path?: string;
}> {
  const projectPath = joinProjectSharePath(share.path, relativePath);
  if (projectPath !== ".") {
    return {
      project_id: share.project_id,
      path: projectPath,
    };
  }

  const fs = await getProjectFsClient({
    account_id,
    project_id: share.project_id,
  });
  const listing = await fs.getListing(".");
  const paths = Object.keys(listing.files ?? {})
    .filter((name) => name !== "." && name !== "..")
    .filter((name) => entryAllowed({ share, relativePath: name }))
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0) {
    throw Error("This shared project has no files available to copy.");
  }
  return {
    project_id: share.project_id,
    path: paths,
    base_path: ".",
  };
}

function rowToSummary(
  row: PublicDirectoryShareRow,
): PublicDirectoryShareSummary {
  const themeStyle = publicShareThemeFromMetadata(row.metadata);
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
    theme: {
      title: row.title ?? null,
      description: row.description ?? null,
      color: themeStyle?.color ?? null,
      accent_color: themeStyle?.accent_color ?? null,
      icon: themeStyle?.icon ?? null,
      image_blob: row.image ?? themeStyle?.image_blob ?? null,
    },
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
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    last_edited: row.last_edited ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

async function syncPublicDirectoryShareProjectLabels({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id?: string | null;
}): Promise<void> {
  try {
    const [currentLabels, { rows }] = await Promise.all([
      getProjectLabels({ project_id }),
      getPool().query<PublicDirectoryShareRow>(
        `
          SELECT *
          FROM public_project_paths
          WHERE project_id=$1
            AND disabled IS FALSE
            AND visibility <> 'disabled'
          ORDER BY path ASC, slug ASC
        `,
        [project_id],
      ),
    ]);

    const labels: ProjectLabelPatch = {};
    for (const key of Object.keys(currentLabels)) {
      if (key.startsWith(PUBLIC_DIRECTORY_SHARE_LABEL_PREFIX)) {
        labels[key] = null;
      }
    }
    for (const row of rows) {
      const value = publicDirectoryShareProjectLabelValue(rowToSummary(row));
      if (value == null) continue;
      labels[publicDirectoryShareProjectLabelKey(row.id)] = value;
    }
    if (Object.keys(labels).length === 0) return;

    await setProjectLabels({ project_id, account_id, labels });
  } catch (err) {
    log.warn("failed to sync public directory share project labels", {
      project_id,
      account_id,
      error: `${err}`,
    });
  }
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
      CREATE INDEX IF NOT EXISTS public_project_paths_created_by_active_idx
        ON public_project_paths(created_by)
        WHERE disabled IS FALSE AND visibility <> 'disabled'
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public_project_path_viewer_grants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        public_project_path_id UUID NOT NULL,
        project_id UUID NOT NULL,
        account_id UUID NOT NULL,
        read_policy JSONB NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        grant_reason TEXT NOT NULL DEFAULT 'share-url',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        revoked_by UUID,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE(public_project_path_id, account_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_path_viewer_grants_project_account_idx
        ON public_project_path_viewer_grants(project_id, account_id)
        WHERE status = 'active'
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_path_viewer_grants_expiry_idx
        ON public_project_path_viewer_grants(expires_at)
        WHERE status = 'active'
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public_project_path_site_license_grants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        public_project_path_id UUID NOT NULL,
        assignment_id UUID NOT NULL,
        package_id UUID NOT NULL,
        target_account_id UUID NOT NULL,
        actor_account_id UUID NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMP,
        revoked_by UUID,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE(public_project_path_id, assignment_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_path_site_license_grants_share_idx
        ON public_project_path_site_license_grants(public_project_path_id)
        WHERE status = 'active'
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_project_path_site_license_grants_assignment_idx
        ON public_project_path_site_license_grants(assignment_id)
        WHERE status = 'active'
    `);
  })();
  await schemaReady;
}

async function assertAdmin(account_id: string | undefined): Promise<void> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("user must be an admin");
  }
}

async function getActivePublicDirectoryShareCountForAccount(
  account_id: string,
): Promise<number> {
  const { rows } = await getPool().query<{ count: string | number }>(
    `
      SELECT COUNT(*) AS count
      FROM public_project_paths
      WHERE created_by=$1
        AND disabled IS FALSE
        AND visibility <> 'disabled'
    `,
    [account_id],
  );
  return Number(rows[0]?.count ?? 0);
}

async function assertCanCreatePublicDirectoryShare(
  account_id: string,
): Promise<void> {
  const [limit, current] = await Promise.all([
    getPublicDirectoryShareLimitForAccount({ account_id }).catch((err) => {
      log.warn(
        "failed to resolve public directory share limit; using default",
        {
          account_id,
          error: `${err}`,
        },
      );
      return DEFAULT_MAX_PUBLIC_DIRECTORY_SHARES_PER_ACCOUNT;
    }),
    getActivePublicDirectoryShareCountForAccount(account_id),
  ]);
  const effectiveLimit = Number.isFinite(limit)
    ? limit
    : DEFAULT_MAX_PUBLIC_DIRECTORY_SHARES_PER_ACCOUNT;
  if (current >= effectiveLimit) {
    throw Error(
      `public directory share limit reached (${current}/${effectiveLimit}); disable an existing public share or upgrade membership`,
    );
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

async function revokeShareSiteLicenseGrant({
  grant,
  revoked_by,
}: {
  grant: PublicShareSiteLicenseGrantRow;
  revoked_by?: string | null;
}): Promise<void> {
  const { rows } = await getPool().query<{ id: string }>(
    `
      SELECT id
      FROM membership_package_assignments
      WHERE id=$1
        AND package_id=$2
        AND account_id=$3
        AND revoked_at IS NULL
      LIMIT 1
    `,
    [grant.assignment_id, grant.package_id, grant.target_account_id],
  );
  if (!rows[0]) {
    await getPool().query(
      `
        UPDATE public_project_path_site_license_grants
        SET status='stale',
            revoked_at=NOW(),
            revoked_by=$2
        WHERE id=$1
          AND status='active'
      `,
      [grant.id, revoked_by ?? null],
    );
    return;
  }
  const actorAccountId = revoked_by ?? grant.actor_account_id;
  const revoked =
    getConfiguredBayId() === getConfiguredClusterSeedBayId()
      ? await revokeSiteLicensePoolSeatDirect({
          actor_account_id: actorAccountId,
          package_id: grant.package_id,
          target_account_id: grant.target_account_id,
          trusted_admin: true,
        })
      : (
          await seedSiteLicenseClient().revokeSiteLicensePoolSeat({
            actor_account_id: actorAccountId,
            package_id: grant.package_id,
            target_account_id: grant.target_account_id,
            trusted_admin: true,
          })
        ).revoked;
  await getPool().query(
    `
      UPDATE public_project_path_site_license_grants
      SET status=$2,
          revoked_at=NOW(),
          revoked_by=$3
      WHERE id=$1
        AND status='active'
    `,
    [grant.id, revoked ? "revoked" : "stale", actorAccountId],
  );
}

async function revokeShareSiteLicenseGrants({
  public_project_path_id,
  revoked_by,
}: {
  public_project_path_id: string;
  revoked_by?: string | null;
}): Promise<void> {
  const { rows } = await getPool().query<PublicShareSiteLicenseGrantRow>(
    `
      SELECT *
      FROM public_project_path_site_license_grants
      WHERE public_project_path_id=$1
        AND status='active'
    `,
    [public_project_path_id],
  );
  for (const grant of rows) {
    await revokeShareSiteLicenseGrant({ grant, revoked_by });
  }
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
  const assignment =
    getConfiguredBayId() === getConfiguredClusterSeedBayId()
      ? await assignSiteLicensePoolSeatDirect({
          actor_account_id: actorAccountId,
          package_id: packageId,
          target_account_id: account_id,
          grant_expires_at: expiresAt,
        })
      : await seedSiteLicenseClient().assignSiteLicensePoolSeat({
          actor_account_id: actorAccountId,
          package_id: packageId,
          target_account_id: account_id,
          grant_expires_at: expiresAt,
        });
  await getPool().query(
    `
      INSERT INTO public_project_path_site_license_grants (
        public_project_path_id, assignment_id, package_id, target_account_id,
        actor_account_id, status, metadata
      )
      VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb)
      ON CONFLICT (public_project_path_id, assignment_id) DO UPDATE SET
        package_id=EXCLUDED.package_id,
        target_account_id=EXCLUDED.target_account_id,
        actor_account_id=EXCLUDED.actor_account_id,
        status='active',
        revoked_at=NULL,
        revoked_by=NULL,
        metadata=EXCLUDED.metadata
    `,
    [
      row.id,
      assignment.id,
      packageId,
      account_id,
      actorAccountId,
      JSON.stringify({
        slug: row.slug,
        grant_id: assignment.grant_id ?? null,
        expires_at: expiresAt.toISOString(),
      }),
    ],
  );
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

async function resolvePublicShareHostConnection({
  account_id,
  row,
}: {
  account_id: string;
  row: PublicDirectoryShareRow;
}): Promise<HostConnectionInfo | null> {
  const local = publicShareHostConnection(row);
  if (local?.ready) {
    return local;
  }
  if (!row.host_id) {
    return local;
  }
  const hostBay = await resolveHostBayAcrossCluster(row.host_id);
  if (!hostBay?.bay_id || hostBay.bay_id === getConfiguredBayId()) {
    return local;
  }
  try {
    return await getInterBayBridge()
      .hostConnection(hostBay.bay_id, { timeout_ms: 10_000 })
      .get({
        account_id,
        host_id: row.host_id,
        project_id: row.project_id,
        public_directory_share_id: row.id,
      });
  } catch (err) {
    log.warn("failed to resolve public share host connection across bays", {
      project_id: row.project_id,
      host_id: row.host_id,
      host_bay_id: hostBay.bay_id,
      err: `${(err as Error | undefined)?.message ?? err}`,
    });
    return local;
  }
}

async function resolveRow({
  account_id,
  slug,
}: ResolvePublicDirectoryShareOptions): Promise<ResolvedPublicDirectoryShareRow> {
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
  let projectTitle = row.project_title ?? null;
  let hostId = row.host_id ?? null;
  if (availabilityStatus !== "available") {
    const ownership = await resolveProjectBayAcrossCluster(row.project_id);
    if (ownership?.bay_id) {
      availabilityStatus = "available";
      availabilityMessage = null;
      owningBayId = ownership.bay_id;
    }
  }
  if (
    (!owningBayId || !hostId || !projectTitle) &&
    availabilityStatus === "available"
  ) {
    const ownership = await resolveProjectBayAcrossCluster(row.project_id);
    if (ownership?.bay_id) {
      try {
        const project = await getInterBayBridge()
          .projectReference(ownership.bay_id, { timeout_ms: 10_000 })
          .get({ account_id, project_id: row.project_id });
        if (project != null) {
          owningBayId = owningBayId ?? project.owning_bay_id;
          hostId = hostId ?? project.host_id;
          projectTitle = projectTitle ?? project.title;
        }
      } catch (err) {
        log.warn("failed to resolve public share project reference", {
          project_id: row.project_id,
          project_bay_id: ownership.bay_id,
          err: `${(err as Error | undefined)?.message ?? err}`,
        });
      }
    }
  }
  const rowWithProjectReference: PublicDirectoryShareRow = {
    ...row,
    host_id: hostId,
    owning_bay_id: owningBayId,
    project_title: projectTitle,
  };
  return {
    row,
    share: {
      ...summary,
      availability_status: availabilityStatus,
      availability_message: availabilityMessage,
      available: availabilityStatus === "available",
      read_policy: publicDirectoryShareReadPolicyForPath(summary.path),
      project_title: projectTitle,
      host_id: hostId,
      host_connection:
        availabilityStatus === "available"
          ? await resolvePublicShareHostConnection({
              account_id,
              row: rowWithProjectReference,
            })
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

function temporaryViewerGrantExpiresAt(): Date {
  return new Date(
    Date.now() + DEFAULT_TEMPORARY_VIEWER_GRANT_DAYS * 24 * 60 * 60 * 1000,
  );
}

function projectViewerUrl(share: ResolvedPublicDirectoryShare): string {
  const encodedPath =
    share.path === "."
      ? ""
      : `/${share.path.split("/").map(encodeURIComponent).join("/")}`;
  return `/projects/${share.project_id}/files${encodedPath}?viewer=1&share=${encodeURIComponent(share.id)}`;
}

async function revokeTemporaryViewerGrantsForShare({
  public_project_path_id,
  revoked_by,
  status = "revoked",
}: {
  public_project_path_id: string;
  revoked_by?: string | null;
  status?: "revoked" | "disabled";
}): Promise<void> {
  await getPool().query(
    `
      UPDATE public_project_path_viewer_grants
      SET status=$2,
          revoked_at=NOW(),
          revoked_by=$3
      WHERE public_project_path_id=$1
        AND status='active'
    `,
    [public_project_path_id, status, revoked_by ?? null],
  );
}

export async function grantTemporaryViewerAccess({
  account_id,
  slug,
}: GrantTemporaryViewerAccessOptions): Promise<GrantTemporaryViewerAccessResponse> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  const { share } = await resolveRow({ account_id, slug });
  if (!share.available) {
    throw Error(
      share.availability_message || "This shared directory is not available.",
    );
  }
  const expiresAt = temporaryViewerGrantExpiresAt();
  await getPool().query(
    `
      INSERT INTO public_project_path_viewer_grants (
        public_project_path_id, project_id, account_id, read_policy, status,
        grant_reason, expires_at, last_used_at, metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, 'active', 'share-url', $5, NOW(), $6::jsonb)
      ON CONFLICT (public_project_path_id, account_id) DO UPDATE SET
        project_id=EXCLUDED.project_id,
        read_policy=EXCLUDED.read_policy,
        status='active',
        expires_at=EXCLUDED.expires_at,
        last_used_at=NOW(),
        revoked_at=NULL,
        revoked_by=NULL,
        metadata=EXCLUDED.metadata
    `,
    [
      share.id,
      share.project_id,
      account_id,
      JSON.stringify(share.read_policy),
      expiresAt,
      JSON.stringify({ slug: share.slug }),
    ],
  );
  return {
    project_id: share.project_id,
    share_id: share.id,
    path: share.path,
    read_policy: share.read_policy,
    expires_at: expiresAt,
    project_url: projectViewerUrl(share),
    project_title: share.project_title,
    share_title: share.title,
    share_description: share.description,
    license: share.license,
    image: share.image,
    theme: share.theme,
    site_license_grant_on_copy: share.site_license_grant_on_copy,
    site_license_copy_requires_grant: share.site_license_copy_requires_grant,
    host_id: share.host_id,
    host_connection: share.host_connection,
    owning_bay_id: share.owning_bay_id,
  };
}

export async function getTemporaryViewerReadPolicy({
  account_id,
  project_id,
}: GetTemporaryViewerReadPolicyOptions): Promise<GetTemporaryViewerReadPolicyResponse> {
  await ensurePublicDirectorySharesSchema();
  if (!account_id) {
    throw Error("user must be signed in");
  }
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  const { rows } = await getPool().query<TemporaryViewerGrantRow>(
    `
      SELECT g.*
      FROM public_project_path_viewer_grants g
      JOIN public_project_paths p ON p.id=g.public_project_path_id
      WHERE g.project_id=$1
        AND g.account_id=$2
        AND g.status='active'
        AND g.expires_at > NOW()
        AND p.disabled IS FALSE
        AND p.visibility <> 'disabled'
        AND p.project_id=g.project_id
    `,
    [project_id, account_id],
  );
  const rules = rows.flatMap((row) =>
    Array.isArray(row.read_policy?.rules) ? row.read_policy.rules : [],
  );
  return {
    project_id,
    account_id,
    read_policy: rules.length > 0 ? { rules } : undefined,
  };
}

export async function authorizeRead({
  account_id,
  project_id,
  share_id,
}: AuthorizePublicDirectoryShareReadOptions): Promise<AuthorizePublicDirectoryShareReadResponse> {
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

export async function disableMineByActor({
  account_id,
  session_hash,
  actor_account_id,
}: DisableMyPublicDirectorySharesByActorOptions): Promise<DisableMyPublicDirectorySharesByActorResponse> {
  await ensurePublicDirectorySharesSchema();
  if (!account_id) {
    throw Error("user must be signed in");
  }
  if (!isValidUUID(actor_account_id)) {
    throw Error("invalid actor_account_id");
  }
  const cleanedSessionHash = `${session_hash ?? ""}`.trim();
  if (!cleanedSessionHash) {
    throw Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
  }
  await requireFreshAuthForSessionHash({
    account_id,
    session_hash: cleanedSessionHash,
  });
  const { rows } = await getPool().query<{ id: string }>(
    `
      SELECT pps.id
      FROM public_project_paths pps
      JOIN projects p ON p.project_id=pps.project_id
      WHERE COALESCE(p.users -> $1::text ->> 'group', '') IN ('owner', 'collaborator')
        AND pps.disabled IS FALSE
        AND pps.visibility <> 'disabled'
        AND (pps.created_by=$2::uuid OR pps.updated_by=$2::uuid)
      ORDER BY pps.updated_at DESC, pps.created_at DESC
    `,
    [account_id, actor_account_id],
  );
  const shareIds: string[] = [];
  for (const { id } of rows) {
    await update({
      account_id,
      id,
      disabled: true,
    });
    shareIds.push(id);
  }
  return {
    disabled_count: shareIds.length,
    share_ids: shareIds,
  };
}

export async function upsert(
  opts: UpsertPublicDirectoryShareOptions,
): Promise<PublicDirectoryShareSummary> {
  await assertAdmin(opts.account_id);
  await ensurePublicDirectorySharesSchema();
  return await savePublicDirectoryShare(opts);
}

export async function upsertMigratedLegacyPublicDirectoryShare(
  opts: UpsertPublicDirectoryShareOptions,
): Promise<PublicDirectoryShareSummary> {
  await ensurePublicDirectorySharesSchema();
  // Legacy migration replays shares only after the target project is explicitly
  // imported. Do not apply the owner UI limit or live filesystem existence
  // check here; the old public path may point at content that is still being
  // restored.
  return await savePublicDirectoryShare({
    ...opts,
    requires_auth: true,
    availability_status: opts.availability_status ?? "available",
  });
}

export async function repairMigratedLegacyPublicDirectoryShareSlug({
  id,
  legacy_public_path_id,
  slug,
  legacy_url,
  account_id,
}: {
  id?: string | null;
  legacy_public_path_id?: string | null;
  slug: string;
  legacy_url?: string | null;
  account_id?: string | null;
}): Promise<PublicDirectoryShareSummary | null> {
  await ensurePublicDirectorySharesSchema();
  const normalizedSlug = normalizePublicDirectoryShareSlug(slug);
  const { rows } = await getPool().query<PublicDirectoryShareRow>(
    `
      SELECT *
      FROM public_project_paths
      WHERE ($1::uuid IS NOT NULL AND id=$1::uuid)
         OR ($2::text IS NOT NULL AND legacy_public_path_id=$2::text)
      LIMIT 1
    `,
    [id && isValidUUID(id) ? id : null, legacy_public_path_id ?? null],
  );
  const current = rows[0];
  if (!current) return null;
  return await savePublicDirectoryShare({
    account_id: account_id ?? undefined,
    id: current.id,
    project_id: current.project_id,
    path: current.path,
    slug: normalizedSlug,
    visibility: current.visibility,
    requires_auth: current.requires_auth,
    availability_status: current.availability_status,
    availability_message: current.availability_message ?? null,
    title: current.title ?? null,
    description: current.description ?? null,
    license: current.license ?? null,
    image: current.image ?? null,
    redirect: current.redirect ?? null,
    site_license_id: current.site_license_id ?? null,
    site_license_pool_id: current.site_license_pool_id ?? null,
    site_license_membership_tier_id:
      current.site_license_membership_tier_id ?? null,
    site_license_duration_days: current.site_license_duration_days ?? null,
    site_license_grant_on_copy: current.site_license_grant_on_copy,
    site_license_copy_requires_grant: current.site_license_copy_requires_grant,
    metadata: current.metadata ?? {},
    legacy_public_path_id: current.legacy_public_path_id ?? null,
    legacy_url: legacy_url ?? current.legacy_url ?? null,
    last_edited: current.last_edited ?? null,
    disabled: current.disabled,
  });
}

export async function disableMigratedLegacyPublicDirectoryShare({
  legacy_public_path_id,
  account_id,
  reason = "legacy file-scoped public path disabled until exact file share replay is supported",
}: {
  legacy_public_path_id: string;
  account_id?: string | null;
  reason?: string;
}): Promise<boolean> {
  await ensurePublicDirectorySharesSchema();
  const { rows } = await getPool().query<{ project_id: string }>(
    `
    WITH target AS (
      SELECT id, project_id
        FROM public_project_paths
       WHERE legacy_public_path_id=$1
    ),
    updated_paths AS (
      UPDATE public_project_paths p
         SET disabled=TRUE,
             visibility='disabled',
             metadata=jsonb_set(
               COALESCE(p.metadata, '{}'::jsonb),
               '{legacy_migration_disabled_reason}',
               to_jsonb($2::text),
               true
             ),
             updated_at=NOW()
        FROM target
       WHERE p.id=target.id
       RETURNING p.id
    ),
    updated_slugs AS (
      UPDATE public_project_path_slugs s
         SET disabled=TRUE,
             updated_at=NOW()
        FROM target
       WHERE s.public_project_path_id=target.id
       RETURNING s.slug
    )
    SELECT DISTINCT project_id
      FROM target
    `,
    [legacy_public_path_id, reason],
  );
  for (const { project_id } of rows) {
    await syncPublicDirectoryShareProjectLabels({ project_id, account_id });
  }
  return rows.length > 0;
}

async function savePublicDirectoryShare(
  opts: UpsertPublicDirectoryShareOptions,
): Promise<PublicDirectoryShareSummary> {
  if (!isValidUUID(opts.project_id)) {
    throw Error("invalid project_id");
  }
  const slug = normalizePublicDirectoryShareSlug(opts.slug);
  const path = normalizePublicDirectorySharePath(opts.path);
  assertPublicDirectorySharePathAllowed(path);
  const visibility = normalizeVisibility(opts.visibility);
  const availabilityStatus = normalizeAvailability(opts.availability_status);
  const disabled = opts.disabled === true || visibility === "disabled";
  const id = opts.id && isValidUUID(opts.id) ? opts.id : undefined;
  const title = normalizeOptionalPublicShareText({
    field: "title",
    maxLength: MAX_PUBLIC_DIRECTORY_SHARE_TITLE_LENGTH,
    value: opts.title,
  });
  const description = normalizePublicShareDescription(opts.description);
  const license = normalizePublicShareLicense(opts.license);
  const image =
    normalizePublicShareThemeString({
      field: "image",
      value: opts.image ?? opts.theme?.image_blob,
      maxLength: 256,
    }) ?? null;
  const metadata = publicShareMetadataWithTheme({
    metadata: opts.metadata,
    theme: opts.theme,
  });
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
    title,
    description,
    license,
    image,
    opts.redirect ?? null,
    opts.site_license_id ?? null,
    opts.site_license_pool_id ?? null,
    opts.site_license_membership_tier_id ?? null,
    opts.site_license_duration_days ?? null,
    opts.site_license_grant_on_copy === true,
    opts.site_license_copy_requires_grant === true,
    JSON.stringify(metadata),
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
  if (row.disabled || row.visibility === "disabled") {
    await revokeTemporaryViewerGrantsForShare({
      public_project_path_id: row.id,
      revoked_by: opts.account_id ?? null,
      status: "disabled",
    });
    await revokeShareSiteLicenseGrants({
      public_project_path_id: row.id,
      revoked_by: opts.account_id ?? null,
    });
  }
  await syncPublicDirectoryShareProjectLabels({
    project_id: row.project_id,
    account_id: opts.account_id ?? null,
  });
  return rowToSummary(row);
}

export async function update(
  opts: UpdatePublicDirectoryShareOptions,
): Promise<PublicDirectoryShareSummary> {
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

  let siteLicenseGrant: SiteLicenseGrantConfig | null | undefined;
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
  } else if (opts.site_license_grant_on_copy === false) {
    siteLicenseGrant = null;
  }

  let disabled = current.disabled || current.visibility === "disabled";
  let visibility: PublicDirectoryShareVisibility = disabled
    ? "disabled"
    : current.visibility;
  let metadata = current.metadata ?? {};
  if (opts.disabled === true) {
    disabled = true;
    visibility = "disabled";
    metadata = metadataWithPreviousVisibility(current);
  } else if (opts.disabled === false) {
    disabled = false;
    visibility = previousVisibilityFromMetadata(current.metadata);
    metadata = metadataWithoutPreviousVisibility(current.metadata);
  }
  const preserveSiteLicenseGrant = siteLicenseGrant === undefined;
  return await savePublicDirectoryShare({
    account_id: opts.account_id,
    id: current.id,
    project_id: current.project_id,
    path: current.path,
    slug: opts.slug ?? current.slug,
    visibility,
    requires_auth: current.requires_auth,
    availability_status: current.availability_status,
    availability_message: current.availability_message ?? null,
    title: opts.title ?? current.title ?? null,
    description: opts.description ?? current.description ?? null,
    license: opts.license ?? current.license ?? null,
    image: opts.image ?? opts.theme?.image_blob ?? current.image ?? null,
    redirect: current.redirect ?? null,
    legacy_public_path_id: current.legacy_public_path_id ?? null,
    legacy_url: current.legacy_url ?? null,
    site_license_id: preserveSiteLicenseGrant
      ? (current.site_license_id ?? null)
      : (siteLicenseGrant?.site_license_id ?? null),
    site_license_pool_id: preserveSiteLicenseGrant
      ? (current.site_license_pool_id ?? null)
      : (siteLicenseGrant?.site_license_pool_id ?? null),
    site_license_membership_tier_id: preserveSiteLicenseGrant
      ? (current.site_license_membership_tier_id ?? null)
      : (siteLicenseGrant?.site_license_membership_tier_id ?? null),
    site_license_duration_days: preserveSiteLicenseGrant
      ? (current.site_license_duration_days ?? null)
      : (siteLicenseGrant?.duration_days ?? null),
    site_license_grant_on_copy: preserveSiteLicenseGrant
      ? current.site_license_grant_on_copy
      : siteLicenseGrant != null,
    site_license_copy_requires_grant: preserveSiteLicenseGrant
      ? current.site_license_copy_requires_grant
      : (siteLicenseGrant?.copy_requires_grant ?? false),
    metadata,
    theme: opts.theme,
    last_edited: current.last_edited ?? null,
    disabled,
  });
}

export async function create(
  opts: CreatePublicDirectoryShareOptions,
): Promise<PublicDirectoryShareSummary> {
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
  await assertCanCreatePublicDirectoryShare(opts.account_id);
  const slug = normalizePublicDirectoryShareSlug(opts.slug);
  const path = normalizePublicDirectorySharePath(opts.path);
  assertPublicDirectorySharePathAllowed(path);
  const fs = await getProjectFsClient({
    account_id: opts.account_id,
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
    title: normalizePublicShareTitle({
      fallback: defaultTitleForPath(path),
      value: opts.title,
    }),
    description: normalizePublicShareDescription(opts.description),
    license: normalizePublicShareLicense(opts.license),
    image: opts.image ?? opts.theme?.image_blob ?? null,
    theme: opts.theme,
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
  const copySource = await copySourceForPublicDirectoryShare({
    account_id,
    share,
    relativePath,
  });
  const op = await createLro({
    kind: "copy-path-between-projects",
    scope_type: "project",
    scope_id: destination_project_id,
    created_by: account_id,
    routing: "hub",
    input: {
      src: {
        ...copySource,
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
  let hostPlacementMessage: string | null = null;
  try {
    destinationProjectId = await createProject(createOpts);
  } catch (err) {
    if (!createOpts.host_id || !isHostPlacementFailure(err)) {
      throw err;
    }
    hostPlacementMessage = `${(err as Error).message ?? err}`;
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
    host_placement_message: hostPlacementMessage,
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
  const fs = await getProjectFsClient({
    account_id,
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

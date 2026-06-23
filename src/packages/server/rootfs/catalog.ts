/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
import {
  appendRootfsImageEvent,
  listRecentRootfsImageEvents,
} from "@cocalc/server/rootfs/events";
import { v4 } from "uuid";
import type {
  RootfsAdminCatalogEntry,
  RootfsAdminCatalogCounts,
  RootfsAdminCatalogPage,
  RootfsCatalogPageRequest,
  RootfsImageCatalogPage,
  PublishProjectRootfsArtifact,
  PublishProjectRootfsBody,
  RootfsCatalogSaveBody,
  RootfsDeleteBlockers,
  RootfsDeleteRequestResult,
  RootfsImageArch,
  RootfsImageEntry,
  RootfsImageManifest,
  RootfsImageSection,
  RootfsContentManifest,
  RootfsContentValidationWarning,
  RootfsReleaseArtifactBackend,
  RootfsReleaseArtifactFormat,
  RootfsImageTheme,
  RootfsStorageLocation,
  RootfsImageVisibility,
  RootfsImageWarning,
  RootfsReleaseGcStatus,
  RootfsScanSummary,
} from "@cocalc/util/rootfs-images";
import {
  BUILTIN_ROOTFS_IMAGES,
  DEFAULT_ROOTFS_CATALOG_URL,
  isManagedRootfsImageName,
  normalizeRootfsContentManifest,
  normalizeRootfsEntry,
  ROOTFS_IMAGE_MANIFEST_VERSION,
  validateRootfsSlug,
} from "@cocalc/util/rootfs-images";
import { assertCanCreateOrUpdateRootfs } from "@cocalc/server/membership/rootfs-limits";
import { ensureRootfsRusticRepoSchema } from "@cocalc/server/rootfs/rustic-repo-schema";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterRole,
  getConfiguredClusterSeedBayId,
} from "@cocalc/server/cluster-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { enqueueRootfsPrepullForRunningHosts } from "@cocalc/server/cloud/rootfs-prepull";

const logger = getLogger("server:rootfs:catalog");
const SEED_CATALOG_SYNC_TTL_MS = 60_000;

let seedCatalogSyncCheckedAt = 0;
let seedCatalogSyncPromise: Promise<void> | undefined;

type RootfsImageRow = {
  image_id: string;
  release_id: string | null;
  slug: string | null;
  owner_id: string | null;
  runtime_image: string;
  created: Date | null;
  updated: Date | null;
  label: string;
  family: string | null;
  version: string | null;
  channel: string | null;
  supersedes_image_id: string | null;
  description: string | null;
  default_jupyter_kernel: string | null;
  visibility: RootfsImageVisibility | null;
  official: boolean | null;
  prepull: boolean | null;
  hidden: boolean | null;
  blocked: boolean | null;
  blocked_reason: string | null;
  blocked_at: Date | null;
  blocked_by: string | null;
  deleted: boolean | null;
  deleted_reason: string | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  hidden_at: Date | null;
  hidden_by: string | null;
  arch: string | null;
  gpu: boolean | null;
  size_gb: number | null;
  tags: string[] | null;
  digest: string | null;
  content_key: string | null;
  deprecated: boolean | null;
  deprecated_reason: string | null;
  theme: RootfsImageTheme | null;
  content: RootfsContentManifest | null;
  content_warnings: RootfsContentValidationWarning[] | null;
  owner_first_name: string | null;
  owner_last_name: string | null;
  release_gc_status: RootfsReleaseGcStatus | null;
  scan_status: string | null;
  scan_tool: string | null;
  scanned_at: Date | null;
  scan_summary: RootfsScanSummary | null;
  artifact_backend: RootfsReleaseArtifactBackend | null;
  artifact_format: RootfsReleaseArtifactFormat | null;
  artifact_path: string | null;
  repo_id: string | null;
};

type RootfsCatalogQueryResult = {
  rows: RootfsImageRow[];
  total: number;
  counts: RootfsAdminCatalogCounts;
  limit: number;
  offset: number;
};

type RootfsReplicaStorageRow = {
  release_id: string;
  backend: RootfsReleaseArtifactBackend;
  region: string | null;
  bucket_name: string | null;
  bucket_purpose: string | null;
  artifact_format: RootfsReleaseArtifactFormat;
  artifact_path: string;
  repo_id: string | null;
  status: string;
};

type RootfsRusticArtifactPath = {
  artifact_backend: RootfsReleaseArtifactBackend;
  region?: string;
  snapshot_id: string;
  repo_id?: string;
};

type RootfsLifecycleSnapshot = {
  image_id: string;
  release_id: string | null;
  slug: string | null;
  owner_id: string | null;
  hidden: boolean | null;
  blocked: boolean | null;
  blocked_reason: string | null;
  deleted: boolean | null;
};

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v.length > 0 ? v : undefined;
}

function generateRootfsSlugCandidate(): string {
  return `rfs-${v4().replace(/-/g, "").slice(0, 12)}`;
}

async function generateUniqueRootfsSlug(): Promise<string> {
  const pool = getPool("medium");
  for (let i = 0; i < 10; i += 1) {
    const slug = generateRootfsSlugCandidate();
    const { rows } = await pool.query<{ slug: string }>(
      `SELECT slug FROM rootfs_images WHERE slug=$1 LIMIT 1`,
      [slug],
    );
    if (rows.length === 0) return slug;
  }
  throw Error("failed to generate a unique rootfs slug");
}

function normalizeTags(tags?: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(
    new Set(tags.map((tag) => trimString(tag)).filter(Boolean) as string[]),
  );
}

function normalizeTheme(theme?: unknown): RootfsImageTheme | null {
  if (theme == null || typeof theme !== "object") return null;
  const value = theme as Record<string, unknown>;
  return {
    title: trimString(value.title),
    description: trimString(value.description),
    color: trimString(value.color) ?? null,
    accent_color: trimString(value.accent_color) ?? null,
    icon: trimString(value.icon) ?? null,
    image_blob: trimString(value.image_blob) ?? null,
  };
}

function normalizeStoredContent(
  content?: unknown,
): RootfsContentManifest | undefined {
  return normalizeRootfsContentManifest(content).content;
}

function normalizeStoredContentWarnings(
  warnings?: unknown,
): RootfsContentValidationWarning[] | undefined {
  if (!Array.isArray(warnings)) return undefined;
  const normalized = warnings
    .map((item) => {
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        return undefined;
      }
      const value = item as Record<string, unknown>;
      const code = trimString(value.code);
      const message = trimString(value.message);
      if (!code || !message) return undefined;
      return {
        code,
        message,
        path: trimString(value.path),
      };
    })
    .filter(Boolean) as RootfsContentValidationWarning[];
  return normalized.length ? normalized : undefined;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeArch(value?: unknown): string {
  if (Array.isArray(value)) {
    return trimString(value[0]) ?? "any";
  }
  return trimString(value) ?? "any";
}

function normalizeEntryArch(value?: RootfsImageEntry["arch"]): string {
  if (Array.isArray(value)) {
    return normalizeArch(value[0]);
  }
  return normalizeArch(value);
}

function fullName(row: RootfsImageRow): string | undefined {
  const first = trimString(row.owner_first_name);
  const last = trimString(row.owner_last_name);
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name || undefined;
}

function decodeRusticArtifactPath(
  artifact_path?: string | null,
): RootfsRusticArtifactPath | null {
  const parts = `${artifact_path ?? ""}`.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (parts.length !== 4 || parts[0] !== "rustic") {
    return null;
  }
  const [_, artifact_backend, region, snapshot_id] = parts;
  if (artifact_backend === "v2") {
    if (!region || !snapshot_id) return null;
    return {
      artifact_backend: "r2",
      repo_id: region,
      snapshot_id,
    };
  }
  if (!artifact_backend || !snapshot_id) {
    return null;
  }
  return {
    artifact_backend: artifact_backend as RootfsReleaseArtifactBackend,
    region: region === "site" ? undefined : region,
    snapshot_id,
  };
}

function rootfsStorageRepoSelector({
  backend,
  artifact_format,
  artifact_path,
  region,
}: {
  backend: RootfsReleaseArtifactBackend;
  artifact_format: RootfsReleaseArtifactFormat;
  artifact_path?: string | null;
  region?: string | null;
}): string | undefined {
  if (artifact_format !== "rustic") return;
  const rustic =
    decodeRusticArtifactPath(artifact_path) ??
    (region || backend === "rest"
      ? {
          artifact_backend: backend,
          region: region ?? undefined,
          snapshot_id: "",
        }
      : null);
  if (!rustic) return;
  if (rustic.artifact_backend === "rest") {
    return "rest:rootfs-images";
  }
  if (rustic.artifact_backend === "r2") {
    if (rustic.repo_id) {
      return `r2:rootfs-images:${rustic.repo_id}`;
    }
    return `r2:rootfs-images:${rustic.region ?? "site"}`;
  }
  return `${rustic.artifact_backend}:rootfs-images`;
}

function primaryStorageLocation(row: RootfsImageRow): RootfsStorageLocation[] {
  if (
    !row.release_id ||
    !row.artifact_backend ||
    !row.artifact_format ||
    !row.artifact_path
  ) {
    return [];
  }
  const rustic = decodeRusticArtifactPath(row.artifact_path);
  return [
    {
      role: "primary",
      backend: row.artifact_backend,
      artifact_format: row.artifact_format,
      artifact_path: row.artifact_path,
      repo_selector: rootfsStorageRepoSelector({
        backend: row.artifact_backend,
        artifact_format: row.artifact_format,
        artifact_path: row.artifact_path,
        region: rustic?.region,
      }),
      repo_id: row.repo_id ?? rustic?.repo_id,
      region: rustic?.region,
    },
  ];
}

function replicaStorageLocation(
  row: RootfsReplicaStorageRow,
): RootfsStorageLocation {
  const rustic = decodeRusticArtifactPath(row.artifact_path);
  return {
    role: "replica",
    backend: row.backend,
    artifact_format: row.artifact_format,
    artifact_path: row.artifact_path,
    repo_selector: rootfsStorageRepoSelector({
      backend: row.backend,
      artifact_format: row.artifact_format,
      artifact_path: row.artifact_path,
      region: row.region ?? rustic?.region,
    }),
    repo_id: row.repo_id ?? rustic?.repo_id,
    region: row.region ?? rustic?.region,
    bucket_name: row.bucket_name ?? undefined,
    bucket_purpose: row.bucket_purpose ?? undefined,
    status: row.status,
  };
}

function sectionFor({
  row,
  account_id,
  collaboratorIds,
}: {
  row: RootfsImageRow;
  account_id?: string;
  collaboratorIds: Set<string>;
}): RootfsImageSection | undefined {
  if (row.hidden) return undefined;
  if (row.blocked) return undefined;
  if (row.deleted) return undefined;
  if (row.official) return "official";
  if (account_id && row.owner_id === account_id) return "mine";
  if (
    row.visibility === "collaborators" &&
    row.owner_id &&
    collaboratorIds.has(row.owner_id)
  ) {
    return "collaborators";
  }
  if (row.visibility === "public") return "public";
}

function warningFor(section?: RootfsImageSection): RootfsImageWarning {
  switch (section) {
    case "collaborators":
      return "collaborator";
    case "public":
      return "public";
    default:
      return "none";
  }
}

function rowToEntry({
  row,
  account_id,
  collaboratorIds,
  admin,
}: {
  row: RootfsImageRow;
  account_id?: string;
  collaboratorIds: Set<string>;
  admin: boolean;
}): RootfsImageEntry | undefined {
  if (isManagedRootfsImageName(row.runtime_image) && !row.release_id) {
    return undefined;
  }
  const section = sectionFor({ row, account_id, collaboratorIds });
  if (!section) return undefined;
  return normalizeRootfsEntry(
    {
      id: row.image_id,
      release_id: row.release_id ?? undefined,
      slug: row.slug ?? undefined,
      label: row.label || row.runtime_image,
      image: row.runtime_image,
      created: row.created?.toISOString(),
      family: row.family ?? undefined,
      version: row.version ?? undefined,
      channel: row.channel ?? undefined,
      supersedes_image_id: row.supersedes_image_id ?? undefined,
      description: row.description ?? undefined,
      default_jupyter_kernel: row.default_jupyter_kernel ?? undefined,
      digest: row.digest ?? undefined,
      arch: row.arch ? [row.arch as any] : undefined,
      gpu: row.gpu ?? undefined,
      size_gb: row.size_gb ?? undefined,
      tags: row.tags ?? undefined,
      prepull: row.prepull ?? undefined,
      deprecated: row.deprecated ?? undefined,
      deprecated_reason: row.deprecated_reason ?? undefined,
      visibility: row.visibility ?? "public",
      official: row.official ?? false,
      hidden: row.hidden ?? false,
      blocked: row.blocked ?? false,
      blocked_reason: row.blocked_reason ?? undefined,
      owner_id: row.owner_id ?? undefined,
      owner_name: fullName(row),
      section,
      warning: warningFor(section),
      theme: row.theme ?? undefined,
      content: normalizeStoredContent(row.content),
      scan:
        row.scan_status || row.scan_tool || row.scanned_at || row.scan_summary
          ? {
              ...(row.scan_summary ?? {}),
              status: (row.scan_status as any) ?? row.scan_summary?.status,
              tool: row.scan_tool ?? row.scan_summary?.tool,
              scanned_at:
                row.scanned_at?.toISOString() ?? row.scan_summary?.scanned_at,
            }
          : undefined,
      can_manage:
        admin ||
        (!!account_id && !!row.owner_id && row.owner_id === account_id),
    },
    DEFAULT_ROOTFS_CATALOG_URL,
  );
}

function rowToAdminEntry({
  row,
  account_id,
  admin,
}: {
  row: RootfsImageRow;
  account_id?: string;
  admin: boolean;
}): RootfsAdminCatalogEntry {
  return {
    ...normalizeRootfsEntry(
      {
        id: row.image_id,
        release_id: row.release_id ?? undefined,
        slug: row.slug ?? undefined,
        label: row.label || row.runtime_image,
        image: row.runtime_image,
        created: row.created?.toISOString(),
        family: row.family ?? undefined,
        version: row.version ?? undefined,
        channel: row.channel ?? undefined,
        supersedes_image_id: row.supersedes_image_id ?? undefined,
        description: row.description ?? undefined,
        default_jupyter_kernel: row.default_jupyter_kernel ?? undefined,
        digest: row.digest ?? undefined,
        arch: row.arch ? [row.arch as any] : undefined,
        gpu: row.gpu ?? undefined,
        size_gb: row.size_gb ?? undefined,
        tags: row.tags ?? undefined,
        prepull: row.prepull ?? undefined,
        deprecated: row.deprecated ?? undefined,
        deprecated_reason: row.deprecated_reason ?? undefined,
        visibility: row.visibility ?? "public",
        official: row.official ?? false,
        hidden: row.hidden ?? false,
        blocked: row.blocked ?? false,
        blocked_reason: row.blocked_reason ?? undefined,
        owner_id: row.owner_id ?? undefined,
        owner_name: fullName(row),
        warning: "none",
        theme: row.theme ?? undefined,
        content: normalizeStoredContent(row.content),
        scan:
          row.scan_status || row.scan_tool || row.scanned_at || row.scan_summary
            ? {
                ...(row.scan_summary ?? {}),
                status: (row.scan_status as any) ?? row.scan_summary?.status,
                tool: row.scan_tool ?? row.scan_summary?.tool,
                scanned_at:
                  row.scanned_at?.toISOString() ?? row.scan_summary?.scanned_at,
              }
            : undefined,
        can_manage:
          admin ||
          (!!account_id && !!row.owner_id && row.owner_id === account_id),
      },
      DEFAULT_ROOTFS_CATALOG_URL,
    ),
    deleted: row.deleted ?? false,
    deleted_reason: row.deleted_reason ?? undefined,
    hidden_at: row.hidden_at?.toISOString(),
    hidden_by: row.hidden_by ?? undefined,
    blocked_at: row.blocked_at?.toISOString(),
    blocked_by: row.blocked_by ?? undefined,
    deleted_at: row.deleted_at?.toISOString(),
    deleted_by: row.deleted_by ?? undefined,
    release_gc_status: row.release_gc_status ?? undefined,
    scan_status: (row.scan_status as any) ?? undefined,
    scan_tool: row.scan_tool ?? undefined,
    scanned_at: row.scanned_at?.toISOString(),
    storage_locations: primaryStorageLocation(row),
    content_warnings: normalizeStoredContentWarnings(row.content_warnings),
  };
}

async function collaboratorIdsFor(account_id?: string): Promise<Set<string>> {
  if (!account_id) return new Set<string>();
  const pool = getPool("medium");
  const { rows } = await pool.query<{ jsonb_object_keys?: string }>(
    "SELECT DISTINCT jsonb_object_keys(users) FROM projects WHERE users ? $1::TEXT",
    [account_id],
  );
  return new Set(
    rows
      .map((row) => row.jsonb_object_keys)
      .filter((value): value is string => typeof value === "string"),
  );
}

export async function ensureBuiltinRootfsImages(): Promise<void> {
  const pool = getPool("medium");
  for (const entry of BUILTIN_ROOTFS_IMAGES) {
    await pool.query(
      `INSERT INTO rootfs_images
      (image_id, release_id, owner_id, runtime_image, label, description, visibility, official, prepull, hidden, hidden_at, hidden_by, blocked, blocked_reason, blocked_at, blocked_by, deleted, deleted_reason, deleted_at, deleted_by, arch, gpu, size_gb, tags, digest, content_key, deprecated, deprecated_reason, theme, created, updated)
      VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, false, NULL, NULL, false, NULL, NULL, NULL, false, NULL, NULL, NULL, $8, $9, $10, $11::TEXT[], $12, $13, $14, $15, $16::JSONB, NOW(), NOW())
      ON CONFLICT (image_id) DO NOTHING`,
      [
        entry.id,
        entry.image,
        entry.label,
        entry.description ?? null,
        entry.visibility ?? "public",
        entry.official ?? false,
        entry.prepull ?? false,
        Array.isArray(entry.arch) ? entry.arch[0] : (entry.arch ?? "any"),
        entry.gpu ?? false,
        entry.size_gb ?? null,
        entry.tags ?? [],
        entry.digest ?? null,
        null,
        entry.deprecated ?? false,
        entry.deprecated_reason ?? null,
        entry.theme ? JSON.stringify(entry.theme) : null,
      ],
    );
  }
}

const ROOTFS_CATALOG_DEFAULT_LIMIT = 50;
const ROOTFS_CATALOG_MAX_LIMIT = 200;

function normalizeCatalogLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return ROOTFS_CATALOG_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(ROOTFS_CATALOG_MAX_LIMIT, Math.floor(limit)));
}

function encodeRootfsCatalogCursor(offset: number): string | undefined {
  if (offset <= 0) return undefined;
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeRootfsCatalogCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { offset?: unknown };
    return typeof decoded.offset === "number" &&
      Number.isFinite(decoded.offset) &&
      decoded.offset > 0
      ? Math.floor(decoded.offset)
      : 0;
  } catch {
    return 0;
  }
}

function rootfsCatalogOrderBy(opts: RootfsCatalogPageRequest): string {
  const direction = opts.direction === "asc" ? "ASC" : "DESC";
  switch (opts.sort) {
    case "created":
      return `r.created ${direction} NULLS LAST, r.image_id ASC`;
    case "label":
      return `lower(r.label) ${direction}, r.image_id ASC`;
    case "family":
      return `lower(COALESCE(r.family, '')) ${direction}, lower(r.label) ASC, r.image_id ASC`;
    case "visibility":
      return `r.visibility ${direction} NULLS LAST, lower(r.label) ASC, r.image_id ASC`;
    case "official":
      return `COALESCE(r.official, false) ${direction}, lower(r.label) ASC, r.image_id ASC`;
    case "scan_status":
      return `rel.scan_status ${direction} NULLS LAST, lower(r.label) ASC, r.image_id ASC`;
    case "storage_status":
      return `rel.gc_status ${direction} NULLS LAST, lower(r.label) ASC, r.image_id ASC`;
    case "owner":
      return `lower(COALESCE(a.last_name, '') || ' ' || COALESCE(a.first_name, '') || ' ' || COALESCE(r.owner_id::TEXT, '')) ${direction}, lower(r.label) ASC, r.image_id ASC`;
    case "usage_count":
      return `COALESCE(project_refs.project_count, 0) ${direction}, lower(r.label) ASC, r.image_id ASC`;
    case "updated":
    default:
      return `COALESCE(r.updated, r.created) ${direction} NULLS LAST, r.official DESC, lower(r.label) ASC, r.image_id ASC`;
  }
}

function rootfsCatalogBaseSelect(): string {
  return `FROM rootfs_images AS r
    LEFT JOIN accounts AS a ON a.account_id = r.owner_id
    LEFT JOIN rootfs_releases AS rel ON rel.release_id = r.release_id
    LEFT JOIN (
      SELECT rootfs_image_id AS image_id, COUNT(*)::INTEGER AS project_count
      FROM projects
      WHERE rootfs_image_id IS NOT NULL
      GROUP BY rootfs_image_id
    ) AS project_refs ON project_refs.image_id = r.image_id`;
}

function addRootfsCatalogFilters({
  opts,
  values,
  where,
}: {
  opts: RootfsCatalogPageRequest;
  values: unknown[];
  where: string[];
}) {
  const filters = opts.filters ?? {};
  const addValue = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const query = trimString(opts.query);
  if (query) {
    const p = addValue(`%${query}%`);
    where.push(`(
      r.image_id ILIKE ${p} OR
      r.release_id ILIKE ${p} OR
      COALESCE(r.slug, '') ILIKE ${p} OR
      r.runtime_image ILIKE ${p} OR
      r.label ILIKE ${p} OR
      COALESCE(r.family, '') ILIKE ${p} OR
      COALESCE(r.version, '') ILIKE ${p} OR
      COALESCE(r.channel, '') ILIKE ${p} OR
      COALESCE(r.description, '') ILIKE ${p} OR
      COALESCE(r.digest, '') ILIKE ${p} OR
      COALESCE(r.visibility, '') ILIKE ${p} OR
      COALESCE(r.owner_id::TEXT, '') ILIKE ${p} OR
      COALESCE(r.content->>'title', '') ILIKE ${p} OR
      COALESCE(r.content->>'subtitle', '') ILIKE ${p} OR
      COALESCE(r.content->>'description', '') ILIKE ${p} OR
      COALESCE(a.first_name, '') ILIKE ${p} OR
      COALESCE(a.last_name, '') ILIKE ${p} OR
      COALESCE(array_to_string(r.tags, ' '), '') ILIKE ${p} OR
      COALESCE(rel.scan_status, '') ILIKE ${p} OR
      COALESCE(rel.artifact_path, '') ILIKE ${p} OR
      COALESCE(rel.repo_id::TEXT, '') ILIKE ${p}
    )`);
  }
  const booleanFilters: Array<
    [keyof NonNullable<RootfsCatalogPageRequest["filters"]>, string]
  > = [
    ["official", "r.official"],
    ["prepull", "r.prepull"],
    ["hidden", "r.hidden"],
    ["blocked", "r.blocked"],
    ["deleted", "r.deleted"],
    ["gpu", "r.gpu"],
  ];
  for (const [key, column] of booleanFilters) {
    if (typeof filters[key] === "boolean") {
      where.push(`COALESCE(${column}, false) = ${addValue(filters[key])}`);
    }
  }
  if (filters.visibility) {
    where.push(`r.visibility = ${addValue(filters.visibility)}`);
  }
  if (filters.scan_status) {
    where.push(`rel.scan_status = ${addValue(filters.scan_status)}`);
  }
  if (filters.release_gc_status) {
    where.push(`rel.gc_status = ${addValue(filters.release_gc_status)}`);
  }
  if (filters.owner_id) {
    where.push(`r.owner_id = ${addValue(filters.owner_id)}`);
  }
  if (filters.family) {
    where.push(`r.family = ${addValue(filters.family)}`);
  }
  if (filters.channel) {
    where.push(`r.channel = ${addValue(filters.channel)}`);
  }
  const imageIds = Array.from(
    new Set(
      (filters.image_ids ?? [])
        .map((id) => `${id ?? ""}`.trim())
        .filter(Boolean),
    ),
  );
  if (imageIds.length > 0) {
    where.push(`r.image_id = ANY(${addValue(imageIds)}::TEXT[])`);
  }
}

async function queryRootfsCatalogRows(
  opts: RootfsCatalogPageRequest & {
    all?: boolean;
    visibleFor?: {
      account_id?: string;
      collaboratorIds: Set<string>;
    };
  } = {},
): Promise<RootfsCatalogQueryResult> {
  await ensureRootfsRusticRepoSchema();
  const pool = getPool("medium");
  const values: unknown[] = [];
  const where: string[] = [];
  if (opts.visibleFor) {
    const addValue = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    where.push("COALESCE(r.hidden, false) = false");
    where.push("COALESCE(r.blocked, false) = false");
    where.push("COALESCE(r.deleted, false) = false");
    const visible: string[] = [
      "COALESCE(r.official, false) = true",
      "r.visibility = 'public'",
    ];
    if (opts.visibleFor.account_id) {
      visible.push(`r.owner_id = ${addValue(opts.visibleFor.account_id)}`);
    }
    const collaboratorIds = Array.from(opts.visibleFor.collaboratorIds);
    if (collaboratorIds.length > 0) {
      visible.push(
        `(r.visibility = 'collaborators' AND r.owner_id = ANY(${addValue(
          collaboratorIds,
        )}::UUID[]))`,
      );
    }
    where.push(`(${visible.join(" OR ")})`);
  }
  addRootfsCatalogFilters({ opts, values, where });
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = rootfsCatalogOrderBy(opts);
  const limit = normalizeCatalogLimit(opts.limit);
  const offset = opts.all
    ? 0
    : typeof opts.offset === "number" &&
        Number.isFinite(opts.offset) &&
        opts.offset > 0
      ? Math.floor(opts.offset)
      : decodeRootfsCatalogCursor(opts.cursor);
  const pageValues = values.slice();
  const pageSql = opts.all
    ? ""
    : `LIMIT $${pageValues.length + 1} OFFSET $${pageValues.length + 2}`;
  if (!opts.all) {
    pageValues.push(limit, offset);
  }
  const { rows } = await pool.query<RootfsImageRow>(
    `SELECT
      r.image_id,
      r.release_id,
      r.slug,
      r.owner_id,
      r.runtime_image,
      r.created,
      r.updated,
      r.label,
      r.family,
      r.version,
      r.channel,
      r.supersedes_image_id,
      r.description,
      r.default_jupyter_kernel,
      r.visibility,
      r.official,
      r.prepull,
      r.hidden,
      r.hidden_at,
      r.hidden_by,
      r.blocked,
      r.blocked_reason,
      r.blocked_at,
      r.blocked_by,
      r.deleted,
      r.deleted_reason,
      r.deleted_at,
      r.deleted_by,
      r.arch,
      r.gpu,
      r.size_gb,
      r.tags,
      r.digest,
      r.content_key,
      r.deprecated,
      r.deprecated_reason,
      r.theme,
      r.content,
      r.content_warnings,
      a.first_name AS owner_first_name,
      a.last_name AS owner_last_name,
      rel.gc_status AS release_gc_status,
      rel.scan_status,
      rel.scan_tool,
      rel.scanned_at,
      rel.scan_summary,
      rel.artifact_backend,
      rel.artifact_format,
      rel.artifact_path,
      rel.repo_id
    ${rootfsCatalogBaseSelect()}
    ${whereSql}
    ORDER BY ${orderSql}
    ${pageSql}`,
    pageValues,
  );
  const countResult = await pool.query<RootfsAdminCatalogCounts>(
    `SELECT
      COUNT(*)::INTEGER AS total,
      COUNT(*) FILTER (WHERE COALESCE(r.deleted, false))::INTEGER AS deleted,
      COUNT(*) FILTER (WHERE rel.gc_status = 'pending_delete')::INTEGER AS pending_delete,
      COUNT(*) FILTER (WHERE COALESCE(r.blocked, false) OR rel.gc_status = 'blocked')::INTEGER AS blocked,
      COUNT(*) FILTER (
        WHERE COALESCE(r.official, false)
          AND COALESCE(r.deleted, false) = false
          AND (rel.scan_status IS NULL OR rel.scan_status = 'unknown')
      )::INTEGER AS official_unscanned,
      COUNT(*) FILTER (
        WHERE COALESCE(r.official, false)
          AND COALESCE(r.deleted, false) = false
          AND COALESCE((rel.scan_summary->'severity_counts'->>'critical')::INTEGER, 0) > 0
      )::INTEGER AS official_critical,
      COUNT(*) FILTER (
        WHERE COALESCE(r.official, false)
          AND COALESCE(r.deleted, false) = false
          AND rel.scan_status = 'error'
      )::INTEGER AS official_scan_failed
    ${rootfsCatalogBaseSelect()}
    ${whereSql}`,
    values,
  );
  const counts = countResult.rows[0] ?? {
    total: rows.length,
    deleted: 0,
    pending_delete: 0,
    blocked: 0,
    official_unscanned: 0,
    official_critical: 0,
    official_scan_failed: 0,
  };
  return {
    rows,
    total: counts.total,
    counts,
    limit: opts.all ? rows.length : limit,
    offset,
  };
}

async function queryRootfsRows(): Promise<RootfsImageRow[]> {
  const result = await queryRootfsCatalogRows({ all: true });
  return result.rows;
}

function shouldSyncSeedCatalogEntry(entry: RootfsImageEntry): boolean {
  return (
    !!trimString(entry.release_id) &&
    (entry.official === true || entry.prepull === true) &&
    entry.hidden !== true &&
    entry.blocked !== true
  );
}

async function upsertSeedCatalogEntry(entry: RootfsImageEntry): Promise<void> {
  const pool = getPool("medium");
  const contentResult = normalizeRootfsContentManifest(entry.content);
  const slug = validateRootfsSlug(entry.slug);
  await pool.query(
    `INSERT INTO rootfs_images
      (image_id, release_id, owner_id, runtime_image, label, family, version, channel, supersedes_image_id, description, default_jupyter_kernel, visibility, official, prepull, hidden, hidden_at, hidden_by, blocked, blocked_reason, blocked_at, blocked_by, deleted, deleted_reason, deleted_at, deleted_by, arch, gpu, size_gb, tags, digest, content_key, deprecated, deprecated_reason, slug, theme, content, content_warnings, created, updated)
      VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, NULL, NULL, false, NULL, NULL, NULL, false, NULL, NULL, NULL, $14, $15, $16, $17::TEXT[], $18, NULL, $19, $20, $21, $22::JSONB, $23::JSONB, $24::JSONB, COALESCE($25::TIMESTAMP, NOW()), NOW())
      ON CONFLICT (image_id) DO UPDATE SET
        release_id=EXCLUDED.release_id,
        runtime_image=EXCLUDED.runtime_image,
        label=EXCLUDED.label,
        family=EXCLUDED.family,
        version=EXCLUDED.version,
        channel=EXCLUDED.channel,
        supersedes_image_id=EXCLUDED.supersedes_image_id,
        description=EXCLUDED.description,
        default_jupyter_kernel=EXCLUDED.default_jupyter_kernel,
        visibility=EXCLUDED.visibility,
        official=EXCLUDED.official,
        prepull=EXCLUDED.prepull,
        arch=EXCLUDED.arch,
        gpu=EXCLUDED.gpu,
        size_gb=EXCLUDED.size_gb,
        tags=EXCLUDED.tags,
        digest=EXCLUDED.digest,
        deprecated=EXCLUDED.deprecated,
        deprecated_reason=EXCLUDED.deprecated_reason,
        slug=COALESCE(EXCLUDED.slug, rootfs_images.slug),
        theme=EXCLUDED.theme,
        content=EXCLUDED.content,
        content_warnings=EXCLUDED.content_warnings,
        updated=NOW()
      WHERE rootfs_images.owner_id IS NULL OR COALESCE(rootfs_images.official, false)=true`,
    [
      entry.id,
      trimString(entry.release_id)!,
      entry.image,
      entry.label || entry.image,
      trimString(entry.family) ?? null,
      trimString(entry.version) ?? null,
      trimString(entry.channel) ?? null,
      trimString(entry.supersedes_image_id) ?? null,
      trimString(entry.description) ?? null,
      trimString(entry.default_jupyter_kernel) ?? null,
      entry.visibility ?? "public",
      entry.official === true,
      entry.prepull === true,
      normalizeEntryArch(entry.arch),
      entry.gpu === true,
      entry.size_gb ?? null,
      normalizeTags(entry.tags),
      trimString(entry.digest) ?? null,
      entry.deprecated === true,
      trimString(entry.deprecated_reason) ?? null,
      slug ?? null,
      entry.theme ? JSON.stringify(normalizeTheme(entry.theme)) : null,
      contentResult.content ? JSON.stringify(contentResult.content) : null,
      contentResult.warnings.length
        ? JSON.stringify(contentResult.warnings)
        : null,
      trimString(entry.created) ?? null,
    ],
  );
}

async function syncOfficialRootfsCatalogFromSeed(): Promise<void> {
  const role = getConfiguredClusterRole();
  if (role !== "attached") {
    return;
  }
  const seedBayId = getConfiguredClusterSeedBayId();
  if (!seedBayId || seedBayId === getConfiguredBayId()) {
    return;
  }
  const now = Date.now();
  if (now - seedCatalogSyncCheckedAt < SEED_CATALOG_SYNC_TTL_MS) {
    return;
  }
  seedCatalogSyncPromise ??= (async () => {
    try {
      const manifest = await getInterBayBridge()
        .bayOps(seedBayId, { timeout_ms: 15_000 })
        .getRootfsCatalog({});
      const entries = manifest.images.filter(shouldSyncSeedCatalogEntry);
      for (const entry of entries) {
        await upsertSeedCatalogEntry(entry);
      }
      seedCatalogSyncCheckedAt = Date.now();
    } catch (err) {
      seedCatalogSyncCheckedAt = Date.now();
      logger.warn("unable to sync RootFS catalog from seed bay", {
        seed_bay_id: seedBayId,
        err: `${err}`,
      });
    } finally {
      seedCatalogSyncPromise = undefined;
    }
  })();
  await seedCatalogSyncPromise;
}

async function queryReplicaStorageRows(
  release_ids: string[],
): Promise<Map<string, RootfsStorageLocation[]>> {
  if (!release_ids.length) {
    return new Map();
  }
  await ensureRootfsRusticRepoSchema();
  const pool = getPool("medium");
  const { rows } = await pool.query<RootfsReplicaStorageRow>(
    `SELECT
      release_id::TEXT AS release_id,
      backend,
      region,
      bucket_name,
      bucket_purpose,
      artifact_format,
      artifact_path,
      repo_id,
      status
    FROM rootfs_release_artifacts
    WHERE release_id::TEXT = ANY($1::TEXT[])
      AND COALESCE(status, 'ready') <> 'deleted'
    ORDER BY created ASC, artifact_id ASC`,
    [release_ids],
  );
  const byReleaseId = new Map<string, RootfsStorageLocation[]>();
  for (const row of rows) {
    const locations = byReleaseId.get(row.release_id) ?? [];
    locations.push(replicaStorageLocation(row));
    byReleaseId.set(row.release_id, locations);
  }
  return byReleaseId;
}

export async function listVisibleRootfsImages(
  account_id?: string,
  opts: { includeSeedCatalog?: boolean } = {},
): Promise<RootfsImageManifest> {
  await ensureBuiltinRootfsImages();
  if (opts.includeSeedCatalog !== false) {
    await syncOfficialRootfsCatalogFromSeed();
  }
  const [rows, collaboratorIds, admin] = await Promise.all([
    queryRootfsRows(),
    collaboratorIdsFor(account_id),
    account_id ? isAdmin(account_id) : Promise.resolve(false),
  ]);
  const images = rows
    .map((row) => rowToEntry({ row, account_id, collaboratorIds, admin }))
    .filter((entry): entry is RootfsImageEntry => !!entry);
  return {
    version: ROOTFS_IMAGE_MANIFEST_VERSION,
    generated_at: new Date().toISOString(),
    source: DEFAULT_ROOTFS_CATALOG_URL,
    images,
  };
}

export async function listVisibleRootfsImagesPage(
  account_id?: string,
  opts: RootfsCatalogPageRequest & { includeSeedCatalog?: boolean } = {},
): Promise<RootfsImageCatalogPage> {
  await ensureBuiltinRootfsImages();
  if (opts.includeSeedCatalog !== false) {
    await syncOfficialRootfsCatalogFromSeed();
  }
  const [collaboratorIds, admin] = await Promise.all([
    collaboratorIdsFor(account_id),
    account_id ? isAdmin(account_id) : Promise.resolve(false),
  ]);
  const result = await queryRootfsCatalogRows({
    ...opts,
    visibleFor: { account_id, collaboratorIds },
  });
  const images = result.rows
    .map((row) => rowToEntry({ row, account_id, collaboratorIds, admin }))
    .filter((entry): entry is RootfsImageEntry => !!entry);
  const nextOffset = result.offset + result.rows.length;
  return {
    version: ROOTFS_IMAGE_MANIFEST_VERSION,
    generated_at: new Date().toISOString(),
    source: DEFAULT_ROOTFS_CATALOG_URL,
    images,
    total: result.total,
    limit: result.limit,
    cursor: opts.cursor,
    next_cursor:
      nextOffset < result.total
        ? encodeRootfsCatalogCursor(nextOffset)
        : undefined,
  };
}

export async function listVisibleRootfsImagesById(
  account_id: string | undefined,
  image_ids: string[],
): Promise<RootfsImageManifest> {
  const ids = Array.from(
    new Set(image_ids.map((id) => `${id ?? ""}`.trim()).filter(Boolean)),
  );
  if (ids.length === 0) {
    return {
      version: ROOTFS_IMAGE_MANIFEST_VERSION,
      generated_at: new Date().toISOString(),
      source: DEFAULT_ROOTFS_CATALOG_URL,
      images: [],
    };
  }
  await ensureBuiltinRootfsImages();
  await syncOfficialRootfsCatalogFromSeed();
  const [collaboratorIds, admin] = await Promise.all([
    collaboratorIdsFor(account_id),
    account_id ? isAdmin(account_id) : Promise.resolve(false),
  ]);
  const result = await queryRootfsCatalogRows({
    all: true,
    filters: { image_ids: ids },
    visibleFor: { account_id, collaboratorIds },
  });
  const images = result.rows
    .map((row) => rowToEntry({ row, account_id, collaboratorIds, admin }))
    .filter((entry): entry is RootfsImageEntry => !!entry);
  return {
    version: ROOTFS_IMAGE_MANIFEST_VERSION,
    generated_at: new Date().toISOString(),
    source: DEFAULT_ROOTFS_CATALOG_URL,
    images,
  };
}

export async function listRootfsImagesAdmin(
  account_id?: string,
): Promise<RootfsAdminCatalogEntry[]> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await ensureBuiltinRootfsImages();
  await syncOfficialRootfsCatalogFromSeed();
  const rows = await queryRootfsRows();
  const entries = rows.map((row) =>
    rowToAdminEntry({ row, account_id, admin: true }),
  );
  const replicasByReleaseId = await queryReplicaStorageRows(
    rows
      .map((row) => row.release_id)
      .filter((release_id): release_id is string => !!release_id),
  );
  for (let i = 0; i < entries.length; i++) {
    const release_id = rows[i].release_id;
    if (!release_id) continue;
    const replicas = replicasByReleaseId.get(release_id) ?? [];
    if (!replicas.length) continue;
    entries[i].storage_locations = [
      ...(entries[i].storage_locations ?? []),
      ...replicas,
    ];
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (
        !entry.release_id ||
        (!entry.deleted &&
          entry.release_gc_status !== "blocked" &&
          entry.release_gc_status !== "pending_delete")
      ) {
        return;
      }
      entry.delete_blockers = await getDeleteBlockers({
        release_id: entry.release_id,
        runtime_image: entry.image,
      });
    }),
  );
  const eventsByImageId = await listRecentRootfsImageEvents({
    image_ids: entries.map((entry) => entry.id),
    limitPerImage: 5,
  });
  for (const entry of entries) {
    entry.events = eventsByImageId.get(entry.id) ?? [];
  }
  return entries;
}

async function enrichRootfsAdminEntries({
  rows,
  entries,
}: {
  rows: RootfsImageRow[];
  entries: RootfsAdminCatalogEntry[];
}) {
  const replicasByReleaseId = await queryReplicaStorageRows(
    rows
      .map((row) => row.release_id)
      .filter((release_id): release_id is string => !!release_id),
  );
  for (let i = 0; i < entries.length; i++) {
    const release_id = rows[i].release_id;
    if (!release_id) continue;
    const replicas = replicasByReleaseId.get(release_id) ?? [];
    if (!replicas.length) continue;
    entries[i].storage_locations = [
      ...(entries[i].storage_locations ?? []),
      ...replicas,
    ];
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (
        !entry.release_id ||
        (!entry.deleted &&
          entry.release_gc_status !== "blocked" &&
          entry.release_gc_status !== "pending_delete")
      ) {
        return;
      }
      entry.delete_blockers = await getDeleteBlockers({
        release_id: entry.release_id,
        runtime_image: entry.image,
      });
    }),
  );
  const eventsByImageId = await listRecentRootfsImageEvents({
    image_ids: entries.map((entry) => entry.id),
    limitPerImage: 5,
  });
  for (const entry of entries) {
    entry.events = eventsByImageId.get(entry.id) ?? [];
  }
}

export async function listRootfsImagesAdminPage({
  account_id,
  ...opts
}: RootfsCatalogPageRequest & {
  account_id?: string;
} = {}): Promise<RootfsAdminCatalogPage> {
  if (!account_id || !(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await ensureBuiltinRootfsImages();
  await syncOfficialRootfsCatalogFromSeed();
  const result = await queryRootfsCatalogRows(opts);
  const entries = result.rows.map((row) =>
    rowToAdminEntry({ row, account_id, admin: true }),
  );
  await enrichRootfsAdminEntries({ rows: result.rows, entries });
  const nextOffset = result.offset + result.rows.length;
  return {
    entries,
    total: result.total,
    counts: result.counts,
    limit: result.limit,
    cursor: opts.cursor,
    next_cursor:
      nextOffset < result.total
        ? encodeRootfsCatalogCursor(nextOffset)
        : undefined,
    generated_at: new Date().toISOString(),
  };
}

function normalizeVisibility(value?: unknown): RootfsImageVisibility {
  const trimmed = trimString(value);
  if (
    trimmed === "private" ||
    trimmed === "collaborators" ||
    trimmed === "public"
  ) {
    return trimmed;
  }
  return "private";
}

async function upsertRootfsRow({
  account_id,
  body,
  digest,
  content_key,
  release_id,
}: {
  account_id: string;
  body: RootfsCatalogSaveBody;
  digest?: string | null;
  content_key?: string | null;
  release_id?: string | null;
}): Promise<{ image_id: string; slug: string; entry?: RootfsImageEntry }> {
  const pool = getPool("medium");
  const admin = await isAdmin(account_id);
  const image = trimString(body.image);
  const label = trimString(body.label);
  if (!image) {
    throw Error("image must be specified");
  }
  if (!label) {
    throw Error("label must be specified");
  }

  let image_id = trimString(body.image_id);
  let owner_id = account_id;
  let previous: RootfsLifecycleSnapshot | undefined;

  if (image_id) {
    const { rows } = await pool.query<{
      image_id: string;
      owner_id: string | null;
      deleted: boolean | null;
      release_id: string | null;
      slug: string | null;
      hidden: boolean | null;
      blocked: boolean | null;
      blocked_reason: string | null;
    }>(
      `SELECT image_id, owner_id, release_id, slug, hidden, blocked, blocked_reason, deleted
       FROM rootfs_images
       WHERE image_id=$1`,
      [image_id],
    );
    const existing = rows[0];
    if (!existing) {
      throw Error("rootfs image not found");
    }
    if (!admin && existing.owner_id !== account_id) {
      throw Error("not allowed to update this rootfs image");
    }
    if (existing.deleted) {
      throw Error("deleted rootfs images cannot be updated");
    }
    previous = existing;
    owner_id = existing.owner_id ?? owner_id;
  } else {
    const { rows } = await pool.query<{ image_id: string }>(
      `SELECT image_id
       FROM rootfs_images
       WHERE owner_id=$1 AND runtime_image=$2 AND COALESCE(deleted, false)=false
       ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST
       LIMIT 1`,
      [account_id, image],
    );
    image_id = rows[0]?.image_id ?? v4();
    if (rows[0]?.image_id) {
      const existingRows = await pool.query<RootfsLifecycleSnapshot>(
        `SELECT image_id, owner_id, release_id, slug, hidden, blocked, blocked_reason, deleted
         FROM rootfs_images
         WHERE image_id=$1`,
        [image_id],
      );
      previous = existingRows.rows[0];
    }
  }

  const visibility = normalizeVisibility(body.visibility);
  const family = trimString(body.family) ?? null;
  const version = trimString(body.version) ?? null;
  const channel = trimString(body.channel) ?? null;
  const supersedes_image_id = trimString(body.supersedes_image_id) ?? null;
  const default_jupyter_kernel =
    trimString(body.default_jupyter_kernel) ?? null;
  const tags = normalizeTags(body.tags);
  const description = trimString(body.description) ?? null;
  const theme = normalizeTheme(body.theme);
  const arch = normalizeArch(body.arch);
  const gpu = body.gpu === true;
  const size_gb =
    typeof body.size_gb === "number" && Number.isFinite(body.size_gb)
      ? body.size_gb
      : null;
  const official = admin && body.official === true;
  const prepull = admin && body.prepull === true;
  const hidden = admin && body.hidden === true;
  const blocked = admin && body.blocked === true;
  const blocked_reason = trimString(body.blocked_reason) ?? null;
  const slug =
    validateRootfsSlug(body.slug) ??
    previous?.slug ??
    (await generateUniqueRootfsSlug());
  const existingSlugRows = await pool.query<{ image_id: string }>(
    `SELECT image_id
     FROM rootfs_images
     WHERE slug=$1 AND image_id<>$2
     LIMIT 1`,
    [slug, image_id],
  );
  if (existingSlugRows.rows.length > 0) {
    throw Error(`rootfs slug '${slug}' is already in use`);
  }
  const contentSpecified =
    hasOwn(body, "content") && body.content !== undefined;
  const extraContentWarnings =
    normalizeStoredContentWarnings(body.content_warnings) ?? [];
  const contentMetadataSpecified =
    contentSpecified || extraContentWarnings.length > 0;
  const contentResult =
    contentSpecified && body.content != null
      ? normalizeRootfsContentManifest(body.content)
      : { content: undefined, warnings: [] };
  const content = contentMetadataSpecified
    ? (contentResult.content ?? null)
    : null;
  const mergedContentWarnings = [
    ...extraContentWarnings,
    ...contentResult.warnings,
  ];
  const content_warnings = contentMetadataSpecified
    ? mergedContentWarnings.length
      ? mergedContentWarnings
      : null
    : null;
  const requested_size_bytes =
    typeof size_gb === "number" && Number.isFinite(size_gb)
      ? Math.floor(size_gb * 1_000_000_000)
      : undefined;

  await assertCanCreateOrUpdateRootfs({
    account_id,
    image_id,
    image,
    requested_size_bytes,
    operation: "save",
  });

  await pool.query(
    `INSERT INTO rootfs_images
      (image_id, release_id, owner_id, runtime_image, label, family, version, channel, supersedes_image_id, description, default_jupyter_kernel, visibility, official, prepull, hidden, hidden_at, hidden_by, blocked, blocked_reason, blocked_at, blocked_by, deleted, deleted_reason, deleted_at, deleted_by, arch, gpu, size_gb, tags, digest, content_key, deprecated, deprecated_reason, slug, theme, content, content_warnings, created, updated)
     VALUES
      ($1, $2, $3::UUID, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       CASE WHEN $15 THEN NOW() ELSE NULL END,
       CASE WHEN $15 THEN $3::UUID ELSE NULL END,
       $16,
       CASE WHEN $16 THEN $17 ELSE NULL END,
       CASE WHEN $16 THEN NOW() ELSE NULL END,
       CASE WHEN $16 THEN $3::UUID ELSE NULL END,
       false, NULL, NULL, NULL, $18, $19, $20, $21::TEXT[], $22, $23, false, NULL, $24, $25::JSONB, $26::JSONB, $27::JSONB, NOW(), NOW())
     ON CONFLICT (image_id) DO UPDATE SET
      release_id = COALESCE(EXCLUDED.release_id, rootfs_images.release_id),
      owner_id = EXCLUDED.owner_id,
      runtime_image = EXCLUDED.runtime_image,
      label = EXCLUDED.label,
      family = COALESCE(EXCLUDED.family, rootfs_images.family),
      version = COALESCE(EXCLUDED.version, rootfs_images.version),
      channel = COALESCE(EXCLUDED.channel, rootfs_images.channel),
      supersedes_image_id = COALESCE(EXCLUDED.supersedes_image_id, rootfs_images.supersedes_image_id),
      description = EXCLUDED.description,
      default_jupyter_kernel = EXCLUDED.default_jupyter_kernel,
      visibility = EXCLUDED.visibility,
      official = EXCLUDED.official,
      prepull = EXCLUDED.prepull,
      hidden = EXCLUDED.hidden,
      hidden_at = CASE
        WHEN EXCLUDED.hidden AND COALESCE(rootfs_images.hidden, false) = false THEN NOW()
        ELSE rootfs_images.hidden_at
      END,
      hidden_by = CASE
        WHEN EXCLUDED.hidden AND COALESCE(rootfs_images.hidden, false) = false THEN EXCLUDED.owner_id
        ELSE rootfs_images.hidden_by
      END,
      blocked = EXCLUDED.blocked,
      blocked_reason = CASE
        WHEN EXCLUDED.blocked THEN COALESCE(EXCLUDED.blocked_reason, rootfs_images.blocked_reason)
        ELSE rootfs_images.blocked_reason
      END,
      blocked_at = CASE
        WHEN EXCLUDED.blocked AND COALESCE(rootfs_images.blocked, false) = false THEN NOW()
        ELSE rootfs_images.blocked_at
      END,
      blocked_by = CASE
        WHEN EXCLUDED.blocked AND COALESCE(rootfs_images.blocked, false) = false THEN EXCLUDED.owner_id
        ELSE rootfs_images.blocked_by
      END,
      arch = EXCLUDED.arch,
      gpu = EXCLUDED.gpu,
      size_gb = EXCLUDED.size_gb,
      tags = EXCLUDED.tags,
      digest = COALESCE(EXCLUDED.digest, rootfs_images.digest),
      content_key = COALESCE(EXCLUDED.content_key, rootfs_images.content_key),
      slug = COALESCE(EXCLUDED.slug, rootfs_images.slug),
      theme = EXCLUDED.theme,
      content = CASE WHEN $28 THEN EXCLUDED.content ELSE rootfs_images.content END,
      content_warnings = CASE WHEN $28 THEN EXCLUDED.content_warnings ELSE rootfs_images.content_warnings END,
      updated = NOW()`,
    [
      image_id,
      release_id ?? null,
      owner_id,
      image,
      label,
      family,
      version,
      channel,
      supersedes_image_id,
      description,
      default_jupyter_kernel,
      visibility,
      official,
      prepull,
      hidden,
      blocked,
      blocked_reason,
      arch,
      gpu,
      size_gb,
      tags,
      digest ?? null,
      content_key ?? null,
      slug,
      theme ? JSON.stringify(theme) : null,
      content ? JSON.stringify(content) : null,
      content_warnings ? JSON.stringify(content_warnings) : null,
      contentMetadataSpecified,
    ],
  );

  if (prepull) {
    try {
      await enqueueRootfsPrepullForRunningHosts({
        source: "rootfs_catalog",
        reason: image_id,
      });
    } catch (err) {
      logger.warn("failed to queue RootFS pre-pull after catalog save", {
        image_id,
        err,
      });
    }
  }

  const effectiveReleaseId = release_id ?? previous?.release_id ?? null;
  if (!previous) {
    await appendRootfsImageEvent({
      image_id,
      release_id: effectiveReleaseId,
      event_type: "catalog_created",
      actor_account_id: account_id,
      payload: {
        image,
        label,
        family,
        version,
        channel,
        visibility,
      },
    });
  } else {
    if (!!previous.hidden !== hidden) {
      await appendRootfsImageEvent({
        image_id,
        release_id: effectiveReleaseId,
        event_type: hidden ? "hidden" : "unhidden",
        actor_account_id: account_id,
      });
    }
    if (!!previous.blocked !== blocked) {
      await appendRootfsImageEvent({
        image_id,
        release_id: effectiveReleaseId,
        event_type: blocked ? "blocked" : "unblocked",
        actor_account_id: account_id,
        reason: blocked ? blocked_reason : null,
        payload:
          blocked && blocked_reason
            ? {
                blocked_reason,
              }
            : null,
      });
    } else if (
      blocked &&
      trimString(previous.blocked_reason) !== blocked_reason &&
      blocked_reason
    ) {
      await appendRootfsImageEvent({
        image_id,
        release_id: effectiveReleaseId,
        event_type: "blocked",
        actor_account_id: account_id,
        reason: blocked_reason,
        payload: {
          blocked_reason,
          replaced_reason: trimString(previous.blocked_reason) ?? null,
        },
      });
    }
  }

  const manifest = await listVisibleRootfsImages(account_id);
  return {
    image_id,
    slug,
    entry: manifest.images.find((item) => item.id === image_id),
  };
}

export async function saveRootfsImage({
  account_id,
  body,
}: {
  account_id: string;
  body: RootfsCatalogSaveBody;
}): Promise<RootfsImageEntry> {
  const { image_id, slug, entry } = await upsertRootfsRow({
    account_id,
    body,
  });
  if (entry) {
    return entry;
  }
  const image = trimString(body.image)!;
  const label = trimString(body.label)!;
  const visibility = normalizeVisibility(body.visibility);
  const tags = normalizeTags(body.tags);
  const description = trimString(body.description);
  const theme = normalizeTheme(body.theme);
  const arch = normalizeArch(body.arch);
  const gpu = body.gpu === true;
  const size_gb =
    typeof body.size_gb === "number" && Number.isFinite(body.size_gb)
      ? body.size_gb
      : null;
  const admin = await isAdmin(account_id);
  const official = admin && body.official === true;
  const prepull = admin && body.prepull === true;
  const hidden = admin && body.hidden === true;
  const blocked = admin && body.blocked === true;
  const contentResult =
    hasOwn(body, "content") && body.content != null
      ? normalizeRootfsContentManifest(body.content)
      : undefined;
  return normalizeRootfsEntry(
    {
      id: image_id,
      slug,
      label,
      image,
      family: body.family,
      version: body.version,
      channel: body.channel,
      supersedes_image_id: body.supersedes_image_id,
      default_jupyter_kernel: body.default_jupyter_kernel,
      description: description ?? undefined,
      visibility,
      official,
      prepull,
      hidden,
      blocked,
      blocked_reason: blocked ? trimString(body.blocked_reason) : undefined,
      arch: arch as RootfsImageArch,
      gpu,
      size_gb: size_gb ?? undefined,
      tags,
      theme: theme ?? undefined,
      content: contentResult?.content,
      section: official ? "official" : "mine",
      warning: "none",
      can_manage: true,
    },
    DEFAULT_ROOTFS_CATALOG_URL,
  );
}

export async function publishProjectRootfsCatalogEntry({
  account_id,
  body,
  artifact,
  release_id,
}: {
  account_id: string;
  body: PublishProjectRootfsBody;
  artifact: PublishProjectRootfsArtifact;
  release_id?: string | null;
}): Promise<RootfsImageEntry> {
  const tags = Array.from(
    new Set(
      [
        ...(body.tags ?? []),
        "project-publish",
        `snapshot:${artifact.snapshot}`,
      ].filter(Boolean),
    ),
  );
  const size_gb =
    artifact.size_bytes != null
      ? Number((artifact.size_bytes / 1_000_000_000).toFixed(3))
      : undefined;
  const hasExplicitContent = hasOwn(body, "content");
  const content =
    hasExplicitContent || artifact.rootfs_content === undefined
      ? body.content
      : artifact.rootfs_content;
  const content_warnings = [
    ...(normalizeStoredContentWarnings(body.content_warnings) ?? []),
    ...(normalizeStoredContentWarnings(artifact.rootfs_content_warnings) ?? []),
  ];
  await assertCanCreateOrUpdateRootfs({
    account_id,
    image: artifact.image,
    requested_size_bytes: artifact.size_bytes,
    operation: "publish",
  });
  const { image_id, slug, entry } = await upsertRootfsRow({
    account_id,
    body: {
      image: artifact.image,
      label: body.label,
      family: body.family,
      version: body.version,
      channel: body.channel,
      supersedes_image_id: body.supersedes_image_id,
      description: body.description,
      default_jupyter_kernel: body.default_jupyter_kernel,
      visibility: body.visibility,
      arch: artifact.arch,
      tags,
      theme: body.theme,
      slug: body.slug,
      content,
      content_warnings,
      official: body.official,
      prepull: body.prepull,
      hidden: body.hidden,
      size_gb,
    },
    digest: artifact.digest,
    content_key: artifact.content_key,
    release_id,
  });
  if (entry) {
    return entry;
  }
  const visibility = normalizeVisibility(body.visibility);
  const contentResult =
    content != null ? normalizeRootfsContentManifest(content) : undefined;
  return normalizeRootfsEntry(
    {
      id: image_id,
      release_id: release_id ?? undefined,
      slug,
      label: body.label,
      image: artifact.image,
      family: body.family,
      version: body.version,
      channel: body.channel,
      supersedes_image_id: body.supersedes_image_id,
      description: body.description,
      default_jupyter_kernel: body.default_jupyter_kernel,
      digest: artifact.digest,
      arch: artifact.arch,
      visibility,
      official: false,
      prepull: false,
      hidden: body.hidden === true,
      size_gb,
      tags,
      theme: normalizeTheme(body.theme) ?? undefined,
      content: contentResult?.content,
      section: "mine",
      warning: "none",
      can_manage: true,
    },
    DEFAULT_ROOTFS_CATALOG_URL,
  );
}

async function getDeleteBlockers({
  release_id,
  runtime_image,
}: {
  release_id?: string | null;
  runtime_image: string;
}): Promise<RootfsDeleteBlockers> {
  if (!release_id) {
    return {
      projects_using_release: 0,
      catalog_entries_using_release: 0,
      prepull_entries_using_release: 0,
      child_releases: 0,
      total: 0,
    };
  }
  const pool = getPool("medium");
  const [projects, catalogEntries, prepullEntries, childReleases] =
    await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT project_id)::TEXT AS count
         FROM (
           SELECT project_id
           FROM project_rootfs_states
           WHERE release_id=$1 OR runtime_image=$2
           UNION
           SELECT project_id
           FROM projects
           WHERE rootfs_image=$2
         ) AS retained_projects`,
        [release_id, runtime_image],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM rootfs_images
         WHERE release_id=$1 AND COALESCE(deleted, false)=false`,
        [release_id],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM rootfs_images
         WHERE release_id=$1 AND prepull=true AND COALESCE(deleted, false)=false`,
        [release_id],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM rootfs_releases
         WHERE parent_release_id=$1 AND COALESCE(gc_status, 'active') <> 'deleted'`,
        [release_id],
      ),
    ]);
  const projects_using_release = Number(projects.rows[0]?.count ?? 0);
  const catalog_entries_using_release = Number(
    catalogEntries.rows[0]?.count ?? 0,
  );
  const prepull_entries_using_release = Number(
    prepullEntries.rows[0]?.count ?? 0,
  );
  const child_releases = Number(childReleases.rows[0]?.count ?? 0);
  return {
    projects_using_release,
    catalog_entries_using_release,
    prepull_entries_using_release,
    child_releases,
    total:
      projects_using_release +
      catalog_entries_using_release +
      prepull_entries_using_release +
      child_releases,
  };
}

export async function requestRootfsImageDeletion({
  account_id,
  image_id,
  reason,
}: {
  account_id: string;
  image_id: string;
  reason?: string;
}): Promise<RootfsDeleteRequestResult> {
  const pool = getPool("medium");
  const admin = await isAdmin(account_id);
  const { rows } = await pool.query<{
    image_id: string;
    release_id: string | null;
    owner_id: string | null;
    runtime_image: string;
    deleted: boolean | null;
  }>(
    `SELECT image_id, release_id, owner_id, runtime_image, deleted
     FROM rootfs_images
     WHERE image_id=$1`,
    [image_id],
  );
  const row = rows[0];
  if (!row) {
    throw Error("rootfs image not found");
  }
  if (!admin && row.owner_id !== account_id) {
    throw Error("not allowed to delete this rootfs image");
  }
  if (row.deleted) {
    throw Error("rootfs image is already deleted");
  }

  const delete_reason = trimString(reason) ?? null;
  await pool.query(
    `UPDATE rootfs_images
     SET hidden=true,
         hidden_at = COALESCE(hidden_at, NOW()),
         hidden_by = COALESCE(hidden_by, $3),
         deleted=true,
         deleted_reason=$2,
         deleted_by=$3,
         deleted_at=NOW(),
         updated=NOW()
     WHERE image_id=$1`,
    [image_id, delete_reason, account_id],
  );

  const blockers = await getDeleteBlockers({
    release_id: row.release_id,
    runtime_image: row.runtime_image,
  });
  const release_gc_status: RootfsReleaseGcStatus | undefined = row.release_id
    ? blockers.total === 0
      ? "pending_delete"
      : "blocked"
    : undefined;
  if (row.release_id) {
    await pool.query(
      `UPDATE rootfs_releases
       SET gc_status=$2,
           delete_requested_at=NOW(),
           delete_requested_by=$3,
           delete_reason=$4,
           updated=NOW()
       WHERE release_id=$1`,
      [row.release_id, release_gc_status, account_id, delete_reason],
    );
  }
  await appendRootfsImageEvent({
    image_id: row.image_id,
    release_id: row.release_id,
    event_type: "deleted",
    actor_account_id: account_id,
    reason: delete_reason,
    payload: {
      release_gc_status,
      blockers,
    },
  });
  if (row.release_id && release_gc_status) {
    await appendRootfsImageEvent({
      image_id: row.image_id,
      release_id: row.release_id,
      event_type:
        release_gc_status === "pending_delete"
          ? "release_gc_pending"
          : "release_gc_blocked",
      actor_account_id: account_id,
      reason: delete_reason,
      payload: {
        blockers,
      },
    });
  }

  return {
    image_id: row.image_id,
    release_id: row.release_id ?? undefined,
    image: row.runtime_image,
    hidden: true,
    deleted: true,
    release_gc_status,
    delete_requested: true,
    blockers,
  };
}

export async function deleteRootfsImagesForAccountDeletion(
  account_id: string,
): Promise<RootfsDeleteRequestResult[]> {
  const pool = getPool("medium");
  const { rows } = await pool.query<{ image_id: string }>(
    `SELECT image_id
     FROM rootfs_images
     WHERE owner_id=$1
       AND COALESCE(deleted, false)=false
     ORDER BY created NULLS LAST, image_id`,
    [account_id],
  );
  const results: RootfsDeleteRequestResult[] = [];
  for (const row of rows) {
    results.push(
      await requestRootfsImageDeletion({
        account_id,
        image_id: row.image_id,
        reason: "account deletion",
      }),
    );
  }
  return results;
}

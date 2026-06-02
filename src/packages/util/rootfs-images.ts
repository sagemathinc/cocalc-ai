/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const ROOTFS_IMAGE_MANIFEST_VERSION = 1;

export type RootfsImageArch = "amd64" | "arm64" | "any";
export type RootfsPhaseTimings = Record<string, number>;
export type RootfsImageVisibility = "private" | "collaborators" | "public";
export type RootfsReleaseGcStatus =
  | "active"
  | "pending_delete"
  | "blocked"
  | "deleted";
export type RootfsScanStatus =
  | "unknown"
  | "pending"
  | "clean"
  | "findings"
  | "error";
export type RootfsScanPolicyStatus = "allowed" | "blocked" | "admin_exception";
export type RootfsScanSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "unknown";
export type RootfsImageEventType =
  | "catalog_created"
  | "hidden"
  | "unhidden"
  | "blocked"
  | "unblocked"
  | "deleted"
  | "release_gc_pending"
  | "release_gc_blocked"
  | "release_gc_deleted"
  | "release_gc_failed"
  | "scan_requested"
  | "scan_started"
  | "scan_completed"
  | "scan_failed"
  | "scan_policy_blocked"
  | "scan_exception_added"
  | "scan_exception_expired"
  | "scan_admin_bypass";
export type RootfsImageSection =
  | "official"
  | "mine"
  | "collaborators"
  | "public";
export type RootfsImageWarning = "none" | "collaborator" | "public";
export type RootfsPublishSourceMode = "current";
export type ProjectRootfsStateRole = "current" | "previous";

export type RootfsImageTheme = {
  title?: string;
  description?: string;
  color?: string | null;
  accent_color?: string | null;
  icon?: string | null;
  image_blob?: string | null;
};

export type RootfsScanSummary = {
  status?: RootfsScanStatus;
  policy_status?: RootfsScanPolicyStatus;
  tool?: string;
  tool_version?: string;
  scanned_at?: string;
  started_at?: string;
  duration_ms?: number;
  scanner_version?: string;
  summary?: string;
  findings_summary?: Record<string, number>;
  severity_counts?: Partial<Record<RootfsScanSeverity, number>>;
  highest_findings?: RootfsScanFinding[];
  report_url?: string;
  report?: RootfsScanReportRef;
  db?: {
    version?: string;
    updated_at?: string;
    source?: string;
  };
  target?: {
    target_kind?: "rootfs-release" | "project-rootfs";
    release_id?: string;
    content_key?: string;
    runtime_image?: string;
    project_id?: string;
    arch?: string;
    size_bytes?: number;
  };
  admin_notes?: RootfsScanAdminNote[];
  error?: {
    message?: string;
    code?: string;
  };
  metadata?: Record<string, any>;
};

export type RootfsScanFinding = {
  id: string;
  severity: RootfsScanSeverity;
  package_name?: string;
  installed_version?: string;
  fixed_version?: string;
  title?: string;
  primary_url?: string;
};

export type RootfsScanReportRef = {
  artifact_id?: string;
  format?: "trivy-json" | string;
  sha256?: string;
  bytes?: number;
  compressed_bytes?: number;
  retention_until?: string;
};

export type RootfsScanAdminNote = {
  account_id?: string;
  created_at?: string;
  kind?: "false_positive" | "accepted_risk" | "remediation" | "admin_bypass";
  note?: string;
  finding_ids?: string[];
  expires_at?: string;
};

export type RootfsImageEntry = {
  id: string;
  release_id?: string;
  label: string;
  image: string;
  created?: string;
  family?: string;
  version?: string;
  channel?: string;
  supersedes_image_id?: string;
  description?: string;
  digest?: string;
  arch?: RootfsImageArch | RootfsImageArch[];
  gpu?: boolean;
  priority?: number;
  size_gb?: number;
  tags?: string[];
  prepull?: boolean;
  deprecated?: boolean;
  deprecated_reason?: string;
  visibility?: RootfsImageVisibility;
  official?: boolean;
  hidden?: boolean;
  blocked?: boolean;
  blocked_reason?: string;
  owner_id?: string;
  owner_name?: string;
  section?: RootfsImageSection;
  warning?: RootfsImageWarning;
  theme?: RootfsImageTheme;
  can_manage?: boolean;
  scan?: RootfsScanSummary;
};

export type RootfsImageManifest = {
  version: number;
  generated_at?: string;
  source?: string;
  images: RootfsImageEntry[];
};

export type RootfsCatalogSortField =
  | "updated"
  | "created"
  | "label"
  | "family"
  | "visibility"
  | "official"
  | "scan_status"
  | "storage_status"
  | "owner"
  | "usage_count";

export type RootfsCatalogSortDirection = "asc" | "desc";

export type RootfsCatalogPageRequest = {
  limit?: number;
  offset?: number;
  cursor?: string;
  query?: string;
  sort?: RootfsCatalogSortField;
  direction?: RootfsCatalogSortDirection;
  filters?: {
    visibility?: RootfsImageVisibility;
    official?: boolean;
    prepull?: boolean;
    hidden?: boolean;
    blocked?: boolean;
    deleted?: boolean;
    gpu?: boolean;
    scan_status?: RootfsScanStatus;
    release_gc_status?: RootfsReleaseGcStatus;
    owner_id?: string;
    family?: string;
    channel?: string;
  };
};

export type RootfsAdminCatalogCounts = {
  total: number;
  deleted: number;
  pending_delete: number;
  blocked: number;
  official_unscanned: number;
  official_critical: number;
  official_scan_failed: number;
};

export type RootfsAdminCatalogPage = {
  entries: RootfsAdminCatalogEntry[];
  total: number;
  limit: number;
  cursor?: string;
  next_cursor?: string;
  counts: RootfsAdminCatalogCounts;
  generated_at: string;
};

export type RootfsImageCatalogPage = {
  version: number;
  generated_at?: string;
  source?: string;
  images: RootfsImageEntry[];
  total: number;
  limit: number;
  cursor?: string;
  next_cursor?: string;
};

export type RootfsCatalogSaveBody = {
  image_id?: string;
  image: string;
  label: string;
  family?: string;
  version?: string;
  channel?: string;
  supersedes_image_id?: string;
  description?: string;
  visibility?: RootfsImageVisibility;
  arch?: RootfsImageArch | RootfsImageArch[];
  gpu?: boolean;
  size_gb?: number;
  tags?: string[];
  theme?: RootfsImageTheme;
  official?: boolean;
  prepull?: boolean;
  hidden?: boolean;
  blocked?: boolean;
  blocked_reason?: string;
};

export type PublishProjectRootfsBody = {
  project_id: string;
  label: string;
  family?: string;
  version?: string;
  channel?: string;
  supersedes_image_id?: string;
  description?: string;
  visibility?: RootfsImageVisibility;
  tags?: string[];
  theme?: RootfsImageTheme;
  official?: boolean;
  prepull?: boolean;
  hidden?: boolean;
  source_mode?: RootfsPublishSourceMode;
};

export type PublishProjectRootfsArtifact = {
  image: string;
  content_key: string;
  digest?: string;
  arch: RootfsImageArch;
  size_bytes?: number;
  snapshot: string;
  created_snapshot: boolean;
  source_image: string;
  artifact_kind?: RootfsReleaseArtifactKind;
  inspect_data?: Record<string, any>;
  upload_result?: RootfsUploadedArtifactResult;
  phase_timings_ms?: RootfsPhaseTimings;
};

export type RootfsReleaseArtifactKind = "full";
export type RootfsReleaseArtifactFormat = "rustic";
export type RootfsReleaseArtifactBackend = "r2" | "rest";

export type RootfsArtifactTransferTarget = {
  backend: "rustic";
  repo_toml: string;
  repo_selector: string;
  repo_id?: string;
  repo_root?: string;
  artifact_backend: RootfsReleaseArtifactBackend;
  region?: string;
  bucket_id?: string;
  bucket_name?: string;
  bucket_purpose?: string | null;
};

export type RootfsUploadedArtifactResult = {
  ok: true;
  backend: "rustic";
  artifact_kind?: RootfsReleaseArtifactKind;
  artifact_format: "rustic";
  artifact_backend: RootfsReleaseArtifactBackend;
  artifact_sha256: string;
  artifact_bytes: number;
  artifact_path: string;
  snapshot_id: string;
  repo_selector: string;
  repo_id?: string;
  repo_root?: string;
  region?: string;
  bucket_id?: string;
  bucket_name?: string;
  bucket_purpose?: string | null;
  phase_timings_ms?: RootfsPhaseTimings;
};

export type RootfsReleaseArtifactAccess = {
  release_id: string;
  image: string;
  content_key: string;
  size_bytes?: number;
  artifact_kind: "full";
  artifact_format: "rustic";
  artifact_backend: RootfsReleaseArtifactBackend;
  artifact_sha256: string;
  artifact_bytes: number;
  artifact_path: string;
  snapshot_id: string;
  repo_selector: string;
  repo_toml: string;
  repo_id?: string;
  repo_root?: string;
  region?: string;
  regional_replication_target?: RootfsArtifactTransferTarget;
  inspect_data?: Record<string, any>;
};

export type RootfsDeleteBlockers = {
  projects_using_release: number;
  catalog_entries_using_release: number;
  prepull_entries_using_release: number;
  child_releases: number;
  total: number;
};

export type RootfsDeleteRequestResult = {
  image_id: string;
  release_id?: string;
  image: string;
  hidden: boolean;
  deleted: boolean;
  release_gc_status?: RootfsReleaseGcStatus;
  delete_requested: boolean;
  blockers: RootfsDeleteBlockers;
};

export type RootfsImageEvent = {
  event_id: string;
  image_id: string;
  release_id?: string;
  event_type: RootfsImageEventType;
  actor_account_id?: string;
  actor_name?: string;
  reason?: string;
  payload?: Record<string, any>;
  created: string;
};

export type RootfsStorageLocation = {
  role: "primary" | "replica";
  backend: RootfsReleaseArtifactBackend;
  artifact_format: RootfsReleaseArtifactFormat;
  artifact_path: string;
  repo_selector?: string;
  repo_id?: string;
  repo_root?: string;
  region?: string;
  bucket_name?: string;
  bucket_purpose?: string | null;
  status?: string;
};

export type RootfsRusticRepoSummary = {
  id: string;
  region: string;
  bucket_id?: string | null;
  bucket_name?: string | null;
  bucket_purpose?: string | null;
  root: string;
  status: "active" | "sealed" | "draining" | "disabled" | string;
  assigned_artifact_count: number;
  artifact_bytes: number;
  r2_object_count?: number;
  r2_total_bytes?: number;
  cap: number;
  available_slots: number;
  created?: string | null;
  updated?: string | null;
};

export type RootfsRusticLegacySummary = {
  artifact_count: number;
  artifact_bytes: number;
  r2_object_count?: number;
  r2_total_bytes?: number;
};

export type RootfsRusticRepoListResult = {
  active_shards_per_region: number;
  releases_per_shard: number;
  repos: RootfsRusticRepoSummary[];
  legacy: RootfsRusticLegacySummary;
  orphan_r2_repos?: Array<{
    bucket_name?: string | null;
    repo: string;
    object_count: number;
    total_bytes: number;
  }>;
};

export type RootfsAdminCatalogEntry = RootfsImageEntry & {
  deleted?: boolean;
  deleted_reason?: string;
  deleted_at?: string;
  deleted_by?: string;
  hidden_at?: string;
  hidden_by?: string;
  blocked_at?: string;
  blocked_by?: string;
  release_gc_status?: RootfsReleaseGcStatus;
  delete_blockers?: RootfsDeleteBlockers;
  scan_status?: RootfsScanStatus;
  scan_tool?: string;
  scanned_at?: string;
  events?: RootfsImageEvent[];
  storage_locations?: RootfsStorageLocation[];
};

export type ProjectRootfsStateEntry = {
  project_id: string;
  state_role: ProjectRootfsStateRole;
  image: string;
  release_id?: string;
  image_id?: string;
  set_by_account_id?: string;
  set_by_name?: string;
  created_at?: string;
  updated_at?: string;
};

export type RootfsReleaseGcItem = {
  release_id: string;
  content_key: string;
  image: string;
  status: "deleted" | "blocked" | "skipped" | "failed";
  blockers?: RootfsDeleteBlockers;
  deleted_replicas?: number;
  error?: string;
};

export type RootfsReleaseGcRunResult = {
  scanned: number;
  deleted: number;
  blocked: number;
  failed: number;
  items: RootfsReleaseGcItem[];
};

export type ProjectRootfsPublishLroRef = {
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
};

export const MANAGED_ROOTFS_IMAGE_PREFIX = "cocalc.local/rootfs/";

export function managedRootfsImageName(contentKey: string): string {
  const trimmed = `${contentKey ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("content key must be specified");
  }
  return `${MANAGED_ROOTFS_IMAGE_PREFIX}${trimmed}`;
}

export function isManagedRootfsImageName(image?: string): boolean {
  return `${image ?? ""}`.trim().startsWith(MANAGED_ROOTFS_IMAGE_PREFIX);
}

export function assertValidRootfsImageName(image?: string): string {
  const value = `${image ?? ""}`.trim();
  if (!value) return "";
  if (
    isManagedRootfsImageName(value) ||
    value.includes(":") ||
    value.includes("/")
  ) {
    return value;
  }
  throw new Error(
    `invalid rootfs OCI image '${value}'; use a valid image reference such as 'ubuntu:26.04'`,
  );
}

export function managedRootfsContentKey(image?: string): string | undefined {
  const value = `${image ?? ""}`.trim();
  if (!value.startsWith(MANAGED_ROOTFS_IMAGE_PREFIX)) return;
  const contentKey = value.slice(MANAGED_ROOTFS_IMAGE_PREFIX.length).trim();
  return contentKey.length > 0 ? contentKey : undefined;
}

export function normalizeRootfsImageName(image?: string): string {
  const value = `${image ?? ""}`.trim();
  if (!value) return "";
  if (isManagedRootfsImageName(value)) return value;
  const firstSlash = value.indexOf("/");
  if (firstSlash === -1) return `docker.io/${value}`;
  const first = value.slice(0, firstSlash);
  return first === "localhost" || first.includes(".") || first.includes(":")
    ? value
    : `docker.io/${value}`;
}

function normalizeArch(value?: RootfsImageEntry["arch"]): RootfsImageArch[] {
  if (!value) return ["any"];
  if (Array.isArray(value)) return value.length ? value : ["any"];
  return [value];
}

export function normalizeRootfsEntry(
  entry: RootfsImageEntry,
  source?: string,
): RootfsImageEntry {
  const baseTags = (entry.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const tags = source
    ? Array.from(new Set([...baseTags, `source:${source}`]))
    : baseTags;
  return {
    ...entry,
    id: entry.id.trim(),
    label: entry.label.trim(),
    image: entry.image.trim(),
    description: entry.description?.trim(),
    tags,
    arch: normalizeArch(entry.arch),
    priority: entry.priority ?? 0,
    visibility: entry.visibility ?? "public",
    warning: entry.warning ?? "none",
    owner_name: entry.owner_name?.trim(),
    deprecated_reason: entry.deprecated_reason?.trim(),
  };
}

export function mergeRootfsManifests(
  manifests: RootfsImageManifest[],
): RootfsImageEntry[] {
  const merged = new Map<string, RootfsImageEntry>();
  for (const manifest of manifests) {
    for (const entry of manifest.images ?? []) {
      const normalized = normalizeRootfsEntry(entry, manifest.source);
      merged.set(normalized.id, normalized);
    }
  }
  return Array.from(merged.values()).sort((a, b) => {
    const aPriority = a.priority ?? 0;
    const bPriority = b.priority ?? 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

export const DEFAULT_ROOTFS_CATALOG_URL = "/rootfs/catalog.json";

export const BUILTIN_ROOTFS_IMAGES: RootfsImageEntry[] = [
  {
    id: "official-cocalc-base",
    label: "Ubuntu 26.04",
    image: "ubuntu:26.04",
    description:
      "Official Ubuntu 26.04 base image for projects. This is the default launch image.",
    priority: 1000,
    prepull: true,
    official: true,
    visibility: "public",
    section: "official",
    warning: "none",
    tags: ["official", "cpu", "base"],
    theme: {
      title: "Ubuntu 26.04",
      color: "#4474c0",
      accent_color: "#14b8a6",
      icon: "cube",
    },
  },
];

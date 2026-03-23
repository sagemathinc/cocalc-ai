/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const ROOTFS_IMAGE_MANIFEST_VERSION = 1;

export type RootfsImageArch = "amd64" | "arm64" | "any";
export type RootfsImageVisibility = "private" | "collaborators" | "public";
export type RootfsImageSection =
  | "official"
  | "mine"
  | "collaborators"
  | "public";
export type RootfsImageWarning = "none" | "collaborator" | "public";
export type RootfsPublishSourceMode = "current";

export type RootfsImageTheme = {
  title?: string;
  description?: string;
  color?: string | null;
  accent_color?: string | null;
  icon?: string | null;
  image_blob?: string | null;
};

export type RootfsImageEntry = {
  id: string;
  release_id?: string;
  label: string;
  image: string;
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
  owner_id?: string;
  owner_name?: string;
  section?: RootfsImageSection;
  warning?: RootfsImageWarning;
  theme?: RootfsImageTheme;
  can_manage?: boolean;
};

export type RootfsImageManifest = {
  version: number;
  generated_at?: string;
  source?: string;
  images: RootfsImageEntry[];
};

export type RootfsCatalogSaveBody = {
  image_id?: string;
  image: string;
  label: string;
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
};

export type PublishProjectRootfsBody = {
  project_id: string;
  label: string;
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
  digest: string;
  arch: RootfsImageArch;
  size_bytes?: number;
  snapshot: string;
  created_snapshot: boolean;
  source_image: string;
  inspect_data?: Record<string, any>;
};

export type RootfsReleaseArtifactKind = "full";
export type RootfsReleaseArtifactFormat = "btrfs-send";
export type RootfsReleaseArtifactBackend = "hub-local" | "r2";

export type RootfsArtifactTransferTarget = {
  backend: RootfsReleaseArtifactBackend;
  url: string;
  method: "PUT";
  headers?: Record<string, string>;
  chunk_bytes?: number;
  region?: string;
  bucket_id?: string;
  bucket_name?: string;
  bucket_purpose?: string | null;
  artifact_path?: string;
};

export type RootfsUploadedArtifactResult =
  | {
      ok: true;
      backend: "hub-local";
    }
  | {
      ok: true;
      backend: "r2";
      artifact_sha256: string;
      artifact_bytes: number;
      region: string;
      bucket_id?: string;
      bucket_name: string;
      bucket_purpose?: string | null;
      artifact_path: string;
    };

export type RootfsReleaseArtifactAccess = {
  release_id: string;
  image: string;
  content_key: string;
  artifact_kind: RootfsReleaseArtifactKind;
  artifact_format: RootfsReleaseArtifactFormat;
  artifact_backend: RootfsReleaseArtifactBackend;
  artifact_sha256: string;
  artifact_bytes: number;
  download_url: string;
  download_headers?: Record<string, string>;
  inspect_data?: Record<string, any>;
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
    label: "CoCalc Base",
    image: "buildpack-deps:noble-scm",
    description:
      "Official minimal CoCalc base image for projects. This is the default launch image.",
    priority: 1000,
    prepull: true,
    official: true,
    visibility: "public",
    section: "official",
    warning: "none",
    tags: ["official", "cpu", "base"],
    theme: {
      title: "CoCalc Base",
      color: "#4474c0",
      accent_color: "#14b8a6",
      icon: "cube",
    },
  },
];

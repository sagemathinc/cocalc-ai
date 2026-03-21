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

export function normalizeRootfsImageName(image?: string): string {
  const value = `${image ?? ""}`.trim();
  if (!value) return "";
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

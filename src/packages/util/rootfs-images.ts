/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const ROOTFS_IMAGE_MANIFEST_VERSION = 1;

export type RootfsImageArch = "amd64" | "arm64" | "any";

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
};

export type RootfsImageManifest = {
  version: number;
  generated_at?: string;
  source?: string;
  images: RootfsImageEntry[];
};

function normalizeArch(value?: RootfsImageEntry["arch"]): RootfsImageArch[] {
  if (!value) return ["any"];
  if (Array.isArray(value)) return value.length ? value : ["any"];
  return [value];
}

export function normalizeRootfsEntry(
  entry: RootfsImageEntry,
  source?: string,
): RootfsImageEntry {
  const baseTags = (entry.tags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean);
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

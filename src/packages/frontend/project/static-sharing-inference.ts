/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DirectoryListingEntry } from "@cocalc/util/types";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";

export type StaticSharingSuggestionKey =
  | "generic-static"
  | "cocalc-public-viewer"
  | "public-notes"
  | "public-slides";

export interface StaticSharingSuggestion {
  key: StaticSharingSuggestionKey;
  label: string;
  reason: string;
}

export interface StaticDirectoryInference {
  fileCount: number;
  directoryCount: number;
  hasIndexHtml: boolean;
  hasManifest: boolean;
  viewerFileTypes: string[];
  suggestions: StaticSharingSuggestion[];
}

const VIEWER_FILE_TYPES = [".md", ".ipynb", ".slides", ".board"] as const;

function fileExtension(name: string): string {
  const lower = name.toLowerCase();
  const idx = lower.lastIndexOf(".");
  if (idx <= 0) return "";
  return lower.slice(idx);
}

function canonicalViewerFileTypes(fileTypes: Iterable<string>): string[] {
  const present = new Set(fileTypes);
  return VIEWER_FILE_TYPES.filter((ext) => present.has(ext));
}

function isPublicNotesFileTypes(fileTypes: string[]): boolean {
  return fileTypes.every((ext) => ext === ".md" || ext === ".ipynb");
}

function isPublicSlidesFileTypes(fileTypes: string[]): boolean {
  return (
    fileTypes.some((ext) => ext === ".slides" || ext === ".board") &&
    fileTypes.every(
      (ext) => ext === ".slides" || ext === ".board" || ext === ".md",
    )
  );
}

export function inferStaticSharingFromDirectory(
  entries: DirectoryListingEntry[],
): StaticDirectoryInference {
  let fileCount = 0;
  let directoryCount = 0;
  let hasIndexHtml = false;
  let hasManifest = false;
  const viewerTypes = new Set<string>();

  for (const entry of entries) {
    if (entry.isDir) {
      directoryCount += 1;
      continue;
    }
    fileCount += 1;
    const lower = `${entry.name ?? ""}`.toLowerCase();
    if (lower === "index.html") {
      hasIndexHtml = true;
    }
    if (lower === "index.json") {
      hasManifest = true;
    }
    const ext = fileExtension(lower);
    if ((VIEWER_FILE_TYPES as readonly string[]).includes(ext)) {
      viewerTypes.add(ext);
    }
  }

  const viewerFileTypes = canonicalViewerFileTypes(viewerTypes);
  const suggestions: StaticSharingSuggestion[] = [];

  if (hasIndexHtml) {
    suggestions.push({
      key: "generic-static",
      label: "Use generic static site setup",
      reason: "Found index.html in this directory.",
    });
  }

  if (hasManifest || viewerFileTypes.length > 0) {
    if (isPublicNotesFileTypes(viewerFileTypes)) {
      suggestions.push({
        key: "public-notes",
        label: "Use Public Notes setup",
        reason: hasManifest
          ? "Found index.json plus notebook/markdown content."
          : "Detected markdown and notebook files.",
      });
    } else if (isPublicSlidesFileTypes(viewerFileTypes)) {
      suggestions.push({
        key: "public-slides",
        label: "Use Public Slides setup",
        reason: hasManifest
          ? "Found index.json plus slides/board content."
          : "Detected slides, boards, or supporting markdown.",
      });
    } else {
      suggestions.push({
        key: "cocalc-public-viewer",
        label: "Use CoCalc Public Viewer setup",
        reason: hasManifest
          ? "Found index.json or a mixed set of supported CoCalc file types."
          : "Detected a mixed set of supported CoCalc file types.",
      });
    }
  }

  return {
    fileCount,
    directoryCount,
    hasIndexHtml,
    hasManifest,
    viewerFileTypes,
    suggestions,
  };
}

export function suggestStaticDirectoryFromProjectPath(
  input: string | undefined,
  fallbackDirectory: string,
): string {
  const normalized = normalizeAbsolutePath(
    `${input ?? ""}`.trim() || fallbackDirectory,
    fallbackDirectory,
  );
  if (normalized === "/") return normalized;
  const segments = normalized.split("/").filter(Boolean);
  const leaf = segments[segments.length - 1] ?? "";
  if (leaf.includes(".")) {
    const parent = normalized.replace(/\/[^/]+$/, "");
    return parent || "/";
  }
  return normalized;
}

export function suggestAppIdFromDirectory(
  directory: string,
  fallback = "public-site",
): string {
  const normalized = normalizeAbsolutePath(directory || "/");
  const leaf =
    normalized === "/"
      ? ""
      : (normalized.split("/").filter(Boolean).pop() ?? "");
  const slug = leaf
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

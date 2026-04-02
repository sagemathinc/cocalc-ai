/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import path from "node:path";

export const COCALC_PUBLIC_VIEWER_MODE = "cocalc-public-viewer" as const;
export const PUBLIC_VIEWER_DEFAULT_FILE_TYPES = [
  ".md",
  ".ipynb",
  ".slides",
  ".board",
  ".chat",
  ".sage-chat",
] as const;
export const PUBLIC_VIEWER_DEFAULT_MANIFEST = "index.json" as const;
export const PUBLIC_VIEWER_DEFAULT_DIRECTORY_LISTING = "manifest-only" as const;
export const PUBLIC_VIEWER_DEFAULT_CACHE_MODE = "balanced" as const;
export const PUBLIC_VIEWER_MANIFEST_KIND =
  "cocalc-public-viewer-index" as const;
export const PUBLIC_VIEWER_HTML_BY_EXT: Record<string, string> = {
  ".md": "public-viewer-md.html",
  ".ipynb": "public-viewer-ipynb.html",
  ".slides": "public-viewer-slides.html",
  ".board": "public-viewer-board.html",
  ".chat": "public-viewer-chat.html",
  ".sage-chat": "public-viewer-chat.html",
};

export type PublicViewerDirectoryListingPolicy =
  typeof PUBLIC_VIEWER_DEFAULT_DIRECTORY_LISTING;
export type PublicViewerCacheMode = "live-editing" | "balanced" | "published";
export type PublicViewerEntryRenderMode = "viewer" | "raw" | "hidden";

export interface AppStaticPublicViewerIntegrationSpec {
  mode: typeof COCALC_PUBLIC_VIEWER_MODE;
  file_types: string[];
  viewer_bundle?: string;
  auto_refresh_s: number;
  cache_mode: PublicViewerCacheMode;
  manifest: string;
  directory_listing: PublicViewerDirectoryListingPolicy;
}

export type AppStaticIntegrationSpec = AppStaticPublicViewerIntegrationSpec;

export interface PublicViewerManifestTheme {
  layout?: string;
  accent_color?: string;
}

export interface PublicViewerManifestEntry {
  path: string;
  title?: string;
  description?: string;
  type?: string;
  render: PublicViewerEntryRenderMode;
  order?: number;
  tags?: string[];
}

export interface PublicViewerManifest {
  version: 1;
  kind: typeof PUBLIC_VIEWER_MANIFEST_KIND;
  title?: string;
  description?: string;
  theme?: PublicViewerManifestTheme;
  entries: PublicViewerManifestEntry[];
}

function asObject(input: unknown, context: string): Record<string, any> {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${context} must be an object`);
  }
  return input as Record<string, any>;
}

function asOptionalString(input: unknown): string | undefined {
  if (input == null) return undefined;
  const value = `${input}`.trim();
  return value.length > 0 ? value : undefined;
}

function asString(input: unknown, context: string): string {
  const value = asOptionalString(input);
  if (!value) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function asOptionalStringArray(
  input: unknown,
  context: string,
): string[] | undefined {
  if (input == null) return undefined;
  if (!Array.isArray(input)) {
    throw new Error(`${context} must be a list of strings`);
  }
  return input
    .map((value, idx) => asString(value, `${context}[${idx}]`))
    .filter(Boolean);
}

function asOptionalFiniteNumber(
  input: unknown,
  context: string,
): number | undefined {
  if (input == null || input === "") return undefined;
  const value = Number(input);
  if (!Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
  return value;
}

function normalizeViewerFileType(value: string, context: string): string {
  const ext = `${value ?? ""}`.trim().toLowerCase();
  if (!ext) {
    throw new Error(`${context} must be a non-empty file extension`);
  }
  const normalized = ext.startsWith(".") ? ext : `.${ext}`;
  if (!/^\.[a-z0-9._+-]+$/i.test(normalized)) {
    throw new Error(`${context} must be a simple file extension`);
  }
  return normalized;
}

export function normalizePublicViewerFileTypes(input: unknown): string[] {
  const values = Array.isArray(input)
    ? input
    : [...PUBLIC_VIEWER_DEFAULT_FILE_TYPES];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let idx = 0; idx < values.length; idx++) {
    const ext = normalizeViewerFileType(
      `${values[idx] ?? ""}`,
      `public viewer file_types[${idx}]`,
    );
    if (seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out.length > 0 ? out : [...PUBLIC_VIEWER_DEFAULT_FILE_TYPES];
}

export function isPublicViewerRenderablePath(
  entryPath: string,
  opts?: { file_types?: string[] },
): boolean {
  const fileTypes = new Set(
    normalizePublicViewerFileTypes(opts?.file_types).map((ext) =>
      ext.toLowerCase(),
    ),
  );
  return fileTypes.has(path.posix.extname(entryPath).toLowerCase());
}

export function publicViewerHtmlForPath(
  entryPath: string,
  viewer_bundle?: string,
): string {
  const override = `${viewer_bundle ?? ""}`.trim();
  if (override) {
    const normalized = override.endsWith(".html")
      ? override
      : `${override}.html`;
    if (!/^[a-z0-9-]+\.html$/i.test(normalized)) {
      throw new Error(
        "public viewer bundle override must be a simple html name",
      );
    }
    return normalized;
  }
  return (
    PUBLIC_VIEWER_HTML_BY_EXT[path.posix.extname(entryPath).toLowerCase()] ??
    "public-viewer.html"
  );
}

function inferPublicViewerEntryType(entryPath: string): string {
  switch (path.posix.extname(entryPath).toLowerCase()) {
    case ".md":
      return "markdown";
    case ".ipynb":
      return "notebook";
    case ".slides":
      return "slides";
    case ".board":
      return "board";
    case ".chat":
    case ".sage-chat":
      return "chat";
    default:
      return "file";
  }
}

function normalizeRenderMode(
  input: unknown,
  entryPath: string,
  supportedFileTypes: Set<string>,
): PublicViewerEntryRenderMode {
  const ext = path.posix.extname(entryPath).toLowerCase();
  const defaultMode: PublicViewerEntryRenderMode = supportedFileTypes.has(ext)
    ? "viewer"
    : "raw";
  const value = asOptionalString(input)?.toLowerCase();
  if (!value) return defaultMode;
  if (value === "hidden" || value === "raw") return value;
  if (value === "viewer") {
    return supportedFileTypes.has(ext) ? "viewer" : "raw";
  }
  throw new Error(
    `public viewer manifest render '${input}' must be one of viewer, raw, hidden`,
  );
}

export function parsePublicViewerManifest(
  raw: string,
  opts?: { file_types?: string[] },
): PublicViewerManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`public viewer manifest is invalid JSON: ${err}`);
  }
  const manifest = asObject(parsed, "public viewer manifest");
  const version = Number(manifest.version);
  if (version !== 1) {
    throw new Error("public viewer manifest version must be 1");
  }
  if (manifest.kind !== PUBLIC_VIEWER_MANIFEST_KIND) {
    throw new Error(
      `public viewer manifest kind must be '${PUBLIC_VIEWER_MANIFEST_KIND}'`,
    );
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error("public viewer manifest entries must be a list");
  }
  const supportedFileTypes = new Set(
    normalizePublicViewerFileTypes(opts?.file_types).map((ext) =>
      ext.toLowerCase(),
    ),
  );
  const entries = manifest.entries.map(
    (entry, idx): PublicViewerManifestEntry => {
      const item = asObject(entry, `public viewer manifest entries[${idx}]`);
      const entryPath = asString(
        item.path,
        `public viewer manifest entries[${idx}].path`,
      ).replace(/\\/g, "/");
      const normalizedPath = path.posix.normalize(entryPath);
      if (
        normalizedPath === "." ||
        normalizedPath.startsWith("../") ||
        normalizedPath.includes("/../")
      ) {
        throw new Error(
          `public viewer manifest entries[${idx}].path must stay within the static root`,
        );
      }
      return {
        path: normalizedPath,
        title: asOptionalString(item.title),
        description: asOptionalString(item.description),
        type:
          asOptionalString(item.type) ??
          inferPublicViewerEntryType(normalizedPath),
        render: normalizeRenderMode(
          item.render,
          normalizedPath,
          supportedFileTypes,
        ),
        order: asOptionalFiniteNumber(
          item.order,
          `public viewer manifest entries[${idx}].order`,
        ),
        tags: asOptionalStringArray(
          item.tags,
          `public viewer manifest entries[${idx}].tags`,
        ),
      };
    },
  );

  const theme =
    manifest.theme == null
      ? undefined
      : {
          layout: asOptionalString(
            asObject(manifest.theme, "public viewer manifest theme").layout,
          ),
          accent_color: asOptionalString(
            asObject(manifest.theme, "public viewer manifest theme")
              .accent_color,
          ),
        };

  return {
    version: 1,
    kind: PUBLIC_VIEWER_MANIFEST_KIND,
    title: asOptionalString(manifest.title),
    description: asOptionalString(manifest.description),
    theme,
    entries,
  };
}

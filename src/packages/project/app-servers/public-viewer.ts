/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import * as path from "node:path";

export const COCALC_PUBLIC_VIEWER_MODE = "cocalc-public-viewer" as const;
export const PUBLIC_VIEWER_DEFAULT_FILE_TYPES = [
  ".md",
  ".ipynb",
  ".slides",
  ".board",
] as const;
export const PUBLIC_VIEWER_DEFAULT_MANIFEST = "index.json" as const;
export const PUBLIC_VIEWER_DEFAULT_DIRECTORY_LISTING = "manifest-only" as const;
export const PUBLIC_VIEWER_MANIFEST_KIND =
  "cocalc-public-viewer-index" as const;

export type AppStaticIntegrationMode = typeof COCALC_PUBLIC_VIEWER_MODE;
export type PublicViewerDirectoryListingPolicy =
  typeof PUBLIC_VIEWER_DEFAULT_DIRECTORY_LISTING;
export type PublicViewerEntryRenderMode = "viewer" | "raw" | "hidden";

export interface AppStaticPublicViewerIntegrationSpec {
  mode: typeof COCALC_PUBLIC_VIEWER_MODE;
  file_types: string[];
  viewer_bundle?: string;
  auto_refresh_s: number;
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

function asOptionalNonNegativeInt(
  input: unknown,
  context: string,
): number | undefined {
  if (input == null || input === "") return undefined;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${context} must be a non-negative integer`);
  }
  return value;
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
    const value = values[idx];
    const ext = normalizeViewerFileType(
      `${value ?? ""}`,
      `public viewer file_types[${idx}]`,
    );
    if (seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out.length > 0 ? out : [...PUBLIC_VIEWER_DEFAULT_FILE_TYPES];
}

function normalizeRelativePath(value: string, context: string): string {
  const trimmed = `${value ?? ""}`.trim().replace(/\\/g, "/");
  if (!trimmed) {
    throw new Error(`${context} must be a non-empty relative path`);
  }
  if (trimmed.startsWith("/")) {
    throw new Error(`${context} must be relative to the static root`);
  }
  const normalized = path.posix.normalize(trimmed);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`${context} must stay within the static root`);
  }
  return normalized;
}

export function normalizePublicViewerManifestPath(input: unknown): string {
  return normalizeRelativePath(
    asOptionalString(input) ?? PUBLIC_VIEWER_DEFAULT_MANIFEST,
    "public viewer manifest",
  );
}

export function normalizeStaticIntegration(
  input: unknown,
  context = "spec.integration",
): AppStaticIntegrationSpec | undefined {
  if (input == null) return undefined;
  const integration = asObject(input, context);
  const mode = asString(integration.mode, `${context}.mode`);
  if (mode !== COCALC_PUBLIC_VIEWER_MODE) {
    throw new Error(`unsupported ${context}.mode '${integration.mode}'`);
  }
  const directoryListingRaw =
    asOptionalString(integration.directory_listing) ??
    PUBLIC_VIEWER_DEFAULT_DIRECTORY_LISTING;
  if (directoryListingRaw !== PUBLIC_VIEWER_DEFAULT_DIRECTORY_LISTING) {
    throw new Error(
      `${context}.directory_listing must be '${PUBLIC_VIEWER_DEFAULT_DIRECTORY_LISTING}'`,
    );
  }
  return {
    mode: COCALC_PUBLIC_VIEWER_MODE,
    file_types: normalizePublicViewerFileTypes(integration.file_types),
    viewer_bundle: asOptionalString(integration.viewer_bundle),
    auto_refresh_s:
      asOptionalNonNegativeInt(
        integration.auto_refresh_s,
        `${context}.auto_refresh_s`,
      ) ?? 0,
    manifest: normalizePublicViewerManifestPath(integration.manifest),
    directory_listing: PUBLIC_VIEWER_DEFAULT_DIRECTORY_LISTING,
  };
}

export function inferPublicViewerEntryType(entryPath: string): string {
  switch (path.posix.extname(entryPath).toLowerCase()) {
    case ".md":
      return "markdown";
    case ".ipynb":
      return "notebook";
    case ".slides":
      return "slides";
    case ".board":
      return "board";
    default:
      return "file";
  }
}

function normalizePublicViewerRenderMode(
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
  if (value === "hidden") return "hidden";
  if (value === "raw") return "raw";
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
    throw new Error(`invalid public viewer manifest JSON - ${err}`);
  }
  const obj = asObject(parsed, "public viewer manifest");
  const version = Number(obj.version ?? 1);
  if (version !== 1) {
    throw new Error(
      `public viewer manifest version must be 1, got '${obj.version}'`,
    );
  }
  if (
    (obj.kind ?? PUBLIC_VIEWER_MANIFEST_KIND) !== PUBLIC_VIEWER_MANIFEST_KIND
  ) {
    throw new Error(
      `public viewer manifest kind must be '${PUBLIC_VIEWER_MANIFEST_KIND}'`,
    );
  }
  if (!Array.isArray(obj.entries)) {
    throw new Error("public viewer manifest entries must be a list");
  }
  const supportedFileTypes = new Set(
    normalizePublicViewerFileTypes(opts?.file_types),
  );
  const themeIn =
    obj.theme == null ? undefined : asObject(obj.theme, "public viewer theme");
  const theme =
    themeIn == null
      ? undefined
      : {
          layout: asOptionalString(themeIn.layout),
          accent_color: asOptionalString(themeIn.accent_color),
        };
  const entries: PublicViewerManifestEntry[] = obj.entries.map(
    (entry, idx): PublicViewerManifestEntry => {
      const item = asObject(entry, `public viewer manifest entries[${idx}]`);
      const entryPath = normalizeRelativePath(
        asString(item.path, `public viewer manifest entries[${idx}].path`),
        `public viewer manifest entries[${idx}].path`,
      );
      return {
        path: entryPath,
        title: asOptionalString(item.title),
        description: asOptionalString(item.description),
        type:
          asOptionalString(item.type) ?? inferPublicViewerEntryType(entryPath),
        render: normalizePublicViewerRenderMode(
          item.render,
          entryPath,
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
  return {
    version: 1,
    kind: PUBLIC_VIEWER_MANIFEST_KIND,
    title: asOptionalString(obj.title),
    description: asOptionalString(obj.description),
    theme,
    entries,
  };
}

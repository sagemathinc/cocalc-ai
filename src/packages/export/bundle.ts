import { normalizeExportManifest, type ExportManifest } from "./manifest";

export type ExportContent = string | Uint8Array;

export interface ExportFile {
  path: string;
  content: ExportContent;
  contentType?: string;
}

export interface ExportAsset {
  originalRef: string;
  path: string;
  sha256: string;
  content: Uint8Array;
  contentType?: string;
}

export interface ExportBundle {
  manifest: ExportManifest;
  files: ExportFile[];
  assets?: ExportAsset[];
  rootDir?: string;
}

function normalizePath(path: string): string {
  const trimmed = `${path ?? ""}`.trim().replace(/\\/g, "/");
  const collapsed = trimmed.replace(/\/+/g, "/");
  if (!collapsed || collapsed === ".") {
    throw new Error("export path must be non-empty");
  }
  if (collapsed.startsWith("/") || collapsed.startsWith("../")) {
    throw new Error(`export path must be relative: ${path}`);
  }
  if (collapsed.includes("/../") || collapsed === "..") {
    throw new Error(`export path must not escape the bundle root: ${path}`);
  }
  return collapsed.replace(/^\.\//, "");
}

function assertUniquePaths(paths: string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      throw new Error(`duplicate export path: ${path}`);
    }
    seen.add(path);
  }
}

function prefixBundlePath(rootDir: string | undefined, path: string): string {
  if (!rootDir) return path;
  return `${rootDir}/${path}`;
}

export function normalizeExportBundle(bundle: ExportBundle): ExportBundle {
  const manifest = normalizeExportManifest(bundle.manifest);
  const rootDir = bundle.rootDir ? normalizePath(bundle.rootDir) : undefined;
  const files = (bundle.files ?? []).map((file) => ({
    ...file,
    path: normalizePath(file.path),
  }));
  const assets = (bundle.assets ?? []).map((asset) => ({
    ...asset,
    path: normalizePath(asset.path),
  }));
  assertUniquePaths([
    prefixBundlePath(rootDir, "manifest.json"),
    ...files.map((file) => prefixBundlePath(rootDir, file.path)),
    ...assets.map((asset) => prefixBundlePath(rootDir, asset.path)),
  ]);
  return { manifest, files, assets, rootDir };
}

export function bundleEntries(
  bundle: ExportBundle,
): Array<{ path: string; content: ExportContent }> {
  const normalized = normalizeExportBundle(bundle);
  return [
    {
      path: prefixBundlePath(normalized.rootDir, "manifest.json"),
      content: `${JSON.stringify(normalized.manifest, null, 2)}\n`,
    },
    ...normalized.files.map(({ path, content }) => ({
      path: prefixBundlePath(normalized.rootDir, path),
      content,
    })),
    ...(normalized.assets ?? []).map(({ path, content }) => ({
      path: prefixBundlePath(normalized.rootDir, path),
      content,
    })),
  ];
}

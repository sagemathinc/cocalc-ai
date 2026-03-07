import { readFile, stat } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import { strFromU8, unzipSync } from "fflate";

export interface LoadedExportBundleSource {
  manifest: Record<string, any>;
  rootDir?: string;
  listFiles(): string[];
  readText(relativePath: string): Promise<string>;
  readBytes(relativePath: string): Promise<Uint8Array>;
}

export async function loadExportBundleSource(
  sourcePath: string,
): Promise<LoadedExportBundleSource> {
  const info = await stat(sourcePath);
  if (info.isDirectory()) {
    return await loadBundleDirectory(sourcePath);
  }
  return await loadBundleZip(sourcePath);
}

async function loadBundleDirectory(
  rootPath: string,
): Promise<LoadedExportBundleSource> {
  const manifestRaw = await readFile(join(rootPath, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw);
  return {
    manifest,
    rootDir: undefined,
    listFiles: () => ["manifest.json"],
    readText: async (relativePath: string) =>
      await readFile(join(rootPath, relativePath), "utf8"),
    readBytes: async (relativePath: string) =>
      new Uint8Array(await readFile(join(rootPath, relativePath))),
  };
}

async function loadBundleZip(
  zipPath: string,
): Promise<LoadedExportBundleSource> {
  const bytes = new Uint8Array(await readFile(zipPath));
  const files = unzipSync(bytes);
  const manifestPath = resolveManifestPath(Object.keys(files));
  if (manifestPath == null) {
    throw new Error(`bundle at ${zipPath} does not contain manifest.json`);
  }
  const rootDir = dirname(manifestPath) === "." ? undefined : dirname(manifestPath);
  const manifest = JSON.parse(strFromU8(files[manifestPath]));
  return {
    manifest,
    rootDir,
    listFiles: () => Object.keys(files),
    readText: async (relativePath: string) => {
      const entry = files[toBundleEntryPath(relativePath, rootDir)];
      if (entry == null) {
        throw new Error(`bundle is missing ${relativePath}`);
      }
      return strFromU8(entry);
    },
    readBytes: async (relativePath: string) => {
      const entry = files[toBundleEntryPath(relativePath, rootDir)];
      if (entry == null) {
        throw new Error(`bundle is missing ${relativePath}`);
      }
      return entry;
    },
  };
}

function resolveManifestPath(paths: string[]): string | undefined {
  if (paths.includes("manifest.json")) return "manifest.json";
  const candidates = paths
    .filter((path) => path.endsWith("/manifest.json"))
    .sort((a, b) => a.length - b.length);
  return candidates[0];
}

function toBundleEntryPath(relativePath: string, rootDir?: string): string {
  const normalized = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(posix.sep);
  return rootDir ? posix.join(rootDir, normalized) : normalized;
}

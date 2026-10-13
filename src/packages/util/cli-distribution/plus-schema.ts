/*
 * CoCalc Plus (cocalc-lite) releases, distribution Phase A.
 *
 * Same machinery as the CLI (see ./schema.ts): a strict, canonical manifest
 * that names every byte by size and sha256, a pinned Node per platform, a
 * launcher and a bootstrap. A Plus release has more parts than the CLI's one
 * bundle file, each a zstd-compressed tar:
 *   - app/<platform>: the Lite bundle with that platform's native modules;
 *   - tools/<platform>: rg, fd and ouch;
 *   - static and public: the frontend and its assets, the same on every
 *     platform, and reused across releases when unchanged.
 * Releases are served from software.cocalc.ai (no hub involved), so the
 * client reads the store layout directly: current.json, manifests/<sha>.json
 * and files/<sha>.
 */

import {
  CLI_PLATFORMS,
  type CliPlatform,
  type FileRef,
  GIT,
  MAX_BOOTSTRAP_BYTES,
  MAX_LAUNCHER_BYTES,
  MAX_MANIFEST_BYTES,
  type NodeArchive,
  VERSION,
  exactKeys,
  fail,
  fileRef,
  isRelease,
  object,
  parseJson,
  parseNodeSection,
  str,
} from "./schema";

export const PLUS_MANIFEST_SCHEMA = "cocalc-plus-release/1";

// Unpacked, these are large (the Lite bundle is about 170 MB); compressed
// they are each a few tens of MB.
export const MAX_PLUS_PART_BYTES = 256 * 1024 * 1024;

export interface PlusReleaseManifest {
  schema: typeof PLUS_MANIFEST_SCHEMA;
  release: number;
  version: string;
  git: string;
  built_at: string;
  launcher: FileRef;
  bootstrap: FileRef;
  node: {
    version: string;
    platforms: Partial<Record<CliPlatform, NodeArchive>>;
  };
  app: Partial<Record<CliPlatform, FileRef>>;
  tools: Partial<Record<CliPlatform, FileRef>>;
  static: FileRef;
  public: FileRef;
}

const KEYS = [
  "schema",
  "release",
  "version",
  "git",
  "built_at",
  "launcher",
  "bootstrap",
  "node",
  "app",
  "tools",
  "static",
  "public",
] as const;

function platformParts(
  value: unknown,
  what: string,
): Partial<Record<CliPlatform, FileRef>> {
  const o = object(value, what);
  const parts: Partial<Record<CliPlatform, FileRef>> = {};
  for (const [key, ref] of Object.entries(o)) {
    if (!(CLI_PLATFORMS as readonly string[]).includes(key)) {
      fail(`unknown platform "${key}" in ${what}`);
    }
    parts[key as CliPlatform] = fileRef(
      ref,
      `${what}.${key}`,
      MAX_PLUS_PART_BYTES,
    );
  }
  return parts;
}

export function parsePlusManifest(text: string): PlusReleaseManifest {
  const o = object(
    parseJson(text, MAX_MANIFEST_BYTES, "manifest", true),
    "manifest",
  );
  exactKeys(o, KEYS, "manifest");
  if (o.schema !== PLUS_MANIFEST_SCHEMA) fail("manifest.schema");
  if (!isRelease(o.release)) fail("manifest.release");
  const node = parseNodeSection(o.node);
  const app = platformParts(o.app, "app");
  const tools = platformParts(o.tools, "tools");
  for (const platform of Object.keys(app) as CliPlatform[]) {
    if (node.platforms[platform] == null) {
      fail(`app for ${platform} has no Node`);
    }
  }
  if (Object.keys(app).length === 0) fail("no app platforms");
  return {
    schema: PLUS_MANIFEST_SCHEMA,
    release: o.release,
    version: str(o.version, "manifest.version", VERSION),
    git: str(o.git, "manifest.git", GIT),
    built_at: str(o.built_at, "manifest.built_at", /^[0-9TZ:.+-]{10,40}$/),
    launcher: fileRef(o.launcher, "launcher", MAX_LAUNCHER_BYTES),
    bootstrap: fileRef(o.bootstrap, "bootstrap", MAX_BOOTSTRAP_BYTES),
    node,
    app,
    tools,
    static: fileRef(o.static, "static", MAX_PLUS_PART_BYTES),
    public: fileRef(o.public, "public", MAX_PLUS_PART_BYTES),
  };
}

// Every file a Plus manifest makes downloadable, with its size.
export function plusManifestFiles(
  manifest: PlusReleaseManifest,
): Map<string, { size: number; upstream?: string }> {
  const files = new Map<string, { size: number; upstream?: string }>();
  const add = (ref?: FileRef) =>
    ref && files.set(ref.sha256, { size: ref.size });
  add(manifest.launcher);
  add(manifest.bootstrap);
  add(manifest.static);
  add(manifest.public);
  for (const ref of Object.values(manifest.app)) add(ref);
  for (const ref of Object.values(manifest.tools)) add(ref);
  for (const archive of Object.values(manifest.node.platforms)) {
    if (archive)
      files.set(archive.sha256, { size: archive.size, upstream: archive.url });
  }
  return files;
}

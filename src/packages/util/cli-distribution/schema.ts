/*
 * CLI distribution, Phase A: the formats shared by the release tooling, the
 * hub that serves releases under its own origin, and the installed CLI.
 *
 * A release is a manifest naming every byte that executes (the launcher, the
 * bootstrap, the bundle and a pinned Node archive per platform), each by size
 * and sha256. Releases are unsigned in Phase A: the client trusts the origin
 * it installed from (see src/.agents/cli-distribution-2026-10-12.md).
 */

export const MANIFEST_SCHEMA = "cocalc-cli-release/1";
export const POINTER_SCHEMA = "cocalc-cli-current/1";
export const SITE_SCHEMA = "cocalc-cli-site/1";

export const CLI_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "darwin-x64",
] as const;
export type CliPlatform = (typeof CLI_PLATFORMS)[number];

// Size caps: every download and parse is bounded.
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_POINTER_BYTES = 4 * 1024;
export const MAX_LAUNCHER_BYTES = 64 * 1024;
export const MAX_BOOTSTRAP_BYTES = 256 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_NODE_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_NODE_BINARY_BYTES = 512 * 1024 * 1024;

export interface FileRef {
  sha256: string;
  size: number;
}

export interface NodeArchive extends FileRef {
  // Where the release store (or the hub) fetches it from, e.g. nodejs.org.
  // Clients never use it: they download /cli/files/<sha256> from their origin.
  url: string;
  // The top-level directory inside the archive, e.g. node-v26.11.1-linux-x64.
  dir: string;
  // The extracted bin/node, so an installed runtime can be checked before
  // it is reused.
  binary: FileRef;
}

export interface CliReleaseManifest {
  schema: typeof MANIFEST_SCHEMA;
  // Monotonic per origin. One release number names exactly one manifest.
  release: number;
  version: string;
  git: string;
  built_at: string;
  launcher: FileRef;
  bootstrap: FileRef;
  bundle: FileRef;
  node: {
    version: string;
    platforms: Partial<Record<CliPlatform, NodeArchive>>;
  };
}

// The single origin-wide pointer in a release store (current.json).
export interface CliCurrentPointer {
  schema: typeof POINTER_SCHEMA;
  release: number;
  manifest: string; // sha256 of the manifest bytes
  // Advisory: current clients below this release update (or stop with a
  // clear message) before talking to the site. Older clients don't know it.
  // null when the site has no minimum.
  min_release: number | null;
  published_at: string;
}

// What a hub serves at /cli/site.json.
export interface CliSiteInfo {
  schema: typeof SITE_SCHEMA;
  release: number;
  manifest: string;
  min_release: number | null;
}

const SHA256 = /^[0-9a-f]{64}$/;
export const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
export const GIT = /^[0-9a-f]{7,40}(-dirty)?$|^unknown$/;
const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const NODE_DIR = /^node-v\d{1,3}\.\d{1,3}\.\d{1,3}-[a-z0-9-]{1,32}$/;

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

export function isRelease(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function fail(what: string): never {
  throw new Error(`invalid CLI release data: ${what}`);
}

export function object(value: unknown, what: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function str(value: unknown, what: string, re: RegExp): string {
  if (typeof value !== "string" || !re.test(value)) fail(what);
  return value;
}

// Schema /1 is strict: unknown keys are rejected. Extensions need a new
// schema version.
export function exactKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) fail(`${what} has an unknown key "${key}"`);
  }
}

export function fileRef(value: unknown, what: string, max: number): FileRef {
  const o = object(value, what);
  exactKeys(o, ["sha256", "size"], what);
  if (!isSha256(o.sha256)) fail(`${what}.sha256`);
  if (
    typeof o.size !== "number" ||
    !Number.isSafeInteger(o.size) ||
    o.size <= 0 ||
    o.size > max
  ) {
    fail(`${what}.size`);
  }
  return { sha256: o.sha256, size: o.size };
}

/*
 * Every format has one canonical serialization: manifests and pointers are
 * JSON.stringify(value, null, 2) + "\n", site.json is JSON.stringify(value).
 * Requiring it rejects duplicate keys (JSON.parse would silently keep the
 * last one) and anything else that could make two readers disagree.
 */
export function canonicalJson(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) + "\n" : JSON.stringify(value);
}

export function parseJson(
  text: string,
  max: number,
  what: string,
  pretty: boolean,
): unknown {
  if (Buffer.byteLength(text) > max) fail(`${what} is too large`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${what} is not JSON`);
  }
  if (canonicalJson(value, pretty) !== text) {
    fail(`${what} is not in canonical form (duplicate keys?)`);
  }
  return value;
}

const MANIFEST_KEYS = [
  "schema",
  "release",
  "version",
  "git",
  "built_at",
  "launcher",
  "bootstrap",
  "bundle",
  "node",
] as const;

export function parseNodeSection(value: unknown): CliReleaseManifest["node"] {
  const node = object(value, "manifest.node");
  exactKeys(node, ["version", "platforms"], "manifest.node");
  const platforms = object(node.platforms, "manifest.node.platforms");
  const parsedPlatforms: Partial<Record<CliPlatform, NodeArchive>> = {};
  for (const [key, value] of Object.entries(platforms)) {
    if (!(CLI_PLATFORMS as readonly string[]).includes(key)) {
      fail(`unknown platform "${key}"`);
    }
    const v = object(value, `node.${key}`);
    exactKeys(v, ["sha256", "size", "url", "dir", "binary"], `node.${key}`);
    const { sha256, size } = fileRef(
      { sha256: v.sha256, size: v.size },
      `node.${key}`,
      MAX_NODE_ARCHIVE_BYTES,
    );
    const url = str(v.url, `node.${key}.url`, /^https?:\/\/\S{1,2000}$/);
    const dir = str(v.dir, `node.${key}.dir`, NODE_DIR);
    const binary = fileRef(
      v.binary,
      `node.${key}.binary`,
      MAX_NODE_BINARY_BYTES,
    );
    parsedPlatforms[key as CliPlatform] = { sha256, size, url, dir, binary };
  }
  if (Object.keys(parsedPlatforms).length === 0) fail("no node platforms");
  return {
    version: str(node.version, "manifest.node.version", NODE_VERSION),
    platforms: parsedPlatforms,
  };
}

export function parseManifest(text: string): CliReleaseManifest {
  const o = object(
    parseJson(text, MAX_MANIFEST_BYTES, "manifest", true),
    "manifest",
  );
  exactKeys(o, MANIFEST_KEYS, "manifest");
  if (o.schema !== MANIFEST_SCHEMA) fail("manifest.schema");
  if (!isRelease(o.release)) fail("manifest.release");
  const node = parseNodeSection(o.node);
  return {
    schema: MANIFEST_SCHEMA,
    release: o.release,
    version: str(o.version, "manifest.version", VERSION),
    git: str(o.git, "manifest.git", GIT),
    built_at: str(o.built_at, "manifest.built_at", /^[0-9TZ:.+-]{10,40}$/),
    launcher: fileRef(o.launcher, "launcher", MAX_LAUNCHER_BYTES),
    bootstrap: fileRef(o.bootstrap, "bootstrap", MAX_BOOTSTRAP_BYTES),
    bundle: fileRef(o.bundle, "bundle", MAX_BUNDLE_BYTES),
    node,
  };
}

function minRelease(value: unknown, release: number): number | null {
  if (value == null) return null;
  if (!isRelease(value) || value > release) fail("min_release");
  return value;
}

export function parsePointer(text: string): CliCurrentPointer {
  const o = object(
    parseJson(text, MAX_POINTER_BYTES, "pointer", true),
    "pointer",
  );
  exactKeys(
    o,
    ["schema", "release", "manifest", "min_release", "published_at"],
    "pointer",
  );
  if (o.schema !== POINTER_SCHEMA) fail("pointer.schema");
  if (!isRelease(o.release)) fail("pointer.release");
  if (!isSha256(o.manifest)) fail("pointer.manifest");
  return {
    schema: POINTER_SCHEMA,
    release: o.release,
    manifest: o.manifest,
    min_release: minRelease(o.min_release, o.release),
    published_at: str(o.published_at, "pointer.published_at", /^\S{1,40}$/),
  };
}

export function parseSiteInfo(text: string): CliSiteInfo {
  const o = object(
    parseJson(text, MAX_POINTER_BYTES, "site.json", false),
    "site",
  );
  exactKeys(o, ["schema", "release", "manifest", "min_release"], "site");
  if (o.schema !== SITE_SCHEMA) fail("site.schema");
  if (!isRelease(o.release)) fail("site.release");
  if (!isSha256(o.manifest)) fail("site.manifest");
  return {
    schema: SITE_SCHEMA,
    release: o.release,
    manifest: o.manifest,
    min_release: minRelease(o.min_release, o.release),
  };
}

// The hashes a manifest makes downloadable, with their size caps.
export function manifestFiles(
  manifest: CliReleaseManifest,
): Map<string, { size: number; upstream?: string }> {
  const files = new Map<string, { size: number; upstream?: string }>();
  for (const ref of [manifest.launcher, manifest.bootstrap, manifest.bundle]) {
    files.set(ref.sha256, { size: ref.size });
  }
  for (const archive of Object.values(manifest.node.platforms)) {
    if (archive == null) continue;
    files.set(archive.sha256, { size: archive.size, upstream: archive.url });
  }
  return files;
}

/*
 * The local `active` pointer: exactly `v1 <R> <N> <B> <C>\n`, where R is the
 * manifest's sha256, N the Node archive's, B the bootstrap's and C the
 * bundle's. The launcher (POSIX sh) checks the same grammar.
 */
export interface ActivePointer {
  manifest: string;
  node: string;
  bootstrap: string;
  bundle: string;
}

export const ACTIVE_LINE_BYTES = 2 + 4 * 65 + 1;

export function formatActiveLine(active: ActivePointer): string {
  const { manifest, node, bootstrap, bundle } = active;
  for (const value of [manifest, node, bootstrap, bundle]) {
    if (!isSha256(value)) fail("active pointer hash");
  }
  return `v1 ${manifest} ${node} ${bootstrap} ${bundle}\n`;
}

export function parseActiveLine(text: string): ActivePointer {
  if (text.length !== ACTIVE_LINE_BYTES || !text.endsWith("\n")) {
    fail("active pointer length");
  }
  const parts = text.slice(0, -1).split(" ");
  if (parts.length !== 5 || parts[0] !== "v1") fail("active pointer format");
  const [, manifest, node, bootstrap, bundle] = parts;
  for (const value of [manifest, node, bootstrap, bundle]) {
    if (!isSha256(value)) fail("active pointer hash");
  }
  return { manifest, node, bootstrap, bundle };
}

export function currentPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): CliPlatform | undefined {
  const value = `${platform}-${arch}`;
  return (CLI_PLATFORMS as readonly string[]).includes(value)
    ? (value as CliPlatform)
    : undefined;
}

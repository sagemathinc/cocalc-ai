/*
 * The CLI releases a hub serves under its own origin (distribution Phase A).
 *
 * The hub reads one release store: by default the official one behind
 * software.cocalc.ai, or a directory (dev and self-hosted sites building
 * their own CLI), set with COCALC_CLI_RELEASE_SOURCE. Every bay of a site
 * reads the same store, so its current.json is the single origin-wide pointer.
 *
 * Nothing is served unverified: manifests must hash to the name they're
 * requested by, and a file is served only if the requested manifest lists it
 * and its bytes match the listed size and sha256. A file is verified through
 * the open handle that is then served, so it can't change in between. The
 * release store's own URLs are fetched without following redirects; only
 * a Node archive's pinned upstream may redirect (its hash is pinned).
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type CliReleaseManifest,
  type CliSiteInfo,
  MAX_MANIFEST_BYTES,
  MAX_POINTER_BYTES,
  SITE_SCHEMA,
  isSha256,
  manifestFiles,
  parseManifest,
  parsePointer,
} from "@cocalc/util/cli-distribution/schema";

export const DEFAULT_RELEASE_BASE = "https://software.cocalc.ai/software/cli";
const POINTER_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const FILE_TIMEOUT_MS = 300_000;
const MAX_CACHED_MANIFESTS = 32;
const MAX_CACHED_FILES = 24;

export type ReleaseSource =
  | { kind: "dir"; dir: string }
  | { kind: "url"; base: string };

export function configuredReleaseSource(
  env: NodeJS.ProcessEnv = process.env,
): ReleaseSource | undefined {
  const value = `${env.COCALC_CLI_RELEASE_SOURCE ?? ""}`.trim();
  if (value === "off") return undefined;
  if (/^https?:\/\//.test(value)) {
    return { kind: "url", base: value.replace(/\/+$/, "") };
  }
  if (value) return { kind: "dir", dir: resolve(value) };
  if (env.NODE_ENV === "production" || `${env.COCALC_BAY_ID ?? ""}`.trim()) {
    return { kind: "url", base: DEFAULT_RELEASE_BASE };
  }
  // A dev checkout serves releases published locally with
  // `pnpm --dir src/packages/cli release:cli --dir build/cli-release-store`.
  const local = resolve(__dirname, "../../cli/build/cli-release-store");
  return existsSync(local) ? { kind: "dir", dir: local } : undefined;
}

export class NotFound extends Error {}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function fetchStore(
  url: string,
  timeoutMs: number,
  followRedirects = false,
): Promise<Response> {
  const response = await fetch(url, {
    redirect: followRedirects ? "follow" : "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `GET ${url}: redirected; the release store must not redirect`,
    );
  }
  return response;
}

async function fetchCapped(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer | undefined> {
  const response = await fetchStore(url, timeoutMs);
  if (response.status === 404) return undefined;
  if (!response.ok || response.body == null) {
    throw new Error(`GET ${url}: ${response.status}`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as any) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`GET ${url}: too large`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// An open, verified file; the caller serves it and closes the handle.
export interface ServableFile {
  handle: FileHandle;
  size: number;
}

// The identity of a file's bytes as far as the filesystem can tell.
function identity(info: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

export class CliReleases {
  private pointer?: { at: number; site: CliSiteInfo };
  private manifests = new Map<
    string,
    { text: string; manifest: CliReleaseManifest }
  >();
  // sha256 -> identity of a file whose bytes were verified.
  private verified = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();
  private cacheReady?: Promise<void>;
  readonly cacheDir: string;

  constructor(
    readonly source: ReleaseSource,
    opts: { cacheDir?: string } = {},
  ) {
    this.cacheDir =
      opts.cacheDir ??
      process.env.COCALC_CLI_RELEASE_CACHE_DIR ??
      join(tmpdir(), `cocalc-cli-release-cache-${process.getuid?.() ?? 0}`);
  }

  // The cache directory must be ours alone: a real directory (not a
  // symlink), owned by this process's user, with no group or other access.
  private async ensureCache(): Promise<void> {
    this.cacheReady ??= (async () => {
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const info = await lstat(this.cacheDir);
      const uid = process.getuid?.();
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (uid != null && info.uid !== uid) ||
        (info.mode & 0o077) !== 0
      ) {
        throw new Error(
          `${this.cacheDir} is not a private directory owned by this user; refusing to cache CLI files there`,
        );
      }
    })();
    try {
      await this.cacheReady;
    } catch (err) {
      this.cacheReady = undefined;
      throw err;
    }
  }

  private async read(
    name: string,
    maxBytes: number,
  ): Promise<Buffer | undefined> {
    if (this.source.kind === "dir") {
      const path = join(this.source.dir, ...name.split("/"));
      try {
        const info = await stat(path);
        if (info.size > maxBytes) throw new Error(`${name}: too large`);
        return await readFile(path);
      } catch (err: any) {
        if (err?.code === "ENOENT") return undefined;
        throw err;
      }
    }
    return await fetchCapped(
      `${this.source.base}/${name}`,
      maxBytes,
      FETCH_TIMEOUT_MS,
    );
  }

  async site(): Promise<CliSiteInfo> {
    const now = Date.now();
    if (this.pointer != null && now - this.pointer.at < POINTER_TTL_MS) {
      return this.pointer.site;
    }
    const bytes = await this.read("current.json", MAX_POINTER_BYTES);
    if (bytes == null) throw new NotFound("no CLI release is published");
    const pointer = parsePointer(bytes.toString("utf8"));
    const { manifest } = await this.manifest(pointer.manifest);
    if (manifest.release !== pointer.release) {
      throw new Error(
        `current.json names release ${pointer.release}, but its manifest is release ${manifest.release}`,
      );
    }
    const site: CliSiteInfo = {
      schema: SITE_SCHEMA,
      release: pointer.release,
      manifest: pointer.manifest,
      min_release: pointer.min_release,
    };
    this.pointer = { at: now, site };
    return site;
  }

  async manifest(
    hash: string,
  ): Promise<{ text: string; manifest: CliReleaseManifest }> {
    if (!isSha256(hash)) throw new NotFound("bad manifest name");
    const cached = this.manifests.get(hash);
    if (cached != null) return cached;
    const bytes = await this.read(`manifests/${hash}.json`, MAX_MANIFEST_BYTES);
    if (bytes == null) throw new NotFound("no such manifest");
    if (sha256(bytes) !== hash) {
      throw new Error(`manifest ${hash} does not match its hash`);
    }
    const text = bytes.toString("utf8");
    const entry = { text, manifest: parseManifest(text) };
    this.manifests.set(hash, entry);
    while (this.manifests.size > MAX_CACHED_MANIFESTS) {
      this.manifests.delete(this.manifests.keys().next().value!);
    }
    return entry;
  }

  // An open, verified handle for a file the given manifest lists.
  async file(manifestHash: string, fileHash: string): Promise<ServableFile> {
    if (!isSha256(fileHash)) throw new NotFound("bad file name");
    const { manifest } = await this.manifest(manifestHash);
    const entry = manifestFiles(manifest).get(fileHash);
    if (entry == null) throw new NotFound("not part of this release");
    if (this.source.kind === "dir") {
      const path = join(this.source.dir, "files", fileHash);
      const local = await this.openVerified(path, fileHash, entry.size);
      if (local != null) return local;
    }
    await this.ensureCache();
    const cached = join(this.cacheDir, fileHash);
    const hit = await this.openVerified(cached, fileHash, entry.size);
    if (hit != null) return hit;
    let pending = this.inflight.get(fileHash);
    if (pending == null) {
      pending = this.fetchToCache(fileHash, entry).finally(() =>
        this.inflight.delete(fileHash),
      );
      this.inflight.set(fileHash, pending);
    }
    const path = await pending;
    const fetched = await this.openVerified(path, fileHash, entry.size);
    if (fetched == null) throw new Error(`${fileHash}: cache write failed`);
    return fetched;
  }

  // Open a regular file (never through a symlink) and check its bytes, via
  // the same handle, against the expected size and hash. Undefined if it is
  // missing or doesn't match (a mismatched cache entry is removed).
  private async openVerified(
    path: string,
    hash: string,
    size: number,
  ): Promise<ServableFile | undefined> {
    let handle: FileHandle;
    try {
      const info = await lstat(path);
      if (!info.isFile()) return undefined;
      handle = await open(path, "r");
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      throw err;
    }
    try {
      const info = await handle.stat();
      const id = identity(info);
      if (info.size === size && this.verified.get(hash) === id) {
        return { handle, size };
      }
      if (info.size === size) {
        const digest = createHash("sha256");
        for await (const chunk of handle.createReadStream({
          start: 0,
          autoClose: false,
        })) {
          digest.update(chunk);
        }
        if (digest.digest("hex") === hash) {
          this.verified.set(hash, id);
          return { handle, size };
        }
      }
    } catch (err) {
      await handle.close();
      throw err;
    }
    await handle.close();
    if (path.startsWith(this.cacheDir)) await rm(path, { force: true });
    return undefined;
  }

  private async fetchToCache(
    hash: string,
    entry: { size: number; upstream?: string },
  ): Promise<string> {
    const target = join(this.cacheDir, hash);
    const urls: { url: string; follow: boolean }[] = [];
    if (this.source.kind === "url") {
      urls.push({ url: `${this.source.base}/files/${hash}`, follow: false });
    }
    if (entry.upstream) urls.push({ url: entry.upstream, follow: true });
    let lastError: unknown = new NotFound("file is not available");
    for (const { url, follow } of urls) {
      try {
        await this.download(url, target, hash, entry.size, follow);
        return target;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async download(
    url: string,
    target: string,
    hash: string,
    size: number,
    followRedirects: boolean,
  ): Promise<void> {
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const response = await fetchStore(url, FILE_TIMEOUT_MS, followRedirects);
    if (response.status === 404) throw new NotFound(`GET ${url}: 404`);
    if (!response.ok || response.body == null) {
      throw new Error(`GET ${url}: ${response.status}`);
    }
    const out = await open(temp, "wx", 0o600);
    const digest = createHash("sha256");
    let total = 0;
    try {
      for await (const chunk of response.body as any) {
        total += chunk.length;
        if (total > size) throw new Error(`GET ${url}: larger than listed`);
        digest.update(chunk);
        await out.write(chunk);
      }
      await out.sync();
    } catch (err) {
      await out.close();
      await unlink(temp).catch(() => {});
      throw err;
    }
    await out.close();
    if (total !== size || digest.digest("hex") !== hash) {
      await unlink(temp).catch(() => {});
      throw new Error(`GET ${url}: does not match its listed size and hash`);
    }
    await rename(temp, target);
    await this.prune();
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.cacheDir)).filter(isSha256);
    if (names.length <= MAX_CACHED_FILES) return;
    const entries = await Promise.all(
      names.map(async (name) => ({
        name,
        mtime: (await stat(join(this.cacheDir, name))).mtimeMs,
      })),
    );
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const { name } of entries.slice(0, names.length - MAX_CACHED_FILES)) {
      await rm(join(this.cacheDir, name), { force: true });
    }
  }
}

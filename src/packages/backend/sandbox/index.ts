/*
Given a path to a folder on the filesystem, this provides
a wrapper class with an API similar to the fs/promises modules,
but which only allows access to files in that folder.
It's a bit simpler with return data that is always
serializable.

Absolute and relative paths are considered as relative to the input folder path.

REFERENCE: We don't use https://github.com/metarhia/sandboxed-fs, but did
look at the code.

NOTE: Using `openat2`/`*at` descriptor-anchored operations for sandboxed path
resolution is a standard hardening pattern in container software, including
Docker and runc.

SECURITY:

The main race risk in this module is TOCTOU path replacement (especially
symlink swaps) between validation and filesystem operations.

Current status:

1. `readFile`/`writeFile`/`appendFile` in safe mode now use file descriptors,
   then verify `/proc/self/fd/<fd>` resolves inside the sandbox root before
   reading/writing.
2. This closes the most important content read/write race for existing files.
3. A create fast-path intentionally skips fd verification for brand new files
   to preserve watcher event ordering (`add`, then later `unlink`).

Remaining work:

- Some paths still fall back to Node path APIs when openat2 is unavailable
  (or for intentionally compatibility-preserving behavior), so those fallback
  paths must remain conservative and fail-closed.
- Full end-state is descriptor-anchored path resolution for all mutating ops
  (see [src/.agents/sandbox.md](./src/.agents/sandbox.md), task list SBOX-*).

*/

import {
  chmod,
  cp,
  constants,
  link,
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  mkdir,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import {
  close as closeFdCallback,
  readFile as readFileFdCallback,
  writeFile as writeFileFdCallback,
} from "node:fs";
import { createHash } from "node:crypto";
import { move } from "fs-extra";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { basename, dirname, join, resolve } from "path";
import { replace_all } from "@cocalc/util/misc";
import find, { type FindOptions } from "./find";
import ripgrep, { type RipgrepOptions } from "./ripgrep";
import fd, { type FdOptions } from "./fd";
import dust, { type DustOptions } from "./dust";
import rustic from "./rustic";
import { type ExecOutput } from "./exec";
import { rusticRepo, data } from "@cocalc/backend/data";
import ouch, { type OuchOptions } from "./ouch";
import cpExec from "./cp";
import {
  type CopyOptions,
  type PatchWriteRequest,
} from "@cocalc/conat/files/fs";
export { type CopyOptions };
import { ConatError } from "@cocalc/conat/core/client";
import getListing, { type Files } from "./get-listing";
import LRU from "lru-cache";
import TTL from "@isaacs/ttlcache";
import watch, { type WatchIterator, type WatchOptions } from "./watch";
import { sha1 } from "@cocalc/backend/sha1";
import { apply_patch, make_patch, type CompressedPatch } from "@cocalc/util/dmp";
import getLogger from "@cocalc/backend/logger";

import { SyncFsWatchStore } from "./sync-fs-watch";
export { SyncFsWatchStore };
import { SyncFsService } from "./sync-fs-service";
import { client_db } from "@cocalc/util/db-schema/client-db";

const logger = getLogger("sandbox:fs");
const OPENAT2_DISABLED = ["0", "false", "no", "off"].includes(
  (process.env.COCALC_SANDBOX_OPENAT2 ?? "").toLowerCase(),
);

interface OpenAt2SandboxRoot {
  mkdir(path: string, recursive?: boolean | null, mode?: number | null): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  rename(oldPath: string, newPath: string): void;
  renameNoReplace?(oldPath: string, newPath: string): void;
  link?(oldPath: string, newPath: string): void;
  symlink?(target: string, newPath: string): void;
  chmod(path: string, mode: number): void;
  truncate(path: string, len: number): void;
  copyFile(src: string, dest: string, mode?: number | null): void;
  openRead?(path: string): number;
  openWrite?(
    path: string,
    create?: boolean | null,
    truncate?: boolean | null,
    append?: boolean | null,
    mode?: number | null,
  ): number;
  rm?(path: string, recursive?: boolean | null, force?: boolean | null): void;
  utimes?(path: string, atimeNs: number, mtimeNs: number): void;
}

// max time code can run (in safe mode), e.g., for find,
// ripgrep, fd, and dust.
const MAX_TIMEOUT = 5_000;

// Maximum amount of memory for the "last value on disk" data, which
// supports a much better "sync with file state on disk" algorithm.
const MAX_LAST_ON_DISK = 50_000_000; // 50 MB
const LAST_ON_DISK_TTL = 1000 * 60 * 5; // 5 minutes

// when any frontend browser client saves a file to disk as part
// of a sync editing session, seeing the file change on disk to
// equal that exact value (sha1 hash) will NOT trigger a change
// event for several seconds.  This avoids some edge cases where
// you type a little, write something to disk, then type a little
// more and find that what you just types gets reset to what was
// on disk, or gets doubled (either way). Basically, this is a simple
// way to prevent all the "frequent save while editing" issues,
// while mostly still mostly allowing collaboration via disk with
// other editors (e.g., vscode).
const LAST_ON_DISK_TTL_HASH = 1000 * 15;

const readFileByFd = (
  fd: number,
  encoding?: any,
): Promise<string | Buffer> =>
  new Promise((resolve, reject) => {
    readFileFdCallback(fd, encoding as any, (err, data) => {
      if (err != null) {
        reject(err);
        return;
      }
      resolve(data as any);
    });
  });

const closeFd = (fd: number): Promise<void> =>
  new Promise((resolve, reject) => {
    closeFdCallback(fd, (err) => {
      if (err != null) {
        reject(err);
        return;
      }
      resolve();
    });
  });

const writeFileByFd = (
  fd: number,
  data: string | Buffer,
  options?: any,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const cb = (err: NodeJS.ErrnoException | null) => {
      if (err != null) {
        reject(err);
        return;
      }
      resolve();
    };
    if (options === undefined) {
      (writeFileFdCallback as any)(fd, data as any, cb);
      return;
    }
    (writeFileFdCallback as any)(fd, data as any, options as any, cb);
  });

const toTimespecNs = (value: number | string | Date): number => {
  const seconds =
    value instanceof Date ? value.getTime() / 1000 : Number(value as any);
  if (!Number.isFinite(seconds)) {
    throw new TypeError(`Invalid time value: ${value}`);
  }
  return Math.trunc(seconds * 1_000_000_000);
};

interface Options {
  // unsafeMode -- if true, assume security model where user is running this
  // themself, e.g., in a project, so no security is needed at all.
  unsafeMode?: boolean;
  // readonly -- only allow operations that don't change files
  readonly?: boolean;
  // optional path to treat as "/" when mounted/available.
  // if set but unavailable, operations fail.
  rootfs?: string;
  // optional path to treat as /scratch when mounted/available.
  // if /scratch is requested but this is unavailable, operations fail.
  scratch?: string;
  host?: string;
  rusticRepo?: string;
  // Explicitly allow hard link creation in safe mode.
  allowSafeModeHardlink?: boolean;
  // Explicitly allow symlink creation in safe mode.
  allowSafeModeSymlink?: boolean;
}

const HOME_ROOT = "/root";

// If you add any methods below that are NOT for the public api
// be sure to exclude them here!
const INTERNAL_METHODS = new Set([
  "safeAbsPath",
  "safeAbsPaths",
  "constructor",
  "path",
  "unsafeMode",
  "readonly",
  "rootfs",
  "rootfsEnabled",
  "scratch",
  "scratchEnabled",
  "allowSafeModeHardlink",
  "allowSafeModeSymlink",
  "assertWritable",
  "rusticRepo",
  "host",
  "readFileLock",
  "_lockFile",
  "lastOnDisk",
  "lastOnDiskHash",
  "openAt2Roots",
]);

export class SandboxedFilesystem {
  public readonly unsafeMode: boolean;
  public readonly readonly: boolean;
  public readonly rootfs?: string;
  private rootfsEnabled = false;
  public readonly scratch?: string;
  private scratchEnabled = false;
  public readonly allowSafeModeHardlink: boolean;
  public readonly allowSafeModeSymlink: boolean;
  public rusticRepo: string;
  private host?: string;
  private openAt2Roots = new Map<string, OpenAt2SandboxRoot | null>();
  private lastOnDisk = new LRU<string, string>({
    maxSize: MAX_LAST_ON_DISK,
    sizeCalculation: (value) => value.length + 1, // must be positive!
    ttl: LAST_ON_DISK_TTL,
  });
  private lastOnDiskHash = new TTL<string, boolean>({
    ttl: LAST_ON_DISK_TTL_HASH,
  });

  constructor(
    // path should be the path to a FOLDER on the filesystem (not a file)
    public readonly path: string,
    {
      unsafeMode = false,
      readonly = false,
      rootfs,
      scratch,
      host = "global",
      rusticRepo: repo,
      allowSafeModeHardlink = false,
      allowSafeModeSymlink = false,
    }: Options = {},
  ) {
    this.unsafeMode = !!unsafeMode;
    this.readonly = !!readonly;
    this.rootfs = rootfs;
    this.scratch = scratch;
    this.host = host;
    this.allowSafeModeHardlink = allowSafeModeHardlink;
    this.allowSafeModeSymlink = allowSafeModeSymlink;
    this.rusticRepo = repo ?? rusticRepo;
    for (const f in this) {
      if (INTERNAL_METHODS.has(f)) {
        continue;
      }
      const orig = this[f];
      // @ts-ignore
      this[f] = async (...args) => {
        try {
          // @ts-ignore
          return await orig(...args);
        } catch (err) {
          let sandboxBasePath = this.path;
          try {
            if (typeof args?.[0] === "string") {
              sandboxBasePath = (
                await this.resolvePathInSandbox(args[0])
              ).sandboxBasePath;
            } else {
              sandboxBasePath = await this.resolveSandboxBasePath();
            }
          } catch {
            // keep original error, and best-effort sanitize with home path
          }
          if (typeof err?.path == "string") {
            if (
              err.path == sandboxBasePath ||
              err.path.startsWith(sandboxBasePath + "/")
            ) {
              err.path = this.toSandboxRelativePath(err.path, sandboxBasePath);
            } else if (
              err.path == this.path ||
              err.path.startsWith(this.path + "/")
            ) {
              err.path = err.path.slice(this.path.length + 1);
            }
          }
          if (typeof err?.message == "string") {
            err.message = replace_all(err.message, sandboxBasePath + "/", "");
            if (sandboxBasePath != this.path) {
              err.message = replace_all(err.message, this.path + "/", "");
            }
          }
          this.logSecurityDenial(f, args, err);
          throw err;
        }
      };
    }
  }

  private isSecurityDenial(err: any): boolean {
    if (err == null) {
      return false;
    }
    if (
      err?.code === "EACCES" ||
      err?.code === "EPERM" ||
      err?.code === "ESTALE"
    ) {
      return true;
    }
    if (typeof err?.message === "string") {
      return err.message.includes("outside of sandbox");
    }
    return false;
  }

  private logSecurityDenial(method: string, args: unknown[], err: any): void {
    if (this.unsafeMode || !this.isSecurityDenial(err)) {
      return;
    }
    const requestedPath = typeof args?.[0] === "string" ? args[0] : undefined;
    logger.warn("sandbox security deny", {
      method,
      mode: this.unsafeMode ? "unsafe" : "safe",
      path: requestedPath,
      code: err?.code,
      message: typeof err?.message === "string" ? err.message : String(err),
    });
  }

  private isOpenAt2Enabled(): boolean {
    return !this.unsafeMode && process.platform === "linux" && !OPENAT2_DISABLED;
  }

  private getOpenAt2Root(): OpenAt2SandboxRoot | null {
    return this.getOpenAt2RootForBase(this.path);
  }

  private getOpenAt2RootForBase(basePath: string): OpenAt2SandboxRoot | null {
    if (!this.isOpenAt2Enabled()) {
      return null;
    }
    if (this.openAt2Roots.has(basePath)) {
      return this.openAt2Roots.get(basePath) ?? null;
    }
    try {
      const { SandboxRoot } = require("@cocalc/openat2") as {
        SandboxRoot: new (root: string) => OpenAt2SandboxRoot;
      };
      const root = new SandboxRoot(basePath);
      this.openAt2Roots.set(basePath, root);
      return root;
    } catch (err) {
      logger.warn("openat2 unavailable; falling back to node fs sandbox path", {
        basePath,
        err: `${err}`,
      });
      this.openAt2Roots.set(basePath, null);
      return null;
    }
  }

  private parseOpenAt2Error(err: any): { code?: string; message: string } {
    const message =
      typeof err?.message === "string" ? err.message : String(err ?? "unknown");
    const m = message.match(/^([A-Z][A-Z0-9_]+):\s*(.*)$/);
    if (!m) {
      return { message };
    }
    return { code: m[1], message: m[2] };
  }

  private throwOpenAt2PathError(path: string, err: any): never {
    const parsed = this.parseOpenAt2Error(err);
    const code = parsed.code ?? err?.code;
    if (code === "ELOOP" || code === "EXDEV" || code === "ENOTDIR") {
      const outside: NodeJS.ErrnoException = new Error(
        `realpath of '${path}' resolves to a path outside of sandbox`,
      );
      outside.code = "EACCES";
      outside.path = path;
      throw outside;
    }
    const e: NodeJS.ErrnoException =
      err instanceof Error ? err : new Error(parsed.message);
    if (code != null) {
      e.code = code;
    }
    if (e.path == null) {
      e.path = path;
    }
    throw e;
  }

  private toOpenAt2RelativePath(
    pathInSandbox: string,
    sandboxBasePath: string,
  ): string | null {
    if (!pathInSandbox.startsWith(sandboxBasePath + "/")) {
      return null;
    }
    const rel = pathInSandbox.slice(sandboxBasePath.length + 1);
    if (rel == "") {
      return null;
    }
    return rel;
  }

  private async getOpenAt2PathTarget(
    path: string,
  ): Promise<{ root: OpenAt2SandboxRoot; rel: string } | null> {
    const { pathInSandbox, sandboxBasePath } = await this.resolvePathInSandbox(path);
    const root =
      sandboxBasePath === this.path
        ? this.getOpenAt2Root()
        : this.getOpenAt2RootForBase(sandboxBasePath);
    if (root == null) {
      return null;
    }
    const rel = this.toOpenAt2RelativePath(pathInSandbox, sandboxBasePath);
    if (rel == null) {
      return null;
    }
    return { root, rel };
  }

  private async getOpenAt2DualPathTarget(
    src: string,
    dest: string,
  ): Promise<{ root: OpenAt2SandboxRoot; srcRel: string; destRel: string } | null> {
    const [srcResolved, destResolved] = await Promise.all([
      this.resolvePathInSandbox(src),
      this.resolvePathInSandbox(dest),
    ]);
    if (srcResolved.sandboxBasePath !== destResolved.sandboxBasePath) {
      return null;
    }
    const root = this.getOpenAt2RootForBase(srcResolved.sandboxBasePath);
    if (root == null) {
      return null;
    }
    const srcRel = this.toOpenAt2RelativePath(
      srcResolved.pathInSandbox,
      srcResolved.sandboxBasePath,
    );
    const destRel = this.toOpenAt2RelativePath(
      destResolved.pathInSandbox,
      destResolved.sandboxBasePath,
    );
    if (srcRel == null || destRel == null) {
      return null;
    }
    return { root, srcRel, destRel };
  }

  private parseFsMode(mode: number | string): number | null {
    if (typeof mode === "number" && Number.isFinite(mode)) {
      return mode;
    }
    if (typeof mode !== "string") {
      return null;
    }
    const trimmed = mode.trim();
    if (/^[0-7]+$/.test(trimmed)) {
      return parseInt(trimmed, 8);
    }
    if (/^0o[0-7]+$/i.test(trimmed)) {
      return parseInt(trimmed.slice(2), 8);
    }
    return null;
  }

  private async resolveSandboxBasePath(): Promise<string> {
    if (this.rootfsEnabled && this.rootfs) {
      return this.rootfs;
    }
    return this.path;
  }

  private async requireRootfsForAbsolutePath(
    requestedAbsolutePath: string,
  ): Promise<string> {
    if (!this.rootfs) {
      // Backward-compatible mode when no rootfs is configured.
      return this.path;
    }
    if (this.rootfsEnabled) {
      return this.rootfs;
    }
    try {
      const st = await stat(this.rootfs);
      if (st.isDirectory()) {
        this.rootfsEnabled = true;
        return this.rootfs;
      }
    } catch {
      // handled below
    }
    throw new Error(
      `rootfs is not mounted; cannot access absolute path '${requestedAbsolutePath}'. Start the workspace and try again.`,
    );
  }

  private async requireScratchForAbsolutePath(
    requestedAbsolutePath: string,
  ): Promise<string> {
    if (!this.scratch) {
      throw new Error(
        `scratch is not mounted; cannot access absolute path '${requestedAbsolutePath}'`,
      );
    }
    if (this.scratchEnabled) {
      return this.scratch;
    }
    try {
      const st = await stat(this.scratch);
      if (st.isDirectory()) {
        this.scratchEnabled = true;
        return this.scratch;
      }
    } catch {
      // handled below
    }
    throw new Error(
      `scratch is not mounted; cannot access absolute path '${requestedAbsolutePath}'. Start the workspace and try again.`,
    );
  }

  private async resolvePathInSandbox(path: string): Promise<{
    pathInSandbox: string;
    sandboxBasePath: string;
    absoluteHomeAlias: boolean;
    absoluteScratchAlias: boolean;
  }> {
    const resolvedInput = resolve("/", path);
    const isAbsoluteInput = path.startsWith("/");
    const isAbsoluteHomeAlias =
      isAbsoluteInput &&
      (resolvedInput == HOME_ROOT || resolvedInput.startsWith(`${HOME_ROOT}/`));
    const isAbsoluteScratchAlias =
      isAbsoluteInput &&
      (resolvedInput == "/scratch" || resolvedInput.startsWith("/scratch/"));

    // Relative paths (and absolute /root paths) are always interpreted relative
    // to the project home mount `path`, even when rootfs mode is enabled.
    if (!isAbsoluteInput || isAbsoluteHomeAlias) {
      const rel =
        isAbsoluteHomeAlias
          ? resolvedInput == HOME_ROOT
            ? ""
            : resolvedInput.slice(HOME_ROOT.length + 1)
          : resolvedInput.slice(1);
      return {
        pathInSandbox: join(this.path, rel),
        sandboxBasePath: this.path,
        absoluteHomeAlias: isAbsoluteHomeAlias,
        absoluteScratchAlias: false,
      };
    }

    if (isAbsoluteScratchAlias) {
      const scratchBase = await this.requireScratchForAbsolutePath(resolvedInput);
      const rel =
        resolvedInput == "/scratch"
          ? ""
          : resolvedInput.slice("/scratch".length + 1);
      return {
        pathInSandbox: join(scratchBase, rel),
        sandboxBasePath: scratchBase,
        absoluteHomeAlias: false,
        absoluteScratchAlias: true,
      };
    }

    const rootBase = await this.requireRootfsForAbsolutePath(resolvedInput);

    // Other absolute paths are interpreted from rootfs mount.
    return {
      pathInSandbox: join(rootBase, resolvedInput),
      sandboxBasePath: rootBase,
      absoluteHomeAlias: false,
      absoluteScratchAlias: false,
    };
  }

  private toSandboxRelativePath(absPath: string, basePath: string): string {
    if (absPath == basePath) {
      return basePath == this.path ? "" : "/";
    }
    if (!absPath.startsWith(basePath + "/")) {
      return absPath;
    }
    const rel = absPath.slice(basePath.length + 1);
    return basePath == this.path ? rel : `/${rel}`;
  }

  private assertWritable = (path: string) => {
    if (this.readonly) {
      throw new SandboxError(
        `EACCES: permission denied -- read only filesystem, open '${path}'`,
        { errno: -13, code: "EACCES", syscall: "open", path },
      );
    }
  };

  private assertSafeModeLinkPolicy(kind: "link" | "symlink", path: string): void {
    if (this.unsafeMode) {
      return;
    }
    const allowed =
      kind === "link" ? this.allowSafeModeHardlink : this.allowSafeModeSymlink;
    if (allowed) {
      return;
    }
    throw new SandboxError(
      `EPERM: operation not permitted in safe mode, ${kind} '${path}'`,
      { errno: -1, code: "EPERM", syscall: kind, path },
    );
  }

  safeAbsPaths = async (path: string[] | string): Promise<string[]> => {
    return await Promise.all(
      (typeof path == "string" ? [path] : path).map(this.safeAbsPath),
    );
  };

  private resolveSandboxPath = async (path: string): Promise<string> => {
    return await this.safeAbsPath(path);
  };

  private resolveWritableSandboxPath = async (path: string): Promise<string> => {
    this.assertWritable(path);
    return await this.resolveSandboxPath(path);
  };

  private resolveWritableSandboxPaths = async (
    path: string | string[],
  ): Promise<string[]> => {
    const paths = typeof path == "string" ? [path] : path;
    for (const p of paths) {
      this.assertWritable(p);
    }
    return await this.safeAbsPaths(paths);
  };

  private resolveReadWriteSandboxPaths = async (
    src: string,
    dest: string,
  ): Promise<[string, string]> => {
    this.assertWritable(dest);
    const [srcPath, destPath] = await this.safeAbsPaths([src, dest]);
    return [srcPath, destPath];
  };

  private verifySameInode = async (
    path: string,
    absPath: string,
  ): Promise<void> => {
    if (this.unsafeMode) {
      return;
    }
    // Symlink path operations (rename/unlink) act on the link itself, while
    // open() resolves to the target. Skip inode pinning for links.
    const lst = await lstat(absPath);
    if (lst.isSymbolicLink()) {
      return;
    }
    const { handle } = await this.openVerifiedHandle({
      path,
      flags: constants.O_RDONLY,
    });
    try {
      const [fdStat, pathStat] = await Promise.all([handle.stat(), stat(absPath)]);
      if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
        const err: NodeJS.ErrnoException = new Error(
          `Path changed during operation: '${path}'`,
        );
        err.code = "ESTALE";
        err.path = path;
        throw err;
      }
    } finally {
      await handle.close();
    }
  };

  private preflightExistingSource = async (
    path: string,
    absPath: string,
  ): Promise<void> => {
    try {
      await this.verifySameInode(path, absPath);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return;
      }
      throw err;
    }
  };

  private verifyExistingAncestorInSandbox = async (
    path: string,
  ): Promise<void> => {
    if (this.unsafeMode) {
      return;
    }
    let ancestor = dirname(path);
    while (ancestor && ancestor !== "." && ancestor !== "/") {
      try {
        const { handle } = await this.openVerifiedHandle({
          path: ancestor,
          flags: constants.O_RDONLY,
        });
        await handle.close();
        return;
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          const next = dirname(ancestor);
          if (next === ancestor) {
            return;
          }
          ancestor = next;
          continue;
        }
        throw err;
      }
    }
  };

  private isInsideSandbox = (
    candidatePath: string,
    sandboxBasePath: string,
  ): boolean => {
    return (
      candidatePath == sandboxBasePath ||
      candidatePath.startsWith(sandboxBasePath + "/")
    );
  };

  private ensureFdInSandbox = async (
    fd: number,
    sandboxBasePath: string,
    path: string,
  ): Promise<void> => {
    if (this.unsafeMode) {
      return;
    }
    // Verify the actual opened inode is still inside the sandbox boundary.
    // This closes the TOCTOU window between path validation and read/write.
    const resolved = await realpath(`/proc/self/fd/${fd}`);
    if (!this.isInsideSandbox(resolved, sandboxBasePath)) {
      throw Error(`realpath of '${path}' resolves to a path outside of sandbox`);
    }
  };

  private ensureHandleMatchesPath = async (
    handle: Awaited<ReturnType<typeof open>>,
    pathInSandbox: string,
    sandboxBasePath: string,
    path: string,
  ): Promise<void> => {
    let fdStat;
    let pathStat;
    try {
      [fdStat, pathStat] = await Promise.all([handle.stat(), stat(pathInSandbox)]);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        const stale: NodeJS.ErrnoException = new Error(
          `Path changed during operation: '${path}'`,
        );
        stale.code = "ESTALE";
        stale.path = path;
        throw stale;
      }
      throw err;
    }
    if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
      const stale: NodeJS.ErrnoException = new Error(
        `Path changed during operation: '${path}'`,
      );
      stale.code = "ESTALE";
      stale.path = path;
      throw stale;
    }
    const resolved = await realpath(pathInSandbox);
    if (!this.isInsideSandbox(resolved, sandboxBasePath)) {
      throw Error(`realpath of '${path}' resolves to a path outside of sandbox`);
    }
  };

  private openVerifiedHandle = async ({
    path,
    flags,
    mode,
    verify = true,
  }: {
    path: string;
    flags: number;
    mode?: number;
    verify?: boolean;
  }): Promise<{
    handle: Awaited<ReturnType<typeof open>>;
    pathInSandbox: string;
    sandboxBasePath: string;
  }> => {
    if (verify) {
      // Pre-open path check blocks obvious symlink escapes for existing paths,
      // while still allowing create paths that currently do not exist.
      await this.safeAbsPath(path);
    }
    const { pathInSandbox, sandboxBasePath } =
      await this.resolvePathInSandbox(path);
    const handle = await open(pathInSandbox, flags, mode);
    if (verify) {
      try {
        await this.ensureFdInSandbox(handle.fd, sandboxBasePath, path);
        await this.ensureHandleMatchesPath(
          handle,
          pathInSandbox,
          sandboxBasePath,
          path,
        );
      } catch (err) {
        try {
          await handle.close();
        } catch {}
        throw err;
      }
    }
    return { handle, pathInSandbox, sandboxBasePath };
  };

  safeAbsPath = async (path: string): Promise<string> => {
    if (typeof path != "string") {
      throw Error(`path must be a string but is of type ${typeof path}`);
    }
    const { sandboxBasePath, pathInSandbox } =
      await this.resolvePathInSandbox(path);
    if (this.unsafeMode) {
      // not secure -- just convenient.
      return pathInSandbox;
    }
    // However, there is still one threat, which is that it could
    // be a path to an existing link that goes out of the sandbox. So
    // we resolve to the realpath:
    try {
      const p = await realpath(pathInSandbox);
      if (p != sandboxBasePath && !p.startsWith(sandboxBasePath + "/")) {
        throw Error(
          `realpath of '${path}' resolves to a path outside of sandbox`,
        );
      }
      // don't return the result of calling realpath -- what's important is
      // their path's realpath is in the sandbox.
      return pathInSandbox;
    } catch (err) {
      if (err.code == "ENOENT") {
        return pathInSandbox;
      } else {
        throw err;
      }
    }
  };

  appendFile = async (path: string, data: string | Buffer, encoding?) => {
    this.assertWritable(path);
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    let openWriteFd: number | null = null;
    if (
      openAt2Target != null &&
      typeof openAt2Target.root.openWrite === "function"
    ) {
      try {
        openWriteFd = openAt2Target.root.openWrite(
          openAt2Target.rel,
          true,
          false,
          true,
          0o666,
        );
      } catch (err) {
        const { code } = this.parseOpenAt2Error(err);
        if (code !== "ENOSYS" && code !== "EINVAL") {
          this.throwOpenAt2PathError(path, err);
        }
      }
    }
    if (openWriteFd != null) {
      try {
        await writeFileByFd(openWriteFd, data, encoding);
        return;
      } finally {
        try {
          await closeFd(openWriteFd);
        } catch {}
      }
    }
    const { handle } = await this.openVerifiedHandle({
      path,
      flags: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
    });
    try {
      return await handle.appendFile(data as any, encoding);
    } finally {
      await handle.close();
    }
  };

  chmod = async (path: string, mode: string | number) => {
    this.assertWritable(path);
    await this.safeAbsPath(path);
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    const modeNum = this.parseFsMode(mode);
    if (openAt2Target != null && modeNum != null) {
      try {
        openAt2Target.root.chmod(openAt2Target.rel, modeNum);
        return;
      } catch (err) {
        this.throwOpenAt2PathError(path, err);
      }
    }
    const { handle } = await this.openVerifiedHandle({
      path,
      flags: constants.O_RDONLY,
    });
    try {
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  };

  constants = async (): Promise<{ [key: string]: number }> => {
    return constants;
  };

  copyFile = async (src: string, dest: string) => {
    this.assertWritable(dest);
    await Promise.all([this.safeAbsPath(src), this.safeAbsPath(dest)]);
    const openAt2Target = await this.getOpenAt2DualPathTarget(src, dest);
    if (openAt2Target != null) {
      try {
        openAt2Target.root.copyFile(openAt2Target.srcRel, openAt2Target.destRel);
        return;
      } catch (err) {
        this.throwOpenAt2PathError(src, err);
      }
    }

    const [, destPath] = await this.resolveReadWriteSandboxPaths(src, dest);
    const opened = await this.openVerifiedHandle({
      path: src,
      flags: constants.O_RDONLY,
    });
    const sourceHandle = opened.handle;
    try {
      const sourceStat = await sourceHandle.stat();
      // Avoid self-copy corruption if source and destination resolve to the
      // same inode.
      try {
        const destStat = await stat(destPath);
        if (sourceStat.dev === destStat.dev && sourceStat.ino === destStat.ino) {
          const err: NodeJS.ErrnoException = new Error(
            `Source and destination must not be the same file: '${src}'`,
          );
          err.code = "EINVAL";
          err.path = dest;
          throw err;
        }
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          throw err;
        }
      }
      const data = await sourceHandle.readFile();
      await this.writeFile(dest, data);
      try {
        await chmod(destPath, sourceStat.mode);
      } catch {
        // best-effort metadata parity with fs.copyFile behavior
      }
    } finally {
      await sourceHandle.close();
    }
  };

  cp = async (src: string | string[], dest: string, options?: CopyOptions) => {
    const destInput = dest;
    const destPath = await this.resolveWritableSandboxPath(destInput);

    // ensure containing directory of destination exists -- node cp doesn't
    // do this but for cocalc this is very convenient and saves some network
    // round trips.
    const destInputDir = dirname(destInput);
    if (
      destInputDir !== "." &&
      destInputDir !== "/" &&
      destInputDir !== HOME_ROOT &&
      !(await this.exists(destInputDir))
    ) {
      await this.mkdir(destInputDir, { recursive: true });
    }

    const srcInput = typeof src == "string" ? [src] : src;
    const v = await this.safeAbsPaths(srcInput);
    if (!options?.reflink) {
      // can use node cp:
      for (let i = 0; i < v.length; i++) {
        const srcPath = v[i];
        const source = srcInput[i];
        if (typeof src == "string") {
          const st = await lstat(srcPath);
          if (st.isFile()) {
            await this.copyFile(source, destInput);
          } else {
            await cp(srcPath, destPath, options);
          }
        } else {
          // copying multiple files to a directory
          const target = join(destInput, basename(srcPath));
          const st = await lstat(srcPath);
          if (st.isFile()) {
            await this.copyFile(source, target);
          } else {
            await cp(srcPath, join(destPath, basename(srcPath)), options);
          }
        }
      }
    } else {
      // /usr/bin/cp.  NOte that behavior depends on string versus string[],
      // so we pass the absolute paths v in that way.
      await cpExec(
        typeof src == "string" ? v[0] : v,
        destPath,
        capTimeout(options, MAX_TIMEOUT),
      );
    }
  };

  exists = async (path: string) => {
    return await exists(await this.resolveSandboxPath(path));
  };

  find = async (path: string, options?: FindOptions): Promise<ExecOutput> => {
    return await find(
      await this.resolveSandboxPath(path),
      capTimeout(options, MAX_TIMEOUT),
    );
  };

  getListing = async (
    path: string,
  ): Promise<{ files: Files; truncated?: boolean }> => {
    return await getListing(await this.resolveSandboxPath(path));
  };

  // find files
  fd = async (path: string, options?: FdOptions): Promise<ExecOutput> => {
    return await fd(
      await this.resolveSandboxPath(path),
      capTimeout(options, MAX_TIMEOUT),
    );
  };

  // disk usage
  dust = async (path: string, options?: DustOptions): Promise<ExecOutput> => {
    return await dust(
      await this.resolveSandboxPath(path),
      // dust reasonably takes longer than the other commands and is used less,
      // so for now we give it more breathing room.
      capTimeout(options, 4 * MAX_TIMEOUT),
    );
  };

  // compression
  ouch = async (args: string[], options?: OuchOptions): Promise<ExecOutput> => {
    options = { ...options };
    if (options.cwd) {
      options.cwd = await this.resolveSandboxPath(options.cwd);
    }
    if (options.options) {
      options.options = await this.resolveOuchOptionPaths(options.options);
    }
    return await ouch(
      [args[0]].concat(
        await Promise.all(args.slice(1).map(this.resolveSandboxPath)),
      ),
      capTimeout(options, 6 * MAX_TIMEOUT),
    );
  };

  private resolveOuchOptionPaths = async (
    options: string[],
  ): Promise<string[]> => {
    const resolved = options.slice();
    for (let i = 0; i < resolved.length; i++) {
      const opt = resolved[i];
      if (opt !== "-d" && opt !== "--dir") {
        continue;
      }
      if (i + 1 >= resolved.length) {
        throw new Error(`Option ${opt} requires a value`);
      }
      resolved[i + 1] = await this.resolveSandboxPath(resolved[i + 1]);
      i += 1;
    }
    return resolved;
  };

  // backups
  rustic = async (
    args: string[],
    {
      timeout = 120_000,
      maxSize = 10_000_000, // the json output can be quite large
      cwd,
      env,
      onStdoutLine,
      onStderrLine,
    }: {
      timeout?: number;
      maxSize?: number;
      cwd?: string;
      env?: { [name: string]: string };
      onStdoutLine?: (line: string) => void;
      onStderrLine?: (line: string) => void;
    } = {},
  ): Promise<ExecOutput> => {
    return await rustic(args, {
      repo: this.rusticRepo,
      safeAbsPath: this.safeAbsPath,
      timeout,
      maxSize,
      host: this.host,
      cwd,
      env,
      onStdoutLine,
      onStderrLine,
    });
  };

  ripgrep = async (
    path: string,
    pattern: string,
    options?: RipgrepOptions,
  ): Promise<ExecOutput> => {
    return await ripgrep(
      await this.resolveSandboxPath(path),
      pattern,
      capTimeout(options, MAX_TIMEOUT),
    );
  };

  // hard link
  link = async (existingPath: string, newPath: string) => {
    this.assertSafeModeLinkPolicy("link", newPath);
    await Promise.all([this.safeAbsPath(existingPath), this.safeAbsPath(newPath)]);
    const openAt2Target = await this.getOpenAt2DualPathTarget(
      existingPath,
      newPath,
    );
    if (openAt2Target != null && typeof openAt2Target.root.link === "function") {
      try {
        openAt2Target.root.link(openAt2Target.srcRel, openAt2Target.destRel);
        return;
      } catch (err) {
        this.throwOpenAt2PathError(existingPath, err);
      }
    }
    const [srcPath, destPath] = await this.resolveReadWriteSandboxPaths(existingPath, newPath);
    return await link(srcPath, destPath);
  };

  lstat = async (path: string) => {
    return await lstat(await this.resolveSandboxPath(path));
  };

  mkdir = async (path: string, options?) => {
    this.assertWritable(path);
    await this.verifyExistingAncestorInSandbox(path);
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    let recursive = false;
    let mode: number | string | undefined;
    if (typeof options === "number" || typeof options === "string") {
      mode = options;
    } else if (options != null && typeof options === "object") {
      recursive = !!options.recursive;
      mode = options.mode;
    }
    const modeNum = mode == null ? 0o777 : this.parseFsMode(mode);
    if (openAt2Target != null && modeNum != null) {
      try {
        openAt2Target.root.mkdir(openAt2Target.rel, recursive, modeNum);
        return;
      } catch (err) {
        this.throwOpenAt2PathError(path, err);
      }
    }
    const absPath = await this.resolveSandboxPath(path);
    await mkdir(absPath, options);
    // For create paths, re-validate post-create target resolves in sandbox.
    await this.safeAbsPath(path);
  };

  private readFileLock = new Set<string>();
  readFile = async (
    path: string,
    encoding?: any,
    lock?: number,
  ): Promise<string | Buffer> => {
    const { pathInSandbox } = await this.resolvePathInSandbox(path);
    const p = this.unsafeMode ? pathInSandbox : await this.safeAbsPath(path);
    if (this.readFileLock.has(p)) {
      throw new ConatError(`path is locked - ${p}`, { code: "LOCK" });
    }
    if (lock) {
      this._lockFile(p, lock);
    }
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    let openReadFd: number | null = null;
    if (
      openAt2Target != null &&
      typeof openAt2Target.root.openRead === "function"
    ) {
      try {
        openReadFd = openAt2Target.root.openRead(openAt2Target.rel);
      } catch {
        // Preserve Node-compatible read error shape/messages by falling back
        // to the existing verified-handle path implementation.
      }
    }
    if (openReadFd != null) {
      try {
        return await readFileByFd(openReadFd, encoding);
      } finally {
        try {
          await closeFd(openReadFd);
        } catch {}
      }
    }
    const { handle } = await this.openVerifiedHandle({
      path,
      flags: constants.O_RDONLY,
    });
    try {
      return await handle.readFile(encoding);
    } finally {
      await handle.close();
    }
  };

  lockFile = async (path: string, lock?: number) => {
    const p = await this.resolveSandboxPath(path);
    this._lockFile(p, lock);
  };

  private _lockFile = (path: string, lock?: number) => {
    if (lock) {
      this.readFileLock.add(path);
      setTimeout(() => {
        this.readFileLock.delete(path);
      }, lock);
    } else {
      this.readFileLock.delete(path);
    }
  };

  readdir = async (path: string, options?) => {
    const x = (await readdir(await this.resolveSandboxPath(path), options)) as any[];
    if (options?.withFileTypes) {
      const sandboxBasePath = await this.resolveSandboxBasePath();
      // each entry in x has a name and parentPath field, which refers to the
      // absolute paths to the directory that contains x or the target of x (if
      // it is a link).  This is an absolute path on the fileserver, which we try
      // not to expose from the sandbox, hence we modify them all if possible.
      for (const a of x) {
        if (
          a.name == sandboxBasePath ||
          a.name.startsWith(sandboxBasePath + "/")
        ) {
          a.name = this.toSandboxRelativePath(a.name, sandboxBasePath);
        }
        if (
          a.parentPath == sandboxBasePath ||
          a.parentPath.startsWith(sandboxBasePath + "/")
        ) {
          a.parentPath = this.toSandboxRelativePath(
            a.parentPath,
            sandboxBasePath,
          );
        }
        if (
          a.name == this.path ||
          a.name.startsWith(this.path + "/")
        ) {
          a.name = this.toSandboxRelativePath(a.name, this.path);
        }
        if (
          a.parentPath == this.path ||
          a.parentPath.startsWith(this.path + "/")
        ) {
          a.parentPath = this.toSandboxRelativePath(a.parentPath, this.path);
        }
      }
    }

    return x;
  };

  readlink = async (path: string): Promise<string> => {
    return await readlink(await this.resolveSandboxPath(path));
  };

  realpath = async (path: string): Promise<string> => {
    const {
      pathInSandbox,
      sandboxBasePath,
      absoluteHomeAlias,
      absoluteScratchAlias,
    } =
      await this.resolvePathInSandbox(path);
    const x = await realpath(pathInSandbox);
    const rel = this.toSandboxRelativePath(x, sandboxBasePath);
    if (absoluteHomeAlias) {
      if (rel === "") {
        return HOME_ROOT;
      }
      return `${HOME_ROOT}/${rel}`;
    }
    if (absoluteScratchAlias) {
      if (rel === "" || rel === "/") {
        return "/scratch";
      }
      return `/scratch/${rel}`;
    }
    return rel;
  };

  rename = async (oldPath: string, newPath: string) => {
    await Promise.all([this.safeAbsPath(oldPath), this.safeAbsPath(newPath)]);
    const openAt2Target = await this.getOpenAt2DualPathTarget(oldPath, newPath);
    if (openAt2Target != null) {
      try {
        openAt2Target.root.rename(openAt2Target.srcRel, openAt2Target.destRel);
        return;
      } catch (err) {
        this.throwOpenAt2PathError(oldPath, err);
      }
    }
    const [srcPath, destPath] = await this.resolveReadWriteSandboxPaths(
      oldPath,
      newPath,
    );
    await this.preflightExistingSource(oldPath, srcPath);
    await rename(srcPath, destPath);
  };

  move = async (
    src: string,
    dest: string,
    options?: { overwrite?: boolean },
  ) => {
    await Promise.all([this.safeAbsPath(src), this.safeAbsPath(dest)]);
    const overwrite = !!options?.overwrite;
    if (this.isOpenAt2Enabled()) {
      const [srcResolved, destResolved] = await Promise.all([
        this.resolvePathInSandbox(src),
        this.resolvePathInSandbox(dest),
      ]);
      if (srcResolved.sandboxBasePath !== destResolved.sandboxBasePath) {
        const exdev: NodeJS.ErrnoException = new Error(
          "cross-base move is not supported",
        );
        exdev.code = "EXDEV";
        exdev.path = dest;
        throw exdev;
      }
    }
    const openAt2Target = await this.getOpenAt2DualPathTarget(src, dest);
    if (openAt2Target != null) {
      if (!overwrite && typeof openAt2Target.root.renameNoReplace === "function") {
        try {
          openAt2Target.root.renameNoReplace(
            openAt2Target.srcRel,
            openAt2Target.destRel,
          );
          return;
        } catch (err) {
          const { code } = this.parseOpenAt2Error(err);
          if (code === "EXDEV") {
            const exdev: NodeJS.ErrnoException =
              err instanceof Error
                ? err
                : new Error("cross-device move is not supported");
            exdev.code = "EXDEV";
            exdev.path = dest;
            throw exdev;
          }
          if (code !== "ENOSYS" && code !== "EINVAL") {
            this.throwOpenAt2PathError(src, err);
          }
        }
      } else if (overwrite) {
        try {
          openAt2Target.root.rename(openAt2Target.srcRel, openAt2Target.destRel);
          return;
        } catch (err) {
          const { code } = this.parseOpenAt2Error(err);
          if (code === "EXDEV") {
            const exdev: NodeJS.ErrnoException =
              err instanceof Error
                ? err
                : new Error("cross-device move is not supported");
            exdev.code = "EXDEV";
            exdev.path = dest;
            throw exdev;
          }
          if (code !== "ENOSYS" && code !== "EINVAL") {
            this.throwOpenAt2PathError(src, err);
          }
        }
      }
    }

    const [srcPath, destPath] = await this.resolveReadWriteSandboxPaths(
      src,
      dest,
    );
    await this.preflightExistingSource(src, srcPath);
    await move(srcPath, destPath, options);
  };

  rm = async (path: string | string[], options?) => {
    const paths = typeof path == "string" ? [path] : path;
    const v = await this.resolveWritableSandboxPaths(paths);
    const recursive = !!(options != null && typeof options === "object" && options.recursive);
    const force = !!(options != null && typeof options === "object" && options.force);
    const f = async (inputPath: string, absPath: string) => {
      const openAt2Target = await this.getOpenAt2PathTarget(inputPath);
      if (
        recursive &&
        openAt2Target != null &&
        typeof openAt2Target.root.rm === "function"
      ) {
        // Keep non-recursive rm semantics from Node fs (including directory
        // error behavior) while using openat2 hardening for recursive removal.
        try {
          openAt2Target.root.rm(openAt2Target.rel, recursive, force);
          void globalSyncFsService.recordLocalDelete(absPath);
          return;
        } catch (err) {
          const { code } = this.parseOpenAt2Error(err);
          if (code !== "ENOSYS" && code !== "EINVAL") {
            this.throwOpenAt2PathError(inputPath, err);
          }
        }
      }
      await this.preflightExistingSource(inputPath, absPath);
      await rm(absPath, options);
      void globalSyncFsService.recordLocalDelete(absPath);
    };
    await Promise.all(v.map((absPath, i) => f(paths[i], absPath)));
  };

  rmdir = async (path: string, options?) => {
    this.assertWritable(path);
    await this.safeAbsPath(path);
    const recursive = !!(options != null && typeof options === "object" && options.recursive);
    if (recursive) {
      // Keep recursive rmdir fail-closed by routing through the hardened rm path.
      await this.rm(path, { recursive: true, force: false });
      return;
    }
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    if (openAt2Target != null) {
      try {
        openAt2Target.root.rmdir(openAt2Target.rel);
        return;
      } catch (err) {
        this.throwOpenAt2PathError(path, err);
      }
    }
    const absPath = await this.resolveWritableSandboxPath(path);
    await this.preflightExistingSource(path, absPath);
    await rmdir(absPath, options);
  };

  stat = async (path: string) => {
    return await stat(await this.resolveSandboxPath(path));
  };

  symlink = async (target: string, path: string) => {
    this.assertSafeModeLinkPolicy("symlink", path);
    const [targetPath, linkPath] = await Promise.all([
      this.resolveSandboxPath(target),
      this.resolveWritableSandboxPath(path),
    ]);
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    if (
      openAt2Target != null &&
      typeof openAt2Target.root.symlink === "function"
    ) {
      try {
        openAt2Target.root.symlink(targetPath, openAt2Target.rel);
        return;
      } catch (err) {
        this.throwOpenAt2PathError(path, err);
      }
    }
    return await symlink(targetPath, linkPath);
  };

  truncate = async (path: string, len?: number) => {
    this.assertWritable(path);
    await this.safeAbsPath(path);
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    if (openAt2Target != null) {
      try {
        openAt2Target.root.truncate(openAt2Target.rel, len ?? 0);
        return;
      } catch (err) {
        this.throwOpenAt2PathError(path, err);
      }
    }
    const { handle } = await this.openVerifiedHandle({
      path,
      flags: constants.O_RDWR,
    });
    try {
      await handle.truncate(len);
    } finally {
      await handle.close();
    }
  };

  unlink = async (path: string) => {
    const abs = await this.resolveWritableSandboxPath(path);
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    if (openAt2Target != null) {
      try {
        openAt2Target.root.unlink(openAt2Target.rel);
        void globalSyncFsService.recordLocalDelete(abs);
        return;
      } catch (err) {
        this.throwOpenAt2PathError(path, err);
      }
    }
    await this.preflightExistingSource(path, abs);
    await unlink(abs);
    void globalSyncFsService.recordLocalDelete(abs);
  };

  utimes = async (
    path: string,
    atime: number | string | Date,
    mtime: number | string | Date,
  ) => {
    this.assertWritable(path);
    await this.safeAbsPath(path);
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    if (
      openAt2Target != null &&
      typeof openAt2Target.root.utimes === "function"
    ) {
      try {
        openAt2Target.root.utimes(
          openAt2Target.rel,
          toTimespecNs(atime),
          toTimespecNs(mtime),
        );
        return;
      } catch (err) {
        this.throwOpenAt2PathError(path, err);
      }
    }
    const { handle } = await this.openVerifiedHandle({
      path,
      flags: constants.O_RDONLY,
    });
    try {
      await handle.utimes(atime, mtime);
    } finally {
      await handle.close();
    }
  };

  watch = async (
    path: string,
    options: WatchOptions = {},
  ): Promise<WatchIterator> => {
    return watch(
      await this.resolveSandboxPath(path),
      options,
      this.lastOnDisk,
      this.lastOnDiskHash,
    );
  };

  writeFile = async (
    path: string,
    data: string | Buffer | PatchWriteRequest,
    saveLast?: boolean,
  ) => {
    this.assertWritable(path);
    const { pathInSandbox } = await this.resolvePathInSandbox(path);
    const p = this.unsafeMode ? pathInSandbox : await this.safeAbsPath(path);
    if (isPatchRequest(data)) {
      const encoding = data.encoding ?? "utf8";
      const normalizedEncoding = encoding === "utf-8" ? "utf8" : encoding;
      const openAt2Target = await this.getOpenAt2PathTarget(path);
      let current: string;
      let openReadFd: number | null = null;
      if (
        openAt2Target != null &&
        typeof openAt2Target.root.openRead === "function"
      ) {
        try {
          openReadFd = openAt2Target.root.openRead(openAt2Target.rel);
        } catch (err) {
          const { code } = this.parseOpenAt2Error(err);
          if (code === "ENOENT") {
            const e: NodeJS.ErrnoException = new Error(
              "Mismatched base version for patch write",
            );
            e.code = "ETAG_MISMATCH";
            e.path = p;
            throw e;
          }
          if (code !== "ENOSYS" && code !== "EINVAL") {
            this.throwOpenAt2PathError(path, err);
          }
        }
      }
      if (openReadFd != null) {
        try {
          current = (await readFileByFd(openReadFd, encoding)) as string;
        } finally {
          try {
            await closeFd(openReadFd);
          } catch {}
        }
      } else {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          const opened = await this.openVerifiedHandle({
            path,
            flags: constants.O_RDONLY,
          });
          handle = opened.handle;
          current = (await handle.readFile({ encoding })) as string;
        } catch (err: any) {
          if (err?.code === "ENOENT") {
            err.code = "ETAG_MISMATCH";
          }
          throw err;
        } finally {
          if (handle != null) {
            try {
              await handle.close();
            } catch {}
          }
        }
      }
      const currentHash = createHash("sha256")
        .update(Buffer.from(current, normalizedEncoding))
        .digest("hex");
      if (currentHash !== data.sha256) {
        const err: NodeJS.ErrnoException = new Error(
          "Mismatched base version for patch write",
        );
        err.code = "ETAG_MISMATCH";
        err.path = p;
        throw err;
      }
      let compressedPatch: CompressedPatch;
      try {
        compressedPatch =
          typeof data.patch === "string"
            ? (JSON.parse(data.patch) as CompressedPatch)
            : data.patch;
      } catch {
        const err: NodeJS.ErrnoException = new Error(
          "Invalid patch format for writeFile",
        );
        err.code = "EINVAL";
        err.path = p;
        throw err;
      }
      if (!Array.isArray(compressedPatch)) {
        const err: NodeJS.ErrnoException = new Error(
          "Invalid patch payload for writeFile",
        );
        err.code = "EINVAL";
        err.path = p;
        throw err;
      }
      const [patched, clean] = apply_patch(compressedPatch, current);
      if (!clean) {
        const err: NodeJS.ErrnoException = new Error(
          "Failed to apply patch cleanly",
        );
        err.code = "PATCH_FAILED";
        err.path = p;
        throw err;
      }
      const encoded = Buffer.from(patched, normalizedEncoding);
      let openWriteFd: number | null = null;
      if (
        openAt2Target != null &&
        typeof openAt2Target.root.openWrite === "function"
      ) {
        try {
          openWriteFd = openAt2Target.root.openWrite(
            openAt2Target.rel,
            false,
            true,
            false,
            0o666,
          );
        } catch (err) {
          const { code } = this.parseOpenAt2Error(err);
          if (code === "ENOENT") {
            const e: NodeJS.ErrnoException = new Error(
              "Mismatched base version for patch write",
            );
            e.code = "ETAG_MISMATCH";
            e.path = p;
            throw e;
          }
          if (code !== "ENOSYS" && code !== "EINVAL") {
            this.throwOpenAt2PathError(path, err);
          }
        }
      }
      if (openWriteFd != null) {
        try {
          await writeFileByFd(openWriteFd, encoded);
        } finally {
          try {
            await closeFd(openWriteFd);
          } catch {}
        }
      } else {
        const { handle } = await this.openVerifiedHandle({
          path,
          flags: constants.O_RDWR,
        });
        try {
          await handle.truncate(0);
          await handle.write(encoded, 0, encoded.length, 0);
        } finally {
          await handle.close();
        }
      }
      if (saveLast) {
        this.lastOnDisk.set(p, patched);
        this.lastOnDiskHash.set(`${p}-${sha1(patched)}`, true);
      }
      if (saveLast) {
        globalSyncFsService.recordLocalWrite(p, patched, true);
      }
      return;
    }
    if (saveLast && typeof data == "string") {
      this.lastOnDisk.set(p, data);
      this.lastOnDiskHash.set(`${p}-${sha1(data)}`, true);
    }
    const openAt2Target = await this.getOpenAt2PathTarget(path);
    let openWriteFd: number | null = null;
    if (
      openAt2Target != null &&
      typeof openAt2Target.root.openWrite === "function"
    ) {
      try {
        openWriteFd = openAt2Target.root.openWrite(
          openAt2Target.rel,
          true,
          true,
          false,
          0o666,
        );
      } catch (err) {
        const { code } = this.parseOpenAt2Error(err);
        if (code !== "ENOSYS" && code !== "EINVAL") {
          this.throwOpenAt2PathError(path, err);
        }
      }
    }
    if (openWriteFd != null) {
      try {
        await writeFileByFd(openWriteFd, data as any);
      } finally {
        try {
          await closeFd(openWriteFd);
        } catch {}
      }
      if (saveLast === true && typeof data === "string") {
        globalSyncFsService.recordLocalWrite(p, data, true);
      }
      return;
    }
    const writeToHandle = async (
      handle: Awaited<ReturnType<typeof open>>,
    ): Promise<void> => {
      try {
        await handle.truncate(0);
        await handle.writeFile(data as any);
      } finally {
        await handle.close();
      }
    };
    try {
      const { handle } = await this.openVerifiedHandle({
        path,
        flags: constants.O_RDWR,
      });
      await writeToHandle(handle);
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        throw err;
      }
      try {
        const { handle } = await this.openVerifiedHandle({
          path,
          flags: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          mode: 0o666,
          // Avoid delaying first write to freshly-created files; this keeps
          // directory watch events stable (add, then later unlink).
          verify: false,
        });
        try {
          await handle.writeFile(data as any);
        } finally {
          await handle.close();
        }
      } catch (createErr: any) {
        if (createErr?.code !== "EEXIST") {
          throw createErr;
        }
        const { handle } = await this.openVerifiedHandle({
          path,
          flags: constants.O_RDWR,
        });
        await writeToHandle(handle);
      }
    }
    if (saveLast === true && typeof data === "string") {
      globalSyncFsService.recordLocalWrite(p, data, true);
    }
  };

  writeFileDelta = async (..._args) => {
    const [path, content, options = {}] = _args as [
      string,
      string | Buffer,
      { baseContents?: string; minLength?: number; saveLast?: boolean },
    ];
    this.assertWritable(path);
    const { baseContents, minLength = 1024, saveLast } = options;
    if (
      typeof content !== "string" ||
      typeof baseContents !== "string" ||
      content.length <= minLength
    ) {
      await this.writeFile(path, content, saveLast);
      return;
    }
    if (baseContents === content) {
      return;
    }
    if (!baseContents.length || !content.length) {
      await this.writeFile(path, content, saveLast);
      return;
    }
    const patch = make_patch(baseContents, content);
    const sha = createHash("sha256")
      .update(Buffer.from(baseContents, "utf8"))
      .digest("hex");
    await this.writeFile(
      path,
      {
        patch,
        sha256: sha,
      },
      saveLast,
    );
  };

  // Heartbeat indicating a client is actively editing this path.
  syncFsWatch = async (
    path: string,
    active: boolean = true,
    info?: {
      project_id?: string;
      relativePath?: string;
      string_id?: string;
      history_epoch?: number;
      doctype?: any;
    },
  ): Promise<void> => {
    const abs = await this.resolveSandboxPath(path);
    const project_id = info?.project_id ?? this.host;
    const relativePath = info?.relativePath ?? path;
    const string_id =
      info?.string_id && info.string_id.length > 0 && project_id && relativePath
        ? info.string_id
        : project_id && relativePath
          ? client_db.sha1(project_id, relativePath)
          : undefined;
    await globalSyncFsService.heartbeat(abs, active, {
      project_id,
      relativePath,
      string_id,
      history_epoch: info?.history_epoch,
      doctype: info?.doctype,
    });
  };
}

// Shared watcher instance per process.
// TODO: location below is TEMPORARY -- just need something stable for now
const globalSyncFsService = new SyncFsService(
  new SyncFsWatchStore(join(data, "sync-fs.sqlite")),
);
globalSyncFsService.on("error", (err) => {
  logger.error("sync-fs-service error", err);
});

export class SandboxError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path: string;
  constructor(mesg: string, { code, errno, syscall, path }) {
    super(mesg);
    this.code = code;
    this.errno = errno;
    this.syscall = syscall;
    this.path = path;
  }
}

function capTimeout(options, max: number) {
  if (options == null) {
    return { timeout: max };
  }

  let timeout;
  try {
    timeout = parseFloat(options.timeout);
  } catch {
    return { ...options, timeout: max };
  }
  if (!isFinite(timeout)) {
    return { ...options, timeout: max };
  }
  return { ...options, timeout: Math.min(timeout, max) };
}

function isPatchRequest(data: unknown): data is PatchWriteRequest {
  if (data == null || typeof data !== "object") {
    return false;
  }
  if (Buffer.isBuffer(data)) {
    return false;
  }
  const candidate = data as PatchWriteRequest & { [key: string]: unknown };
  return (
    typeof candidate.patch !== "undefined" &&
    typeof candidate.sha256 === "string"
  );
}

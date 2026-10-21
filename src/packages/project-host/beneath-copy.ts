/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Host-side copies out of and into trees that a project user controls.

The project user can replace any directory in their home (or rootfs, or
scratch) with a symlink, at any moment. A path-based copy on the host (cp,
mkdir, rename, rm) follows such a link and reads or writes host files, or
another project's. Checking the path first is not enough: the link can be
planted after the check, and a check that only resolves existing paths misses
a symlinked parent of a destination that does not exist yet.

Every operation here goes through an openat2 SandboxRoot anchored at a trusted
root directory, which resolves each path beneath the root and refuses all
symlinks (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS): a planted link makes the copy
fail instead of redirecting it. Symlinks inside the copied tree are copied as
symlinks, never followed. File data is copied between the two opened file
descriptors (cloned where the filesystem supports it), and each file is written
to a temporary name and renamed into place, so a reader never sees a partial
file.

SandboxRoot has no readdir or readlink. Those open the directory by path with
O_NOFOLLOW, check that the opened directory is the very one (same device and
inode) that the anchored, symlink-free stat reaches, and then read it through
/proc/self/fd/N, which names that open directory however its path changes.
A directory outside the root can therefore never be listed, so its names can
neither decide what is copied nor leak.

A copy of something onto itself is refused, as by cp.
*/

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fchmodSync,
  futimesSync,
  openSync,
} from "node:fs";
import {
  copyFile,
  readdir,
  readlink,
  realpath,
  stat as pathStat,
} from "node:fs/promises";
import path from "node:path";
import { SandboxRoot } from "@cocalc/openat2";
import { runNativeFsTask } from "@cocalc/backend/sandbox/native-fs-limit";

// Like cp (backend/sandbox/cp.ts), a copy is bounded by its caller's
// operation; without a timeout it still stops after this long.
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// A trusted absolute root directory and a path beneath it ("" = the root).
export interface BeneathPath {
  root: string;
  path: string;
}

export interface BeneathCopyOptions {
  // Replace existing files (default). When false, existing entries are kept.
  force?: boolean;
  // With force false: fail if the destination itself already exists.
  errorOnExist?: boolean;
  preserveTimestamps?: boolean;
  // Required to copy a directory.
  recursive?: boolean;
  // Following symlinks on the host is exactly what this module prevents.
  dereference?: boolean;
  // Called before each entry is copied; throw from it to stop the copy (for
  // example once the caller's deadline has passed).
  checkpoint?: () => void;
  // Stop (between entries) once this many ms have passed; default 2 hours.
  // Then the copy fails and writes nothing more.
  timeout?: number;
}

type Kind = "missing" | "file" | "dir" | "symlink" | "other";

interface Entry {
  kind: Kind;
  mode: number;
  dev: number;
  ino: number;
  atimeNs: number;
  mtimeNs: number;
}

const NO_ENTRY = { mode: 0, dev: 0, ino: 0, atimeNs: 0, mtimeNs: 0 };

// The native addon reports the errno at the start of the message (its own
// `code` is a generic napi status); Node errors carry it in `code`.
function errorCode(err: unknown): string | undefined {
  return (
    `${(err as Error)?.message ?? ""}`.match(/^(E[A-Z]+)\b/)?.[1] ??
    (err as NodeJS.ErrnoException)?.code
  );
}

function codedError(code: string, message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = code;
  return err;
}

// Normalizes a relative path beneath a root; "" is the root itself. Paths are
// POSIX: a backslash is an ordinary character of a name.
export function beneathRelative(p: string): string {
  const normalized = path.posix.normalize(p);
  if (normalized === "." || normalized === "./" || normalized === "") {
    return "";
  }
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw codedError("EINVAL", `path is not beneath its root: ${p}`);
  }
  return normalized.replace(/\/+$/, "");
}

function kindOfMode(mode: number): Kind {
  const type = mode & constants.S_IFMT;
  if (type === constants.S_IFREG) return "file";
  if (type === constants.S_IFDIR) return "dir";
  return "other";
}

// What is at `rel` under `root`, without following any symlink. A symlinked
// parent directory throws ELOOP.
async function entryAt(
  sandbox: SandboxRoot,
  root: string,
  rel: string,
): Promise<Entry> {
  if (rel === "") {
    // The root itself is trusted (chosen by the host, not the project).
    const st = await pathStat(root, { bigint: true });
    return {
      kind: kindOfMode(Number(st.mode)),
      mode: Number(st.mode),
      dev: Number(st.dev),
      ino: Number(st.ino),
      atimeNs: Number(st.atimeNs),
      mtimeNs: Number(st.mtimeNs),
    };
  }
  const parent = path.posix.dirname(rel);
  if (parent !== ".") {
    // Must succeed as a symlink-free directory, so an ELOOP below is about
    // the final component itself.
    let st;
    try {
      st = sandbox.stat(parent);
    } catch (err) {
      if (errorCode(err) === "ENOENT") {
        return { kind: "missing", ...NO_ENTRY };
      }
      throw err;
    }
    if (kindOfMode(st.mode) !== "dir") {
      throw codedError("ENOTDIR", `not a directory: ${parent}`);
    }
  }
  try {
    const st = sandbox.stat(rel);
    return {
      kind: kindOfMode(st.mode),
      mode: st.mode,
      dev: st.dev,
      ino: st.ino,
      atimeNs: st.atimeNs,
      mtimeNs: st.mtimeNs,
    };
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") {
      return { kind: "missing", ...NO_ENTRY };
    }
    if (code === "ELOOP") {
      return { kind: "symlink", ...NO_ENTRY };
    }
    throw err;
  }
}

// Opens directory `rel` under `root` and returns its descriptor, after
// checking that it is the directory the anchored stat reaches: a symlink
// swapped into the path, before or after the open, makes this throw.
function openVerifiedDir(
  sandbox: SandboxRoot,
  root: string,
  rel: string,
): number {
  const fd = openSync(
    rel === "" ? root : path.join(root, rel),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (rel !== "") {
      const anchored = sandbox.stat(rel);
      const opened = fstatSync(fd);
      if (opened.dev !== anchored.dev || opened.ino !== anchored.ino) {
        throw codedError("ELOOP", `directory changed while copying: ${rel}`);
      }
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

async function readdirBeneath(
  sandbox: SandboxRoot,
  root: string,
  rel: string,
): Promise<string[]> {
  const fd = openVerifiedDir(sandbox, root, rel);
  try {
    return await readdir(`/proc/self/fd/${fd}`);
  } finally {
    closeSync(fd);
  }
}

async function readlinkBeneath(
  sandbox: SandboxRoot,
  root: string,
  rel: string,
): Promise<string> {
  const parent = path.posix.dirname(rel);
  const fd = openVerifiedDir(sandbox, root, parent === "." ? "" : parent);
  try {
    return await readlink(`/proc/self/fd/${fd}/${path.posix.basename(rel)}`);
  } finally {
    closeSync(fd);
  }
}

// Whether two entries are the same file or directory (symlinks carry no
// identity here).
function sameEntry(a: Entry, b: Entry): boolean {
  return (
    (a.kind === "file" || a.kind === "dir") &&
    a.kind === b.kind &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

function sameFileError(src: string, dest: string): NodeJS.ErrnoException {
  const err = codedError(
    "ERR_FS_CP_EINVAL",
    `Invalid src or dest: cp returned EINVAL (src and dest cannot be the same) '${src}' -> '${dest}'`,
  );
  err.path = dest;
  return err;
}

// A temporary name next to `rel`, of fixed length whatever the length of
// rel's own name (which may already be the maximum).
function tempSibling(rel: string): string {
  const name = `.cocalc-copy-${randomUUID()}`;
  const parent = path.posix.dirname(rel);
  return parent === "." ? name : path.posix.join(parent, name);
}

function existsError(rel: string): NodeJS.ErrnoException {
  const err = codedError(
    "ERR_FS_CP_EEXIST",
    "SystemError [ERR_FS_CP_EEXIST]: Target already exists",
  );
  err.path = rel;
  return err;
}

class Copier {
  private readonly src: SandboxRoot;
  private readonly dest: SandboxRoot;

  private readonly deadline: number;

  constructor(
    private readonly srcRoot: string,
    private readonly destRoot: string,
    private readonly options: BeneathCopyOptions,
    // The destination of the whole copy, which errorOnExist is about.
    private readonly topRel: string,
  ) {
    this.src = new SandboxRoot(srcRoot);
    this.dest = new SandboxRoot(destRoot);
    this.deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT_MS);
  }

  private get force(): boolean {
    return this.options.force ?? true;
  }

  // Without force, an existing entry at `rel` is kept: true to skip it, or
  // ERR_FS_CP_EEXIST when it is the destination and errorOnExist is set.
  private keepExisting(rel: string): boolean {
    if (this.options.errorOnExist && rel === this.topRel) {
      throw existsError(rel);
    }
    return true;
  }

  // Puts the temporary entry `tmp` at `rel`: over an existing non-directory
  // when forcing, otherwise only if nothing is there at that moment (the
  // check and the placement are one rename).
  private place(tmp: string, rel: string): void {
    if (this.force) {
      this.dest.rename(tmp, rel);
      return;
    }
    try {
      this.dest.renameNoReplace(tmp, rel);
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      this.dest.unlink(tmp);
      this.keepExisting(rel);
    }
  }

  private async copyFile(
    srcRel: string,
    entry: Entry,
    destRel: string,
  ): Promise<void> {
    const destEntry = await entryAt(this.dest, this.destRoot, destRel);
    if (destEntry.kind === "dir") {
      throw codedError(
        "ERR_FS_CP_NON_DIR_TO_DIR",
        `Cannot overwrite directory '${destRel}' with non-directory '${srcRel}'`,
      );
    }
    if (sameEntry(destEntry, entry)) {
      throw sameFileError(srcRel, destRel);
    }
    if (destEntry.kind !== "missing" && !this.force) {
      this.keepExisting(destRel);
      return;
    }

    const tmp = tempSibling(destRel);
    const srcFd = this.src.openRead(srcRel);
    let created = false;
    try {
      const destFd = this.dest.openWrite(tmp, true, true, false, 0o600);
      created = true;
      try {
        // Both ends are the descriptors opened beneath their roots; the
        // /proc/self/fd links name exactly those open files.
        // A non-cloned copy occupies a libuv worker for its whole length:
        // share the sandbox's bound on such operations.
        await runNativeFsTask(() =>
          copyFile(
            `/proc/self/fd/${srcFd}`,
            `/proc/self/fd/${destFd}`,
            constants.COPYFILE_FICLONE,
          ),
        );
        // Permission bits only: never setuid/setgid from a project's file.
        fchmodSync(destFd, (fstatSync(srcFd).mode ?? entry.mode) & 0o777);
        if (this.options.preserveTimestamps) {
          futimesSync(
            destFd,
            new Date(entry.atimeNs / 1e6),
            new Date(entry.mtimeNs / 1e6),
          );
        }
      } finally {
        closeSync(destFd);
      }
      this.place(tmp, destRel);
      created = false;
    } finally {
      closeSync(srcFd);
      if (created) {
        try {
          this.dest.unlink(tmp);
        } catch {}
      }
    }
  }

  private async copySymlink(srcRel: string, destRel: string): Promise<void> {
    if (this.options.dereference) {
      throw codedError(
        "ENOTSUP",
        `cannot follow the symlink '${srcRel}' when copying between projects`,
      );
    }
    const destEntry = await entryAt(this.dest, this.destRoot, destRel);
    if (destEntry.kind === "dir") {
      throw codedError(
        "ERR_FS_CP_NON_DIR_TO_DIR",
        `Cannot overwrite directory '${destRel}' with non-directory '${srcRel}'`,
      );
    }
    if (destEntry.kind !== "missing" && !this.force) {
      this.keepExisting(destRel);
      return;
    }
    const target = await readlinkBeneath(this.src, this.srcRoot, srcRel);
    const tmp = tempSibling(destRel);
    this.dest.symlink(target, tmp);
    try {
      this.place(tmp, destRel);
    } catch (err) {
      try {
        this.dest.unlink(tmp);
      } catch {}
      throw err;
    }
  }

  private async copyDir(
    srcRel: string,
    entry: Entry,
    destRel: string,
  ): Promise<void> {
    if (!this.options.recursive) {
      throw codedError(
        "EISDIR",
        `EISDIR: recursive option is required to copy a directory: '${srcRel}' -> '${destRel}'`,
      );
    }
    let destEntry = await entryAt(this.dest, this.destRoot, destRel);
    if (destEntry.kind === "symlink") {
      if (!this.force) {
        this.keepExisting(destRel);
        return;
      }
      this.dest.unlink(destRel);
      destEntry = { ...destEntry, kind: "missing" };
    }
    if (destEntry.kind === "file" || destEntry.kind === "other") {
      throw codedError(
        "ENOTDIR",
        `cannot overwrite non-directory '${destRel}' with directory '${srcRel}'`,
      );
    }
    if (sameEntry(destEntry, entry)) {
      throw sameFileError(srcRel, destRel);
    }
    let created = destEntry.kind === "missing";
    if (created) {
      if (destRel === "") {
        throw codedError("EINVAL", "copy destination root does not exist");
      }
      try {
        // Writable by us while filling it; its mode is set at the end.
        this.dest.mkdir(destRel, false, 0o700);
      } catch (err) {
        if (errorCode(err) !== "EEXIST") throw err;
        // Created meanwhile: the same rules as if it had been there.
        if (!this.force) this.keepExisting(destRel);
        if ((await entryAt(this.dest, this.destRoot, destRel)).kind !== "dir") {
          throw codedError(
            "ENOTDIR",
            `cannot overwrite non-directory '${destRel}' with directory '${srcRel}'`,
          );
        }
        created = false;
      }
    }

    const names = await readdirBeneath(this.src, this.srcRoot, srcRel);
    for (const name of names) {
      await this.copyEntry(
        srcRel === "" ? name : path.posix.join(srcRel, name),
        destRel === "" ? name : path.posix.join(destRel, name),
      );
    }

    if (created && destRel !== "") {
      this.dest.chmod(destRel, entry.mode & 0o777);
    }
    if (this.options.preserveTimestamps && destRel !== "") {
      this.dest.utimes(destRel, entry.atimeNs, entry.mtimeNs);
    }
  }

  async copyEntry(srcRel: string, destRel: string): Promise<void> {
    if (Date.now() > this.deadline) {
      throw codedError(
        "ETIMEDOUT",
        `copy stopped after ${this.options.timeout ?? DEFAULT_TIMEOUT_MS} ms`,
      );
    }
    this.options.checkpoint?.();
    const entry = await entryAt(this.src, this.srcRoot, srcRel);
    switch (entry.kind) {
      case "missing":
        throw codedError(
          "ENOENT",
          `ENOENT: no such file or directory, copy '${srcRel}'`,
        );
      case "file":
        return await this.copyFile(srcRel, entry, destRel);
      case "dir":
        return await this.copyDir(srcRel, entry, destRel);
      case "symlink":
        return await this.copySymlink(srcRel, destRel);
      default:
        // Sockets, FIFOs and devices: fail rather than copy only part.
        throw codedError(
          "EINVAL",
          `Unsupported source file type for cp: '${srcRel}'`,
        );
    }
  }

  async run(srcRel: string): Promise<void> {
    if (!this.force && this.options.errorOnExist) {
      const destEntry = await entryAt(this.dest, this.destRoot, this.topRel);
      if (destEntry.kind !== "missing") throw existsError(this.topRel);
    }
    await this.copyEntry(srcRel, this.topRel);
  }
}

// Copies `src` to exactly `dest` (cp -T semantics): a file replaces a file, a
// directory is merged into an existing directory. Missing parent directories
// of `dest` are created.
export async function copyBeneath({
  src,
  dest,
  options = {},
}: {
  src: BeneathPath;
  dest: BeneathPath;
  options?: BeneathCopyOptions;
}): Promise<void> {
  const destRel = beneathRelative(dest.path);
  const srcRel = await assertDistinctBeneath(src, dest);
  const parent = path.posix.dirname(destRel);
  if (destRel !== "" && parent !== ".") {
    new SandboxRoot(dest.root).mkdir(parent, true, 0o755);
  }
  await new Copier(src.root, dest.root, options, destRel).run(srcRel);
}

// Refuses (as cp does) to copy something onto itself or into itself: the same
// path, a destination inside the source, or the same file or directory by
// device and inode (a hard link, another name for the root). Returns the
// normalized source path.
export async function assertDistinctBeneath(
  src: BeneathPath,
  dest: BeneathPath,
): Promise<string> {
  const srcRel = beneathRelative(src.path);
  const destRel = beneathRelative(dest.path);
  // The roots are trusted, so resolving them by path is fine.
  const [srcReal, destReal] = await Promise.all([
    realpath(src.root),
    realpath(dest.root),
  ]);
  if (
    srcReal === destReal &&
    (srcRel === destRel || srcRel === "" || destRel.startsWith(`${srcRel}/`))
  ) {
    throw codedError(
      "EINVAL",
      `cannot copy '${srcRel}' into itself ('${destRel}')`,
    );
  }
  const [srcEntry, destEntry] = await Promise.all([
    entryAt(new SandboxRoot(src.root), src.root, srcRel),
    entryAt(new SandboxRoot(dest.root), dest.root, destRel),
  ]);
  if (sameEntry(srcEntry, destEntry)) {
    throw sameFileError(srcRel, destRel);
  }
  return srcRel;
}

// What is at `rel` under `root`, as for copyBeneath: "symlink" for a symlink
// at `rel` itself; a symlinked parent directory throws ELOOP.
export async function kindBeneath(root: string, rel: string): Promise<Kind> {
  return (await entryAt(new SandboxRoot(root), root, beneathRelative(rel)))
    .kind;
}

// Creates directory `rel` (and missing parents) under `root`.
export function mkdirBeneath(root: string, rel: string, mode = 0o755): void {
  new SandboxRoot(root).mkdir(beneathRelative(rel), true, mode);
}

// Renames within `root`. With noReplace, fails with EEXIST if `to` exists.
export function renameBeneath(
  root: string,
  from: string,
  to: string,
  { noReplace = false }: { noReplace?: boolean } = {},
): void {
  const sandbox = new SandboxRoot(root);
  if (noReplace) {
    sandbox.renameNoReplace(beneathRelative(from), beneathRelative(to));
  } else {
    sandbox.rename(beneathRelative(from), beneathRelative(to));
  }
}

// Removes `rel` under `root` recursively, if present, never following links.
export async function rmBeneath(root: string, rel: string): Promise<void> {
  try {
    const sandbox = new SandboxRoot(root);
    await runNativeFsTask(() => sandbox.rm(beneathRelative(rel), true, true));
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
}

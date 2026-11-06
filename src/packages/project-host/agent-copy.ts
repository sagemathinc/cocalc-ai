/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Installing a restored copy into a separate-uid project's rootfs (R1 PR3b,
design R4/S2): the host restores into its own private staging directory as
always, then sends the tree, entry by entry, to the project's rootfs agent,
which writes it as the project user inside the project's container. The
host never touches the project's rootfs itself.

The semantics are those of beneath-copy.ts's Copier (cp -T merge: a file
replaces a file, a directory merges into a directory; force, errorOnExist,
preserveTimestamps, recursive, no dereference) and, for `exact` copies, of
path-copy-archive.ts's replacePathFromStaging (a hidden incoming sibling,
then the old destination moved aside). One difference, stated: placing a
directory without replacing is a check and then a rename, not one atomic
step (Node has no renameat2), so the project's own processes could race it;
that affects only the project's own files.

S2: the agent's answers decide only this copy's outcome. The staging
directory is removed by the caller's own bookkeeping, whatever the agent
says, and nothing else on the host follows from its replies.
*/

import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AgentLike {
  call(
    op: string,
    args: Record<string, unknown>,
    data?: Buffer,
  ): Promise<{ result: unknown; data?: Buffer }>;
}

export interface AgentCopyOptions {
  force?: boolean;
  errorOnExist?: boolean;
  preserveTimestamps?: boolean;
  recursive?: boolean;
  dereference?: boolean;
  // throws once the copy must stop (the claim's budget)
  checkpoint?: () => void;
}

// R4: recursive copies are bounded in entries and bytes; one file is bounded
// by what the agent writes in one request.
export const AGENT_COPY_LIMITS = {
  maxEntries: 1_000_000,
  maxBytes: 10 * 1024 ** 3,
  maxFileBytes: 64 * 1024 * 1024,
};

const KEPT_MODE = 0o1777; // never setuid/setgid from a project's file

type Kind = "missing" | "file" | "dir" | "symlink" | "other";

function coded(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function existsError(rel: string): NodeJS.ErrnoException {
  const err = coded(
    "ERR_FS_CP_EEXIST",
    "SystemError [ERR_FS_CP_EEXIST]: Target already exists",
  );
  err.path = rel;
  return err;
}

const codeOf = (err: unknown) => (err as { code?: string })?.code;

class AgentCopier {
  private entries = 0;
  private bytes = 0;

  constructor(
    private readonly agent: AgentLike,
    private readonly options: AgentCopyOptions,
    // the destination of the whole copy (a container path)
    private readonly top: string,
  ) {}

  private get force(): boolean {
    return this.options.force ?? true;
  }

  private check(): void {
    this.options.checkpoint?.();
  }

  private async destKind(p: string): Promise<Kind> {
    try {
      const { result } = await this.agent.call("lstat", { path: p });
      const type = (result as { type?: string })?.type;
      return type === "file" || type === "dir" || type === "symlink"
        ? type
        : "other";
    } catch (err) {
      if (codeOf(err) === "ENOENT") return "missing";
      throw err;
    }
  }

  private refuseExistingTop(kind: Kind, dest: string): void {
    if (
      kind !== "missing" &&
      !this.force &&
      this.options.errorOnExist &&
      dest === this.top
    ) {
      throw existsError(dest);
    }
  }

  private keepExisting(dest: string): void {
    if (this.options.errorOnExist && dest === this.top) throw existsError(dest);
  }

  private count(bytes = 0): void {
    this.entries += 1;
    this.bytes += bytes;
    if (this.entries > AGENT_COPY_LIMITS.maxEntries) {
      throw coded("E2BIG", "copy has too many entries");
    }
    if (this.bytes > AGENT_COPY_LIMITS.maxBytes) {
      throw coded("EFBIG", "copy is too large");
    }
  }

  private async copyFile(src: string, mode: number, dest: string) {
    const kind = await this.destKind(dest);
    this.refuseExistingTop(kind, dest);
    if (kind === "dir") {
      throw coded(
        "ERR_FS_CP_NON_DIR_TO_DIR",
        `Cannot overwrite directory '${dest}' with non-directory`,
      );
    }
    if (kind !== "missing" && !this.force) return this.keepExisting(dest);
    // the host's own staging: opened without following a symlink
    const fh = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Buffer;
    let st;
    try {
      st = await fh.stat();
      if (!st.isFile()) throw coded("EINVAL", "not a regular file");
      if (st.size > AGENT_COPY_LIMITS.maxFileBytes) {
        throw coded(
          "EFBIG",
          `'${dest}' is too large to copy into a separate-uid project's rootfs yet`,
        );
      }
      this.count(st.size);
      data = await fh.readFile();
    } finally {
      await fh.close();
    }
    this.check();
    try {
      await this.agent.call(
        "writeFile",
        {
          path: dest,
          mode: (st.mode ?? mode) & KEPT_MODE,
          ...(this.force ? {} : { noReplace: true }),
          ...(this.options.preserveTimestamps
            ? {
                atime: Math.floor(st.atimeMs / 1000),
                mtime: Math.floor(st.mtimeMs / 1000),
              }
            : {}),
        },
        data,
      );
    } catch (err) {
      if (codeOf(err) !== "EEXIST" || this.force) throw err;
      this.keepExisting(dest); // created meanwhile: kept
    }
  }

  private async copySymlink(src: string, dest: string) {
    if (this.options.dereference) {
      throw coded(
        "ENOTSUP",
        `cannot follow the symlink '${path.basename(src)}' when copying between projects`,
      );
    }
    const kind = await this.destKind(dest);
    this.refuseExistingTop(kind, dest);
    if (kind === "dir") {
      throw coded(
        "ERR_FS_CP_NON_DIR_TO_DIR",
        `Cannot overwrite directory '${dest}' with non-directory`,
      );
    }
    if (kind !== "missing" && !this.force) return this.keepExisting(dest);
    this.count();
    const target = await readlink(src);
    this.check();
    try {
      await this.agent.call("symlink", {
        path: dest,
        target,
        ...(this.force ? {} : { noReplace: true }),
      });
    } catch (err) {
      if (codeOf(err) !== "EEXIST" || this.force) throw err;
      this.keepExisting(dest);
    }
  }

  private async copyDir(
    src: string,
    mode: number,
    times: number[],
    dest: string,
  ) {
    if (!this.options.recursive) {
      throw coded(
        "EISDIR",
        `EISDIR: recursive option is required to copy a directory: '${dest}'`,
      );
    }
    let kind = await this.destKind(dest);
    this.refuseExistingTop(kind, dest);
    if (kind === "symlink") {
      if (!this.force) return this.keepExisting(dest);
      await this.agent.call("unlink", { path: dest });
      kind = "missing";
    }
    if (kind === "file" || kind === "other") {
      throw coded(
        "ENOTDIR",
        `cannot overwrite non-directory '${dest}' with directory`,
      );
    }
    this.count();
    let created = kind === "missing";
    if (created) {
      try {
        // writable by us while filling it; its mode is set at the end
        await this.agent.call("mkdir", { path: dest, mode: 0o700 });
      } catch (err) {
        if (codeOf(err) !== "EEXIST") throw err;
        if (!this.force) this.keepExisting(dest);
        if ((await this.destKind(dest)) !== "dir") {
          throw coded(
            "ENOTDIR",
            `cannot overwrite non-directory '${dest}' with directory`,
          );
        }
        created = false;
      }
    }
    const names = (await readdir(src)).sort();
    for (const name of names) {
      await this.copyEntry(path.join(src, name), path.posix.join(dest, name));
    }
    if (created) {
      await this.agent.call("chmod", { path: dest, mode: mode & KEPT_MODE });
    }
    if (this.options.preserveTimestamps) {
      await this.agent.call("utimes", {
        path: dest,
        atime: times[0],
        mtime: times[1],
      });
    }
  }

  async copyEntry(src: string, dest: string): Promise<void> {
    this.check();
    let st;
    try {
      st = await lstat(src);
    } catch (err) {
      if (codeOf(err) === "ENOENT") {
        throw coded("ENOENT", `ENOENT: no such file or directory, copy`);
      }
      throw err;
    }
    if (st.isFile()) return await this.copyFile(src, st.mode, dest);
    if (st.isSymbolicLink()) return await this.copySymlink(src, dest);
    if (st.isDirectory()) {
      return await this.copyDir(
        src,
        st.mode,
        [Math.floor(st.atimeMs / 1000), Math.floor(st.mtimeMs / 1000)],
        dest,
      );
    }
    throw coded("EINVAL", `Unsupported source file type for cp`);
  }

  async run(src: string): Promise<void> {
    if (!this.force && this.options.errorOnExist) {
      if ((await this.destKind(this.top)) !== "missing") {
        throw existsError(this.top);
      }
    }
    await this.copyEntry(src, this.top);
  }
}

function containerParent(p: string): string {
  return path.posix.dirname(p);
}

/** Copies the staged `src` to exactly `dest` (cp -T), through the agent. */
export async function copyThroughAgent({
  src,
  agent,
  dest,
  options = {},
}: {
  src: string;
  agent: AgentLike;
  dest: string;
  options?: AgentCopyOptions;
}): Promise<void> {
  if (dest === "/")
    throw coded("EINVAL", "copy destination cannot be the root");
  const parent = containerParent(dest);
  if (parent !== "/") {
    await agent.call("mkdir", { path: parent, recursive: true, mode: 0o755 });
  }
  await new AgentCopier(agent, options, dest).run(src);
}

/**
 * Installs the staged `src` at `dest` in the project's rootfs, through its
 * agent. Ordinary copies merge (cp -T); `exact` copies replace the
 * destination: copied to a hidden sibling first, then the old destination
 * moved aside and the copy renamed into place. Returns false when an exact
 * no-clobber copy finds the destination there.
 */
export async function installThroughAgent({
  src,
  agent,
  dest,
  exact,
  options = {},
}: {
  src: string;
  agent: AgentLike;
  dest: string;
  exact?: boolean;
  options?: AgentCopyOptions;
}): Promise<boolean> {
  if (!exact) {
    await copyThroughAgent({
      src,
      agent,
      dest,
      options: { ...options, recursive: options.recursive ?? true },
    });
    return true;
  }
  if (dest === "/")
    throw coded("EINVAL", "copy destination cannot be the root");
  const force = options.force ?? true;
  const kindOf = async (p: string) => {
    try {
      await agent.call("lstat", { path: p });
      return true;
    } catch (err) {
      if (codeOf(err) === "ENOENT") return false;
      throw err;
    }
  };
  if ((await kindOf(dest)) && !force) {
    if (options.errorOnExist) throw existsError(dest);
    return false;
  }
  const parent = containerParent(dest);
  const token = randomUUID();
  const sibling = (kind: string) =>
    path.posix.join(parent, `.cocalc-${kind}-${token}`);
  const incoming = sibling("incoming");
  try {
    await copyThroughAgent({
      src,
      agent,
      dest: incoming,
      options: {
        ...options,
        recursive: options.recursive ?? true,
        force: true,
        errorOnExist: false,
      },
    });
    // placed only if nothing is there (a check, then the rename: see above)
    const place = async () => {
      options.checkpoint?.();
      if (await kindOf(dest)) throw coded("EEXIST", "EEXIST");
      await agent.call("rename", { path: incoming, dest });
    };
    try {
      await place();
      return true;
    } catch (err) {
      if (codeOf(err) !== "EEXIST") throw err;
    }
    if (!force) {
      if (options.errorOnExist) throw existsError(dest);
      return false;
    }
    const asides: string[] = [];
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt >= 5) {
          throw new Error(
            `copy destination ${dest} kept changing; not replaced`,
          );
        }
        const aside = sibling(`previous${attempt}`);
        try {
          await agent.call("rename", { path: dest, dest: aside });
          asides.push(aside);
        } catch (err) {
          if (codeOf(err) !== "ENOENT") throw err;
        }
        try {
          await place();
          break;
        } catch (err) {
          if (codeOf(err) !== "EEXIST") throw err;
        }
      }
    } catch (err) {
      if (asides.length > 0) {
        try {
          if (!(await kindOf(dest))) {
            await agent.call("rename", { path: asides[0], dest });
          } else {
            throw coded("EEXIST", "EEXIST");
          }
        } catch (restoreErr) {
          throw new Error(
            `copy replacement failed for ${dest}: ${err}; the previous one is kept at ${asides[0]} (${restoreErr})`,
          );
        }
      }
      throw err;
    }
    for (const aside of asides) {
      await agent
        .call("rm", { path: aside, recursive: true, force: true })
        .catch(() => {});
    }
    return true;
  } finally {
    await agent
      .call("rm", { path: incoming, recursive: true, force: true })
      .catch(() => {});
  }
}

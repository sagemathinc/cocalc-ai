/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Rootfs file operations for a project that runs with a separate runtime uid.

Its rootfs is reachable only from inside its own container, so a sandbox
given a rootfs agent (project-runner's rootfs-agent, which runs there as the
project user) sends the operations below to it, with every path translated
to what the container sees. Any other operation on a rootfs path fails with
an explicit error before touching the disk: nothing under the project's
rootfs is ever accessed from the host for such a project.

The agent's answers have been schema-checked by its client; here they are
only reshaped into what the sandbox's callers expect.
*/

import { posix } from "node:path";

export interface RootfsAgentOps {
  call(
    op: string,
    args: Record<string, unknown>,
    data?: Buffer,
  ): Promise<{ result: unknown; data?: Buffer }>;
}

export function rootfsNotAvailableError(path: string): Error {
  return new Error(
    `files outside HOME (such as '${path}') are not available yet for projects that run with a separate runtime uid`,
  );
}

// Which arguments of a sandbox method are paths (default: the first).
const PATH_ARGS: Record<string, number[]> = {
  rename: [0, 1],
  move: [0, 1],
  copyFile: [0, 1],
  cp: [0, 1],
  link: [0, 1],
  symlink: [1],
  constants: [],
};

/** The project-visible paths among a method's arguments. */
export function pathArguments(method: string, args: unknown[]): string[] {
  const out: string[] = [];
  for (const i of PATH_ARGS[method] ?? [0]) {
    const a = args[i];
    if (typeof a === "string") out.push(a);
    else if (Array.isArray(a)) {
      for (const x of a) if (typeof x === "string") out.push(x);
    } else if (a != null && typeof a === "object") {
      const p = (a as { path?: unknown }).path;
      if (typeof p === "string") out.push(p);
    }
  }
  return out;
}

export interface PathClassifier {
  homeAliases: string[];
  hasScratch: boolean;
  hasSharedScratch: boolean;
  // where HOME is inside the container
  containerHome: string;
}

/**
 * Lexically (never touching the disk), as resolvePathInSandbox does: the
 * container path of a rootfs path, or undefined for HOME, /tmp (scratch) and
 * /scratch.
 */
export function rootfsContainerPath(
  path: string,
  c: PathClassifier,
): string | undefined {
  if (!path.startsWith("/")) return undefined;
  const resolved = posix.resolve("/", path);
  const under = (prefix: string) =>
    resolved === prefix || resolved.startsWith(`${prefix}/`);
  if (c.homeAliases.some(under)) return undefined;
  if (c.hasScratch && under("/tmp")) return undefined;
  if (under("/scratch")) return undefined;
  return resolved;
}

/** Any project path as the container sees it. */
export function containerPath(path: string, c: PathClassifier): string {
  if (!path.startsWith("/")) {
    return posix.resolve(c.containerHome, path);
  }
  const resolved = posix.resolve("/", path);
  for (const alias of c.homeAliases) {
    if (resolved === alias) return c.containerHome;
    if (resolved.startsWith(`${alias}/`)) {
      return posix.join(c.containerHome, resolved.slice(alias.length + 1));
    }
  }
  return resolved;
}

const WRITES = new Set([
  "writeFile",
  "mkdir",
  "rm",
  "rmdir",
  "unlink",
  "rename",
  "chmod",
  "utimes",
]);

export const ROUTED_METHODS = new Set([
  "stat",
  "lstat",
  "exists",
  "readdir",
  "readFile",
  "readlink",
  "realpath",
  ...WRITES,
]);

export function isWriteMethod(method: string): boolean {
  return WRITES.has(method);
}

interface AgentStat {
  type: "file" | "dir" | "symlink" | "other";
  mode: number;
  uid: number;
  gid: number;
  size: number;
  nlink: number;
  ino: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
}

/** A Stats-like object (its methods don't cross the RPC; its fields do). */
export function toStats(s: AgentStat) {
  const stats = {
    dev: 0,
    ino: s.ino,
    mode: s.mode,
    nlink: s.nlink,
    uid: s.uid,
    gid: s.gid,
    rdev: 0,
    size: s.size,
    blksize: 4096,
    blocks: Math.ceil(s.size / 512),
    atimeMs: s.atimeMs,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    birthtimeMs: s.ctimeMs,
    atime: new Date(s.atimeMs),
    mtime: new Date(s.mtimeMs),
    ctime: new Date(s.ctimeMs),
    birthtime: new Date(s.ctimeMs),
  };
  for (const [name, type] of [
    ["isFile", "file"],
    ["isDirectory", "dir"],
    ["isSymbolicLink", "symlink"],
  ] as const) {
    Object.defineProperty(stats, name, { value: () => s.type === type });
  }
  for (const name of [
    "isBlockDevice",
    "isCharacterDevice",
    "isFIFO",
    "isSocket",
  ]) {
    Object.defineProperty(stats, name, { value: () => false });
  }
  return stats;
}

function parseMode(mode: unknown): number {
  if (typeof mode === "number" && Number.isSafeInteger(mode)) return mode;
  if (typeof mode === "string" && /^(0o)?[0-7]+$/i.test(mode.trim())) {
    return parseInt(mode.trim().replace(/^0o/i, ""), 8);
  }
  throw new Error("invalid mode");
}

function seconds(t: unknown): number {
  if (t instanceof Date) return Math.floor(t.getTime() / 1000);
  if (typeof t === "number" && Number.isFinite(t)) return Math.floor(t);
  if (typeof t === "string" && t.trim() !== "" && Number.isFinite(Number(t))) {
    return Math.floor(Number(t));
  }
  throw new Error("invalid time");
}

/** Runs a routed sandbox method through the agent. */
export async function callThroughAgent(
  agent: RootfsAgentOps,
  method: string,
  args: any[],
  c: PathClassifier,
): Promise<unknown> {
  const p = (i: number) => containerPath(args[i], c);
  const run = async (op: string, a: Record<string, unknown>, data?: Buffer) =>
    (await agent.call(op, a, data)).result;
  switch (method) {
    case "stat":
    case "lstat":
      return toStats((await run(method, { path: p(0) })) as AgentStat);
    case "exists":
      try {
        await run("stat", { path: p(0) });
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return false;
        throw err;
      }
    case "readdir": {
      const dir = p(0);
      const { entries, truncated } = (await run("readdir", { path: dir })) as {
        entries: { name: string; type: AgentStat["type"] }[];
        truncated: boolean;
      };
      if (truncated) {
        throw new Error(`'${args[0]}' has too many entries to list`);
      }
      if (!args[1]?.withFileTypes) return entries.map((e) => e.name);
      return entries.map((e) => {
        const dirent = { name: e.name, parentPath: args[0], path: args[0] };
        for (const [name, type] of [
          ["isFile", "file"],
          ["isDirectory", "dir"],
          ["isSymbolicLink", "symlink"],
        ] as const) {
          Object.defineProperty(dirent, name, { value: () => e.type === type });
        }
        return dirent;
      });
    }
    case "readFile": {
      const { data } = await agent.call("readFile", { path: p(0) });
      const encoding =
        typeof args[1] === "string" ? args[1] : args[1]?.encoding;
      return encoding ? data!.toString(encoding) : data!;
    }
    case "readlink":
      return await run("readlink", { path: p(0) });
    case "realpath":
      return await run("realpath", { path: p(0) });
    case "writeFile": {
      const data =
        typeof args[1] === "string"
          ? Buffer.from(args[1])
          : Buffer.from(args[1]);
      await run("writeFile", { path: p(0) }, data);
      return undefined;
    }
    case "mkdir":
      await run("mkdir", {
        path: p(0),
        recursive: args[1]?.recursive === true,
        ...(args[1]?.mode != null ? { mode: parseMode(args[1].mode) } : {}),
      });
      return undefined;
    case "rm": {
      const paths = Array.isArray(args[0]) ? args[0] : [args[0]];
      for (const one of paths) {
        await run("rm", {
          path: containerPath(one, c),
          recursive: args[1]?.recursive === true,
          force: args[1]?.force === true,
        });
      }
      return undefined;
    }
    case "rmdir":
    case "unlink":
      await run(method, { path: p(0) });
      return undefined;
    case "rename":
      await run("rename", { path: p(0), dest: p(1) });
      return undefined;
    case "chmod":
      await run("chmod", { path: p(0), mode: parseMode(args[1]) });
      return undefined;
    case "utimes":
      await run("utimes", {
        path: p(0),
        atime: seconds(args[1]),
        mtime: seconds(args[2]),
      });
      return undefined;
    default:
      throw rootfsNotAvailableError(`${args[0]}`);
  }
}

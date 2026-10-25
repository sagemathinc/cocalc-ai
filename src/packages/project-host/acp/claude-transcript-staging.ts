/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Claude keeps its transcripts in the project's home, but the controller
container must never bind-mount a directory there: podman resolves a mount
source by its path when the container starts, after any check of ours, so the
project could rename a component of that path into a symlink and have the
host mount some other directory (another project's, or the host's) into the
controller. Mount sources naming an open descriptor do not help: rootless
podman cannot use them.

So the container mounts a host-owned staging directory, and transcripts move
between it and the project's home only through the openat2 no-follow helpers
(beneath-copy): in when the controller starts, and back out when each turn
completes (before the turn reports success) and when it stops. Only regular
files and directories cross, in either direction, each file copied from the
descriptor openat2 opened, so a symlink or FIFO is never copied or followed,
even one swapped in mid-copy. The staged tree is bounded in size: the host's
disk is not the project's quota.
*/

import { mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { projectPoolCgroupPath } from "@cocalc/project-runner/run/project-pool-cgroup";
import {
  copyRegularFileBeneath,
  kindBeneath,
  listBeneath,
  type FileIdentity,
} from "../beneath-copy";
import {
  claudeTranscriptStagingPrefix,
  claudeTranscriptStagingProject,
} from "./claude-subscription-paths";

const logger = getLogger("project-host:claude-transcript-staging");

// One walk visits at most this many entries, so a project cannot make the
// host walk (or copy) without end.
export const MAX_TRANSCRIPT_ENTRIES = 100_000;

// The staged tree may hold at most this many bytes (copied in, or written by
// the controller and checked when a turn completes).
export function maxTranscriptBytes(): number {
  const configured = Number(process.env.COCALC_CLAUDE_TRANSCRIPT_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 1024 ** 3;
}

function positiveSetting(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : fallback;
}

// Measured on a prod host (October 2026): a Claude controller's processes hold
// about 0.5 GiB resident, and it mostly waits on the model, so memory, not CPU,
// bounds how many can run.
const CONTROLLER_MEMORY_BYTES = 512 * 1024 ** 2;
const CONTROLLERS_PER_CPU = 32;
// Even a small project can hold a second conversation while an idle one waits
// to be disposed.
const MIN_PROJECT_STAGINGS = 2;

// The default limits for a host with this many CPUs and this much memory for
// projects (controllers run in the project pool's cgroup, so it is the pool's
// memory limit when it has one, below the host's RAM), and a project with this
// memory limit (their memory counts against it too; undefined when it has
// none).
export function defaultTranscriptStagings({
  cpus,
  memoryBytes,
  projectMemoryBytes,
}: {
  cpus: number;
  memoryBytes: number;
  projectMemoryBytes?: number;
}): { host: number; project: number } {
  const host = Math.max(
    1,
    Math.min(
      CONTROLLERS_PER_CPU * cpus,
      Math.floor(memoryBytes / CONTROLLER_MEMORY_BYTES),
    ),
  );
  const project =
    projectMemoryBytes == null
      ? host
      : Math.min(
          host,
          Math.max(
            MIN_PROJECT_STAGINGS,
            Math.floor(projectMemoryBytes / CONTROLLER_MEMORY_BYTES),
          ),
        );
  return { host, project };
}

// A cgroup's memory.max, or undefined when it has no limit (or cannot be read).
async function cgroupMemoryLimit(cgroup: string): Promise<number | undefined> {
  try {
    const raw = await readFile(join(cgroup, "memory.max"), "utf8");
    const value = Number(raw.trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

// At most this many staging directories may exist on the host, and this many
// for one project, counting copies kept after a failed copy back (which the
// reaper removes once they are old): with the byte bound, this bounds the
// host disk they use. Every live Claude conversation holds one until the ACP
// worker disposes it after it has been idle
// (COCALC_ACP_HARNESS_IDLE_DISPOSE_MS), so the defaults follow what the host
// and the project can actually run.
export async function maxTranscriptStagings(
  projectId: string,
  projectPool = projectPoolCgroupPath(),
): Promise<{ host: number; project: number }> {
  const poolMemoryBytes = await cgroupMemoryLimit(projectPool);
  const defaults = defaultTranscriptStagings({
    cpus: availableParallelism(),
    memoryBytes: Math.min(totalmem(), poolMemoryBytes ?? Infinity),
    projectMemoryBytes: await cgroupMemoryLimit(
      join(projectPool, `project-${projectId}`),
    ),
  });
  return {
    host: positiveSetting(
      "COCALC_CLAUDE_TRANSCRIPT_MAX_STAGINGS",
      defaults.host,
    ),
    project: positiveSetting(
      "COCALC_CLAUDE_TRANSCRIPT_MAX_PROJECT_STAGINGS",
      defaults.project,
    ),
  };
}

// Refuses (after removing it) the staging directory just created if the host
// or its project now has more than allowed. Counting after creating it means
// controllers starting at once can refuse each other, but never all succeed
// past the bound.
async function enforceStagingLimits(
  projectId: string,
  limits: { host: number; project: number },
): Promise<void> {
  let host = 0;
  let project = 0;
  for (const name of await readdir(tmpdir())) {
    const owner = claudeTranscriptStagingProject(name);
    if (owner === undefined) continue;
    host++;
    if (owner === projectId) project++;
  }
  if (project > limits.project)
    throw Error(
      `Too many Claude controllers are running in this project (at most ${limits.project}); try again later`,
    );
  if (host > limits.host)
    throw Error(
      `Too many Claude controllers are running on this project host (at most ${limits.host}); try again later`,
    );
}

export interface ClaudeTranscriptStaging {
  /** Host-owned directory for the controller to mount. */
  directory: string;
  /** Copy what changed since the last copy back into the project's home. */
  sync(): Promise<void>;
  /**
   * Copy back one last time, then remove the directory. If that copy fails
   * for a reason that may pass (no space, an I/O error), the staged copy is
   * kept and the error thrown, so a retry of close can still save it.
   */
  close(): Promise<void>;
}

function joinRel(base: string, rel: string): string {
  return base && rel ? `${base}/${rel}` : base || rel;
}

function errorCode(error: unknown): string | undefined {
  return (
    `${(error as Error)?.message ?? ""}`.match(/^(E[A-Z]+)\b/)?.[1] ??
    (error as NodeJS.ErrnoException)?.code
  );
}

// Errors after which keeping the staged copy cannot help: the tree is over
// its bound, or the project's own path is unusable (a symlink or a
// non-directory where its transcript directory should be).
const UNRECOVERABLE = new Set(["EFBIG", "ELOOP", "ENOTDIR", "EXDEV"]);

const identityKey = ({ size, ctimeNs }: FileIdentity) => `${ctimeNs}:${size}`;

// Copies the regular files of the tree at `fromBase` under `fromRoot` to the
// same relative paths at `toBase` under `toRoot`, never following or copying a
// symlink. `staged` records, for each file, the identity (change time and
// size, which a writer cannot set back) of its staged copy when it last
// crossed; `stagedSide` says which side is the staging directory. A staged
// file whose identity is unchanged is not copied out again. Throws EFBIG once
// the tree holds more than `maxBytes`.
async function copyTree({
  fromRoot,
  fromBase,
  toRoot,
  toBase,
  staged,
  stagedSide,
  maxBytes,
}: {
  fromRoot: string;
  fromBase: string;
  toRoot: string;
  toBase: string;
  staged: Map<string, string>;
  stagedSide: "from" | "to";
  maxBytes: number;
}): Promise<void> {
  let entries = 0;
  let bytes = 0;
  const visit = async (rel: string): Promise<void> => {
    for (const name of await listBeneath(fromRoot, joinRel(fromBase, rel))) {
      if (++entries > MAX_TRANSCRIPT_ENTRIES)
        throw Error("Claude transcript tree has too many entries");
      const child = joinRel(rel, name);
      const from = joinRel(fromBase, child);
      const kind = await kindBeneath(fromRoot, from);
      if (kind === "dir") {
        await visit(child);
        continue;
      }
      if (kind !== "file") continue;
      const result = await copyRegularFileBeneath({
        src: { root: fromRoot, path: from },
        dest: { root: toRoot, path: joinRel(toBase, child) },
        maxBytes: maxBytes - bytes,
        skip: (source) =>
          stagedSide === "from" && staged.get(child) === identityKey(source),
      });
      if (result.kind === "not-regular") continue;
      // What the staging side really holds: a file can grow while copied.
      bytes +=
        result.kind === "copied"
          ? Math.max(result.source.size, result.dest.size)
          : result.source.size;
      if (bytes > maxBytes) {
        const error: NodeJS.ErrnoException = Error(
          `EFBIG: Claude transcripts exceed ${maxBytes} bytes`,
        );
        error.code = "EFBIG";
        throw error;
      }
      if (result.kind === "copied")
        staged.set(
          child,
          identityKey(stagedSide === "from" ? result.source : result.dest),
        );
    }
  };
  await visit("");
}

/**
 * Stage the transcript directory at `parts` beneath `projectHome` (located by
 * ensureClaudeTranscriptDirectory) in a new host-owned directory.
 */
export async function stageClaudeTranscripts({
  projectId,
  projectHome,
  parts,
  maxBytes = maxTranscriptBytes(),
  limits,
}: {
  projectId: string;
  projectHome: string;
  parts: string[];
  maxBytes?: number;
  limits?: { host: number; project: number };
}): Promise<ClaudeTranscriptStaging> {
  const directory = await mkdtemp(claudeTranscriptStagingPrefix(projectId));
  const base = parts.join("/");
  // So that a file the controller did not change is not copied back.
  const staged = new Map<string, string>();
  try {
    await enforceStagingLimits(
      projectId,
      limits ?? (await maxTranscriptStagings(projectId)),
    );
    await copyTree({
      fromRoot: projectHome,
      fromBase: base,
      toRoot: directory,
      toBase: "",
      staged,
      stagedSide: "to",
      maxBytes,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  const copyBack = (): Promise<void> => {
    const run = queue.then(async () => {
      // The reaper ages staging no container refers to by this directory's
      // own time, which the controller's nested writes do not change. Every
      // copy back (each completed turn, cleanup before the container stops,
      // and close) renews it, so a copy kept after a failed copy back is
      // kept for the full retention, counted from that failure.
      const now = new Date();
      await utimes(directory, now, now);
      await copyTree({
        fromRoot: directory,
        fromBase: "",
        toRoot: projectHome,
        toBase: base,
        staged,
        stagedSide: "from",
        maxBytes,
      });
    });
    queue = run.catch(() => {});
    return run;
  };
  return {
    directory,
    sync: async () => {
      if (!closed) await copyBack();
    },
    close: async () => {
      if (closed) return;
      try {
        await copyBack();
      } catch (error) {
        if (!UNRECOVERABLE.has(errorCode(error) ?? "")) {
          logger.warn("Claude transcripts were not copied back; kept", {
            directory,
            error: `${error}`,
          });
          throw error;
        }
        logger.warn("Claude transcripts were not copied back", {
          error: `${error}`,
        });
      }
      await rm(directory, { recursive: true, force: true });
      // Only now: if removing failed, a retry of close tries again.
      closed = true;
    },
  };
}

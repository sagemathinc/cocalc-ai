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
(beneath-copy): in when the controller starts, and back out after every turn
and when it stops. Only regular files and directories cross, in either
direction: a symlink is never copied, so neither side can plant one for the
other to follow.
*/

import { mkdtemp, rm } from "node:fs/promises";
import getLogger from "@cocalc/backend/logger";
import { copyBeneath, listBeneath, statBeneath } from "../beneath-copy";
import { claudeTranscriptStagingPrefix } from "./claude-subscription-paths";

const logger = getLogger("project-host:claude-transcript-staging");

// One walk visits at most this many entries, so a project cannot make the
// host walk (or copy) without end.
export const MAX_TRANSCRIPT_ENTRIES = 100_000;

export interface ClaudeTranscriptStaging {
  /** Host-owned directory for the controller to mount. */
  directory: string;
  /** Copy what changed since the last copy back into the project's home. */
  sync(): Promise<void>;
  /** Copy back one last time (best effort), then remove the directory. */
  close(): Promise<void>;
}

function joinRel(base: string, rel: string): string {
  return base && rel ? `${base}/${rel}` : base || rel;
}

// Copies the regular files of the tree at `fromBase` under `fromRoot` to the
// same relative paths at `toBase` under `toRoot`. `copied` records, for each
// file, the modification time of its staged copy when it last crossed
// (`staged` says which side is the staging directory); a staged file whose
// time is unchanged is not copied out again. Symlinks and other special files
// are skipped, never followed.
async function copyTree({
  fromRoot,
  fromBase,
  toRoot,
  toBase,
  copied,
  staged,
}: {
  fromRoot: string;
  fromBase: string;
  toRoot: string;
  toBase: string;
  copied: Map<string, number>;
  staged: "from" | "to";
}): Promise<void> {
  let entries = 0;
  const visit = async (rel: string): Promise<void> => {
    for (const name of await listBeneath(fromRoot, joinRel(fromBase, rel))) {
      if (++entries > MAX_TRANSCRIPT_ENTRIES)
        throw Error("Claude transcript tree has too many entries");
      const child = joinRel(rel, name);
      const from = joinRel(fromBase, child);
      const { kind, mtimeNs } = await statBeneath(fromRoot, from);
      if (kind === "dir") {
        await visit(child);
        continue;
      }
      if (kind !== "file") continue;
      if (staged === "from" && copied.get(child) === mtimeNs) continue;
      const to = joinRel(toBase, child);
      await copyBeneath({
        src: { root: fromRoot, path: from },
        dest: { root: toRoot, path: to },
        options: { force: true, preserveTimestamps: true },
      });
      // Preserved times are not exact to the nanosecond: record the time the
      // staged copy really has.
      copied.set(
        child,
        staged === "from" ? mtimeNs : (await statBeneath(toRoot, to)).mtimeNs,
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
  projectHome,
  parts,
}: {
  projectHome: string;
  parts: string[];
}): Promise<ClaudeTranscriptStaging> {
  const directory = await mkdtemp(claudeTranscriptStagingPrefix());
  const base = parts.join("/");
  // So that a file the controller did not change is not copied back.
  const copied = new Map<string, number>();
  try {
    await copyTree({
      fromRoot: projectHome,
      fromBase: base,
      toRoot: directory,
      toBase: "",
      copied,
      staged: "to",
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  const copyBack = (): Promise<void> => {
    const run = queue.then(() =>
      copyTree({
        fromRoot: directory,
        fromBase: "",
        toRoot: projectHome,
        toBase: base,
        copied,
        staged: "from",
      }),
    );
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
      closed = true;
      try {
        await copyBack();
      } catch (error) {
        // The project's copy is unreachable (it removed the directory, or a
        // symlink is in the way); keeping the staged copy would only leak it.
        logger.warn("Claude transcripts were not copied back to the project", {
          error: `${error}`,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

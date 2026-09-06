/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  DiffFile,
  WorktreeContext,
} from "../components/diff-viewer/review-model";
import { diffFileKey } from "../components/diff-viewer/review-model";

export function parseWorktrees(output: string): WorktreeContext[] {
  if (!output.endsWith("\0\0")) throw Error("Incomplete worktree metadata");
  return output
    .slice(0, -2)
    .split("\0\0")
    .map((record) => {
      const fields = record.split("\0");
      if (!fields[0].startsWith("worktree "))
        throw Error("Invalid worktree metadata");
      const worktree: WorktreeContext = {
        path: fields[0].slice(9),
        detached: false,
        bare: false,
      };
      for (const field of fields.slice(1)) {
        if (field.startsWith("HEAD ")) worktree.head = field.slice(5);
        else if (field.startsWith("branch ")) worktree.branch = field.slice(7);
        else if (field === "detached") worktree.detached = true;
        else if (field === "bare") worktree.bare = true;
        else if (field === "locked" || field.startsWith("locked "))
          worktree.locked = field.slice(7);
        else if (field === "prunable" || field.startsWith("prunable "))
          worktree.prunable = field.slice(9);
      }
      return worktree;
    });
}

export interface GitRef {
  name: string;
  object: string;
  symbolic?: string;
}

export function parseRefs(output: string): GitRef[] {
  if (!output) return [];
  if (!output.endsWith("\0\n")) throw Error("Incomplete ref metadata");
  return output
    .slice(0, -1)
    .split("\n")
    .map((record) => {
      const [name, object, symbolic, end] = record.split("\0");
      if (end !== "" || !name.startsWith("refs/") || !isFullObjectId(object))
        throw Error("Invalid ref metadata");
      return { name, object, symbolic: symbolic || undefined };
    });
}

export function isFullObjectId(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

export interface GitHistoryEntry {
  commit: string;
  parents: string[];
  timestamp: number;
  subject: string;
}

export function parseHistory(output: string): GitHistoryEntry[] {
  if (!output) return [];
  const fields = output.split("\0");
  if (fields.pop() !== "" || fields.length % 4 !== 0)
    throw Error("Incomplete history metadata");
  const entries: GitHistoryEntry[] = [];
  for (let i = 0; i < fields.length; i += 4) {
    const [commit, rawParents, timestamp, subject] = fields.slice(i, i + 4);
    const parents = rawParents ? rawParents.split(" ") : [];
    if (
      !isFullObjectId(commit) ||
      parents.some((p) => !isFullObjectId(p)) ||
      !/^\d+$/.test(timestamp)
    )
      throw Error("Invalid history metadata");
    entries.push({
      commit,
      parents,
      timestamp: Number(timestamp) * 1000,
      subject,
    });
  }
  return entries;
}

export function parseRawDiff(output: string): DiffFile[] {
  if (!output) return [];
  const fields = output.split("\0");
  if (fields.pop() !== "") throw Error("Incomplete changed-file metadata");
  const files: DiffFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const header =
      /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ACDMRTUX][0-9]*)$/.exec(
        fields[i++],
      );
    if (!header) throw Error("Invalid changed-file metadata");
    const [, oldMode, newMode, oldObject, newObject, status] = header;
    if (!isFullObjectId(oldObject) || !isFullObjectId(newObject))
      throw Error("Abbreviated changed-file object");
    const firstPath = fields[i++];
    if (!firstPath) throw Error("Missing changed-file path");
    const oldPath = status[0] === "A" ? undefined : firstPath;
    const newPath =
      status[0] === "D"
        ? undefined
        : /[RC]/.test(status[0])
          ? fields[i++]
          : firstPath;
    if (status[0] !== "D" && !newPath) throw Error("Missing renamed path");
    const change = {
      A: "add",
      D: "delete",
      M: "modify",
      R: "rename",
      C: "copy",
      T: "type",
      U: "unmerged",
      X: "unmerged",
    }[status[0]] as DiffFile["change"];
    files.push({
      id: diffFileKey(oldPath, newPath),
      oldPath,
      newPath,
      oldMode,
      newMode,
      oldObject,
      newObject,
      change,
      content: [oldMode, newMode].includes("160000")
        ? "submodule"
        : [oldMode, newMode].includes("120000")
          ? "symlink"
          : oldObject === newObject
            ? "metadata"
            : "unknown",
      completeness: "patch",
      hunks: [],
    });
  }
  return files;
}

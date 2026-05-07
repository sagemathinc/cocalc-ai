/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: commit selection, filtering, and search-state helpers for the git review drawer.

import type { GitLogEntry } from "./types";

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const HEAD_REF = "HEAD";

export function parseCommitHash(commitHash?: string): string | undefined {
  const trimmed = `${commitHash ?? ""}`.trim();
  if (!trimmed) return undefined;
  if (trimmed.toUpperCase() === HEAD_REF) return HEAD_REF;
  if (!COMMIT_HASH_RE.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

export function isHeadCommit(commit?: string): boolean {
  return `${commit ?? ""}`.toUpperCase() === HEAD_REF;
}

export function filterGitReviewLogEntries({
  entries,
  reviewedByCommit,
  onlyUnreviewed,
  selectedCommit,
}: {
  entries: GitLogEntry[];
  reviewedByCommit: Record<string, boolean>;
  onlyUnreviewed: boolean;
  selectedCommit?: string;
}): GitLogEntry[] {
  if (!onlyUnreviewed) return entries;
  const normalizedSelectedCommit = `${selectedCommit ?? ""}`
    .trim()
    .toLowerCase();
  return entries.filter((entry) => {
    if (
      normalizedSelectedCommit &&
      (entry.hash === normalizedSelectedCommit ||
        entry.hash.startsWith(normalizedSelectedCommit))
    ) {
      return true;
    }
    return reviewedByCommit[entry.hash] !== true;
  });
}

export function resolveGitCommitSearchChange({
  currentSearch,
  nextSearch,
  preserveSearchOnAutoClear,
}: {
  currentSearch: string;
  nextSearch: string;
  preserveSearchOnAutoClear: boolean;
}): {
  search: string;
  preserveSearchOnAutoClear: boolean;
} {
  if (preserveSearchOnAutoClear && nextSearch === "") {
    return {
      search: currentSearch,
      preserveSearchOnAutoClear: false,
    };
  }
  return {
    search: nextSearch,
    preserveSearchOnAutoClear: false,
  };
}

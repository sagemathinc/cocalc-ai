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
  filterText,
  selectedCommit,
}: {
  entries: GitLogEntry[];
  reviewedByCommit: Record<string, boolean>;
  onlyUnreviewed: boolean;
  filterText?: string;
  selectedCommit?: string;
}): GitLogEntry[] {
  const normalizedSelectedCommit = `${selectedCommit ?? ""}`
    .trim()
    .toLowerCase();
  const normalizedFilter = `${filterText ?? ""}`.trim().toLowerCase();
  return entries.filter((entry) => {
    if (
      normalizedSelectedCommit &&
      (entry.hash === normalizedSelectedCommit ||
        entry.hash.startsWith(normalizedSelectedCommit))
    ) {
      return true;
    }
    if (onlyUnreviewed && reviewedByCommit[entry.hash] === true) {
      return false;
    }
    if (!normalizedFilter) return true;
    return `${entry.hash} ${entry.subject}`
      .toLowerCase()
      .includes(normalizedFilter);
  });
}

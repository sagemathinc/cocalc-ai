/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: stable hashing and derived ids used by git commit drawer sections, line targets, and persisted UI state.

export function hashGitCommitValue(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function buildGitReviewFileSectionId(
  path: string,
  index: number,
): string {
  return `git-review-file-${index}-${hashGitCommitValue(path).slice(0, 12)}`;
}

export function buildGitReviewLineElementId({
  filePath,
  fileIndex,
  lineIndex,
}: {
  filePath: string;
  fileIndex: number;
  lineIndex: number;
}): string {
  return `git-review-line-${fileIndex}-${lineIndex}-${hashGitCommitValue(filePath).slice(0, 12)}`;
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Resolve how the TimeTravel editor should open the shared git browser drawer.

export const TIME_TRAVEL_GIT_REVIEW_SUBMISSION_HELP =
  "To submit review comments to Codex, open the git reviewer from an AI chat.";

export function resolveTimeTravelGitBrowserCommitHash({
  gitMode,
  changesMode,
  version,
  version0,
  version1,
  gitCommit,
}: {
  gitMode: boolean;
  changesMode: boolean;
  version?: number | string;
  version0?: number | string;
  version1?: number | string;
  gitCommit: (
    version: number | string | undefined,
  ) => { hash: string } | undefined;
}): string {
  if (!gitMode) {
    return "HEAD";
  }
  const selectedVersion = changesMode
    ? (version1 ?? version ?? version0)
    : (version ?? version1 ?? version0);
  return gitCommit(selectedVersion)?.hash ?? "HEAD";
}

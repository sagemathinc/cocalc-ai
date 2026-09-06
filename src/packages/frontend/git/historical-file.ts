/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { GitSource } from "@cocalc/frontend/components/diff-viewer/review-model";
import { GitReadError } from "./read-service";
import type { GitReadService } from "./read-service";

export type GitHistoricalFileRequest =
  | { source: GitSource }
  | {
      projectId: string;
      cwd: string;
      commit: string;
      path: string;
      parentIndex?: number;
    };

type Reader = Pick<
  GitReadService,
  "discover" | "pinCommit" | "changedFiles" | "readFile"
>;

export interface GitHistoricalFile {
  contents: string;
  blob: string;
  mode: string;
  source: GitSource;
  deletedIn?: string;
}

export async function loadGitHistoricalFile(
  reader: Reader,
  request: GitHistoricalFileRequest,
): Promise<GitHistoricalFile> {
  let source: GitSource;
  let deletedIn: string | undefined;
  if ("source" in request) {
    source = request.source;
  } else {
    const { repository } = await reader.discover(
      request.projectId,
      request.cwd,
    );
    const target = await reader.pinCommit(
      repository,
      request.commit,
      request.parentIndex,
    );
    const files = await reader.changedFiles(target);
    const matches = files.filter(
      (file) => file.newPath === request.path || file.oldPath === request.path,
    );
    if (matches.length > 1) {
      throw new GitReadError(
        "ambiguous",
        "More than one changed file matches this path; choose an exact diff side.",
      );
    }
    const file = matches[0];
    if (file?.change === "delete") deletedIn = target.commit;
    const selected = file?.newSource ?? file?.oldSource;
    if (selected && selected.kind !== "git")
      throw new GitReadError("unsupported", "Expected a Git source");
    // Deleted files have only an old source. Unchanged files still exist in the
    // requested tree even though that commit is absent from their file log.
    source = selected ?? {
      kind: "git",
      repository,
      commit: target.commit,
      path: request.path,
    };
  }
  const result = await reader.readFile(
    source.repository,
    source.commit,
    source.path,
  );
  if (source.blob && source.blob !== result.blob) {
    throw new GitReadError(
      "incomplete",
      "Historical file does not match the expected blob",
    );
  }
  return { ...result, source: { ...source, blob: result.blob }, deletedIn };
}

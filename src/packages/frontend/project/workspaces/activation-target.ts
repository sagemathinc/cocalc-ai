/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WorkspaceRecord } from "./types";

export type WorkspaceActivationTarget =
  | {
      kind: "file";
      path: string;
    }
  | {
      kind: "directory";
      path: string;
    };

type GetWorkspaceActivationTargetOpts = {
  record: WorkspaceRecord;
  activePath: string;
  openFilesOrder: readonly string[];
  resolveWorkspaceForPath: (path: string) => WorkspaceRecord | null;
};

export function getWorkspaceActivationTarget({
  record,
  activePath,
  openFilesOrder,
  resolveWorkspaceForPath,
}: GetWorkspaceActivationTargetOpts): WorkspaceActivationTarget {
  const openPathSet = new Set(openFilesOrder);
  const seen = new Set<string>();
  const candidates = [
    activePath,
    record.last_active_path ?? "",
    ...openFilesOrder,
  ];

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!openPathSet.has(candidate)) continue;
    if (
      resolveWorkspaceForPath(candidate)?.workspace_id !== record.workspace_id
    ) {
      continue;
    }
    return { kind: "file", path: candidate };
  }

  return { kind: "directory", path: record.root_path };
}

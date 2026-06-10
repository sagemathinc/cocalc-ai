/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  resolveWorkspaceForPath,
  type WorkspaceRecord,
} from "@cocalc/conat/workspaces";
import { path_split } from "@cocalc/util/misc";

const HIDDEN_COCALC_CHAT_PATH_MARKERS = [
  ".local/share/cocalc/",
  "Library/Application Support/cocalc/",
];

function cleanPath(path: string | undefined): string {
  return `${path ?? ""}`.trim();
}

function cleanDirectory(path: string | undefined): string | undefined {
  const normalized = cleanPath(path);
  return normalized || undefined;
}

function containingDirectory(path: string): string {
  const normalized = cleanPath(path);
  if (!normalized) return ".";
  return path_split(normalized).head || ".";
}

export function isGeneratedCocalcChatPath(path: string): boolean {
  const normalized = cleanPath(path);
  if (!normalized.toLowerCase().endsWith(".chat")) return false;
  return HIDDEN_COCALC_CHAT_PATH_MARKERS.some(
    (marker) =>
      normalized.startsWith(marker) || normalized.includes(`/${marker}`),
  );
}

export function defaultWorkingDirectoryForChat(
  chatPath: string,
  workspaceRootPath?: string,
  projectHomeDirectory?: string,
): string {
  const workspaceRoot = cleanDirectory(workspaceRootPath);
  if (workspaceRoot) return workspaceRoot;
  if (isGeneratedCocalcChatPath(chatPath)) {
    const home = cleanDirectory(projectHomeDirectory);
    if (home) return home;
  }
  return containingDirectory(chatPath);
}

export function workingDirectoryForProjectFile(
  path: string,
  opts: {
    projectHomeDirectory?: string;
    workspaceRecords?: WorkspaceRecord[];
  } = {},
): string {
  const workspace = resolveWorkspaceForPath(opts.workspaceRecords ?? [], path);
  return defaultWorkingDirectoryForChat(
    path,
    workspace?.root_path,
    opts.projectHomeDirectory,
  );
}

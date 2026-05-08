/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map as ImmutableMap } from "immutable";

import { tab_to_path } from "@cocalc/util/misc";

type OpenFilesMap = ImmutableMap<string, any>;

type ResetOpenFileRuntimeAfterHostResetOpts = {
  openFiles?: OpenFilesMap;
  activeProjectTab?: string;
  getSyncPath: (path: string) => string;
  getComponent: (path: string) => any;
  setComponent: (path: string, component: any) => void;
  removeRuntime: (syncPath: string) => Promise<void> | void;
  rebootstrapPath?: (
    path: string,
    opts?: { noFocus?: boolean },
  ) => Promise<void> | void;
};

export async function resetOpenFileRuntimeAfterHostReset({
  openFiles,
  activeProjectTab,
  getSyncPath,
  getComponent,
  setComponent,
  removeRuntime,
  rebootstrapPath,
}: ResetOpenFileRuntimeAfterHostResetOpts): Promise<void> {
  if (openFiles == null || openFiles.size === 0) {
    return;
  }
  const syncPaths: string[] = [];
  const seenSyncPaths = new Set<string>();
  openFiles.forEach((_value, path) => {
    const current = getComponent(path) ?? {};
    setComponent(path, {
      ...current,
      redux_name: undefined,
      Editor: undefined,
    });
    const syncPath = getSyncPath(path);
    if (!seenSyncPaths.has(syncPath)) {
      seenSyncPaths.add(syncPath);
      syncPaths.push(syncPath);
    }
  });
  for (const syncPath of syncPaths) {
    await removeRuntime(syncPath);
  }
  const activePath =
    typeof activeProjectTab === "string" &&
    activeProjectTab.startsWith("editor-")
      ? tab_to_path(activeProjectTab)
      : undefined;
  const pathsToRebootstrap =
    activePath != null && openFiles.has(activePath)
      ? [
          activePath,
          ...openFiles.keySeq().filter((path) => path !== activePath),
        ]
      : openFiles.keySeq().toArray();
  for (const path of pathsToRebootstrap) {
    await rebootstrapPath?.(path, {
      noFocus: path !== activePath,
    });
  }
}

export function selectOpenFilesForSyncPath({
  openFiles,
  targetSyncPath,
  getSyncPath,
}: {
  openFiles?: OpenFilesMap;
  targetSyncPath: string;
  getSyncPath: (path: string) => string;
}): OpenFilesMap {
  if (openFiles == null || openFiles.size === 0) {
    return ImmutableMap<string, any>();
  }
  let matches = ImmutableMap<string, any>();
  openFiles.forEach((value, path) => {
    if (getSyncPath(path) !== targetSyncPath) {
      return;
    }
    matches = matches.set(path, value);
  });
  return matches;
}

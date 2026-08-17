/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { parseProjectTarget } from "@cocalc/frontend/project-routing";
import {
  fromUrlDirectoryPath,
  toUrlPath,
} from "@cocalc/frontend/project/redux/path-routing";
import { isBackupsPath } from "@cocalc/util/consts/backups";
import { isSnapshotsPath } from "@cocalc/util/consts/snapshots";

export interface ReducedProjectState {
  homeDirectory: string;
  hostId?: string;
  localTarget: string;
  path: string;
  projectId: string;
  title: string;
  viewer: boolean;
}

const states = new Map<string, ReducedProjectState>();
const listeners = new Map<string, Set<() => void>>();

export function getReducedProjectDirectoryPath({
  homeDirectory,
  target,
}: {
  homeDirectory: string;
  target?: string;
}): string | undefined {
  const route = parseProjectTarget(target || "files/", {
    decodeDirectoryPath: (path) =>
      fromUrlDirectoryPath({ path, homeDirectory }),
  });
  if (
    route?.kind !== "directory" ||
    isBackupsPath(route.path) ||
    isSnapshotsPath(route.path)
  ) {
    return;
  }
  return route.path;
}

function emit(projectId: string): void {
  for (const listener of listeners.get(projectId) ?? []) listener();
}

export function getReducedProjectState(
  projectId: string,
): ReducedProjectState | undefined {
  return states.get(projectId);
}

export function hasReducedProjectState(projectId: string): boolean {
  return states.has(projectId);
}

export function setReducedProjectState(
  state: Omit<ReducedProjectState, "localTarget">,
): void {
  states.set(state.projectId, {
    ...state,
    localTarget: toUrlPath({
      homeDirectory: state.homeDirectory,
      isDirectory: true,
      path: state.path,
    }),
  });
  emit(state.projectId);
}

export function setReducedProjectPath(projectId: string, path: string): void {
  const current = states.get(projectId);
  if (current == null || current.path === path) return;
  states.set(projectId, {
    ...current,
    localTarget: toUrlPath({
      homeDirectory: current.homeDirectory,
      isDirectory: true,
      path,
    }),
    path,
  });
  emit(projectId);
}

export function clearReducedProjectState(projectId: string): void {
  if (!states.delete(projectId)) return;
  emit(projectId);
}

export function subscribeReducedProjectState(
  projectId: string,
  listener: () => void,
): () => void {
  let projectListeners = listeners.get(projectId);
  if (projectListeners == null) {
    projectListeners = new Set();
    listeners.set(projectId, projectListeners);
  }
  projectListeners.add(listener);
  return () => {
    projectListeners?.delete(listener);
    if (projectListeners?.size === 0) listeners.delete(projectId);
  };
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isBackupsPath } from "@cocalc/util/consts/backups";
import { isSnapshotsPath } from "@cocalc/util/consts/snapshots";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  projectRuntimeHomeRelativePath,
} from "@cocalc/util/project-runtime";
import {
  buildProjectFilesTarget,
  buildProjectScopedTarget,
} from "@cocalc/frontend/project-routing";
import { normalize } from "@cocalc/frontend/project/utils";

export type AuxTabName = "new" | "search";

export function getSnapshotHomeDirectoryForPaths(
  homeDirectory: string,
): string {
  return homeDirectory === "/" ? DEFAULT_PROJECT_RUNTIME_HOME : homeDirectory;
}

export function getSnapshotsRouteRelativePath(
  path: string,
): string | undefined {
  const normalized = normalize(path);
  if (isSnapshotsPath(normalized) && !normalized.startsWith("/")) {
    return normalized.replace(/^\/+/, "").replace(/\/+$/, "");
  }
  const relative = projectRuntimeHomeRelativePath(normalized);
  if (relative != null && isSnapshotsPath(relative)) {
    return relative.replace(/^\/+/, "").replace(/\/+$/, "");
  }
}

export function isVirtualListingPath(path: string): boolean {
  return isBackupsPath(path);
}

export function toAbsoluteCurrentPath({
  path,
  homeDirectory,
}: {
  path: string;
  homeDirectory: string;
}): string {
  const normalized = normalize(path);
  if (isVirtualListingPath(normalized)) {
    return normalized;
  }
  const snapshotRelative = getSnapshotsRouteRelativePath(normalized);
  if (snapshotRelative != null) {
    return normalizeAbsolutePath(
      snapshotRelative,
      getSnapshotHomeDirectoryForPaths(homeDirectory),
    );
  }
  return normalizeAbsolutePath(normalized, homeDirectory);
}

export function getPathRoute({
  path,
  homeDirectory,
}: {
  path: string;
  homeDirectory: string;
}): { relativePath: string } {
  const normalized = normalize(path);
  if (isVirtualListingPath(normalized)) {
    return {
      relativePath: normalized.replace(/^\/+/, "").replace(/\/+$/, ""),
    };
  }
  const snapshotRelative = getSnapshotsRouteRelativePath(normalized);
  if (snapshotRelative != null) {
    return { relativePath: snapshotRelative };
  }
  const normalizedHomeDirectory = normalizeAbsolutePath(homeDirectory);
  if (
    normalized === "/" ||
    normalizeAbsolutePath(normalized, normalizedHomeDirectory) ===
      normalizedHomeDirectory
  ) {
    return { relativePath: "" };
  }
  const absolute = normalizeAbsolutePath(normalized, normalizedHomeDirectory);
  return {
    relativePath: absolute === "/" ? "" : absolute.slice(1),
  };
}

export function toUrlPath({
  path,
  isDirectory,
  homeDirectory,
}: {
  path: string;
  isDirectory: boolean;
  homeDirectory: string;
}): string {
  return buildProjectFilesTarget(path, isDirectory, {
    encodeRelativePath: (nextPath) =>
      getPathRoute({ path: nextPath, homeDirectory }).relativePath,
  });
}

export function fromUrlDirectoryPath({
  path,
  homeDirectory,
}: {
  path: string;
  homeDirectory: string;
}): string {
  let normalized = normalize(path);
  const trimmed = normalized.replace(/^\/+/, "");
  if (trimmed === "files") {
    normalized = "";
  } else if (trimmed.startsWith("files/")) {
    normalized = trimmed.slice("files/".length);
  }
  if (normalized === "" || normalized === "." || normalized === "/") {
    return homeDirectory;
  }
  if (isVirtualListingPath(normalized)) {
    return normalized;
  }
  if (isSnapshotsPath(normalized)) {
    return normalizeAbsolutePath(
      normalized.replace(/^\/+/, ""),
      getSnapshotHomeDirectoryForPaths(homeDirectory),
    );
  }
  return normalizeAbsolutePath(`/${normalized}`, homeDirectory);
}

export function toAuxTabPath({
  tab,
  path,
  homeDirectory,
}: {
  tab: AuxTabName;
  path: string;
  homeDirectory: string;
}): string {
  return buildProjectScopedTarget(tab, path, {
    encodeRelativePath: (nextPath) =>
      getPathRoute({ path: nextPath, homeDirectory }).relativePath,
  });
}

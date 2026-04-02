/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import path from "node:path";

export const DEFAULT_PROJECT_RUNTIME_USER = "user";
export const DEFAULT_PROJECT_RUNTIME_UID = 1000;
export const DEFAULT_PROJECT_RUNTIME_GID = 1000;
export const DEFAULT_PROJECT_RUNTIME_HOME = "/home/user";
export const LEGACY_PROJECT_RUNTIME_HOME = "/root";
export const PROJECT_RUNTIME_HOME_ALIASES = [
  DEFAULT_PROJECT_RUNTIME_HOME,
  LEGACY_PROJECT_RUNTIME_HOME,
] as const;

export function projectRuntimeHomeRelativePath(
  rawPath: string,
): string | undefined {
  const normalized = path.posix.normalize(
    `${rawPath ?? ""}`.replace(/\\/g, "/"),
  );
  if (!normalized || normalized === "." || normalized === "/") {
    return undefined;
  }
  for (const home of PROJECT_RUNTIME_HOME_ALIASES) {
    if (normalized === home) {
      return "";
    }
    if (normalized.startsWith(`${home}/`)) {
      return path.posix.relative(home, normalized);
    }
  }
  return undefined;
}

export function isProjectRuntimeHomeAliasPath(rawPath: string): boolean {
  return projectRuntimeHomeRelativePath(rawPath) != null;
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const DEFAULT_PROJECT_RUNTIME_USER = "user";
export const DEFAULT_PROJECT_RUNTIME_UID = 1000;
export const DEFAULT_PROJECT_RUNTIME_GID = 1000;
export const DEFAULT_PROJECT_RUNTIME_HOME = "/home/user";
export const LEGACY_PROJECT_RUNTIME_HOME = "/root";
export const PROJECT_RUNTIME_HOME_ALIASES = [
  DEFAULT_PROJECT_RUNTIME_HOME,
  LEGACY_PROJECT_RUNTIME_HOME,
] as const;

function normalizePosixPath(rawPath: string): string {
  const value = `${rawPath ?? ""}`.replace(/\\/g, "/");
  if (!value) return "";
  const absolute = value.startsWith("/");
  const normalized: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== "..") {
        normalized.pop();
      } else if (!absolute) {
        normalized.push(part);
      }
      continue;
    }
    normalized.push(part);
  }
  const joined = normalized.join("/");
  if (absolute) {
    return joined ? `/${joined}` : "/";
  }
  return joined || ".";
}

export function projectRuntimeHomeRelativePath(
  rawPath: string,
): string | undefined {
  const normalized = normalizePosixPath(rawPath);
  if (!normalized || normalized === "." || normalized === "/") {
    return undefined;
  }
  for (const home of PROJECT_RUNTIME_HOME_ALIASES) {
    if (normalized === home) {
      return "";
    }
    if (normalized.startsWith(`${home}/`)) {
      return normalized.slice(`${home}/`.length);
    }
  }
  return undefined;
}

export function isProjectRuntimeHomeAliasPath(rawPath: string): boolean {
  return projectRuntimeHomeRelativePath(rawPath) != null;
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { posix as pathPosix } from "path";

function stripTrailingSlash(path: string): string {
  if (path === "/") {
    return path;
  }
  return path.replace(/\/+$/, "");
}

function ensureAbsolute(path: string): string {
  return path.startsWith("/") ? path : pathPosix.join("/", path);
}

export function isAbsolutePath(path: string): boolean {
  return typeof path === "string" && path.startsWith("/");
}

export function normalizeAbsolutePath(input: string, base: string = "/"): string {
  const normalizedBase = stripTrailingSlash(
    ensureAbsolute(pathPosix.normalize(base || "/")),
  );

  if (!input) {
    return normalizedBase;
  }

  const combined = isAbsolutePath(input)
    ? input
    : pathPosix.join(normalizedBase, input);
  const normalized = ensureAbsolute(pathPosix.normalize(combined));
  return stripTrailingSlash(normalized);
}

export function joinAbsolutePath(base: string, name: string): string {
  return normalizeAbsolutePath(name, normalizeAbsolutePath(base));
}

export function displayPath(path: string, homeDirectory?: string): string {
  const absolutePath = normalizeAbsolutePath(path);
  if (!homeDirectory) {
    return absolutePath;
  }
  const home = normalizeAbsolutePath(homeDirectory);
  if (absolutePath === home) {
    return "~";
  }
  if (home !== "/" && absolutePath.startsWith(`${home}/`)) {
    return `~${absolutePath.slice(home.length)}`;
  }
  return absolutePath;
}

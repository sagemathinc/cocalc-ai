/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { filename_extension, path_split } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { termPath } from "@cocalc/util/terminal/names";
import { normalize } from "./utils";

export function toAbsoluteProjectPath(path: string, homeDirectory: string): string {
  const normalizedHome = normalizeAbsolutePath(homeDirectory || "/");
  const normalized = normalize(path);
  if (!normalized || normalized === "." || normalized === "~") {
    return normalizedHome;
  }
  if (normalized.startsWith("~/")) {
    return normalizeAbsolutePath(normalized.slice(2), normalizedHome);
  }
  if (normalized.startsWith("/")) {
    return normalizeAbsolutePath(normalized);
  }
  return normalizeAbsolutePath(normalized, normalizedHome);
}

export function canonicalSyncPath(path: string, homeDirectory: string): string {
  const absolutePath = toAbsoluteProjectPath(path, homeDirectory);
  const ext = filename_extension(absolutePath).toLowerCase();
  if (ext === "term" && !path_split(absolutePath).tail.startsWith(".")) {
    return termPath({ path: absolutePath, cmd: "", number: 0 });
  }
  return absolutePath;
}

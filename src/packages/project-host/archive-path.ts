/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import path from "node:path";
import { projectRuntimeHomeRelativePath } from "@cocalc/util/project-runtime";

export function normalizeArchivePath(rawPath: string): string {
  const normalized = path.posix.normalize(
    `${rawPath ?? ""}`.replace(/\\/g, "/"),
  );
  if (normalized === "." || normalized === "/") {
    return "";
  }
  const runtimeRelative = projectRuntimeHomeRelativePath(normalized);
  if (runtimeRelative != null) {
    return runtimeRelative;
  }
  return normalized.replace(/^\/+/, "").replace(/^\.\/+/, "");
}

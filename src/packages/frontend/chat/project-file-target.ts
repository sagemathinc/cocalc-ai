/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import {
  parseLineFromHashFragment,
  parsePathWithOptionalLineSuffix,
} from "@cocalc/frontend/project/parse-path-line";
import { isAbsolutePath, normalizeAbsolutePath } from "@cocalc/util/path-model";

export interface ProjectFileTarget {
  path: string;
  line?: number;
}

export function projectFileTargetFromHref({
  href,
  projectId,
  basePath,
}: {
  href?: string | null;
  projectId?: string;
  basePath?: string;
}): ProjectFileTarget | undefined {
  const raw = href?.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("mailto:")) return;
  let target = raw;
  let line: number | undefined;
  if (raw.startsWith("cocalc-file:")) {
    try {
      const url = new URL(raw);
      target = url.searchParams.get("path") ?? "";
      const lineParam = Number(url.searchParams.get("line"));
      line =
        Number.isInteger(lineParam) && lineParam > 0
          ? lineParam
          : parseLineFromHashFragment(url.hash);
    } catch {
      return;
    }
  } else if (raw.startsWith("sandbox:")) {
    target = raw.slice("sandbox:".length);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
    return;
  }
  const hashIndex = target.indexOf("#");
  const hash = hashIndex >= 0 ? target.slice(hashIndex) : undefined;
  target = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep malformed-but-usable project paths literal.
  }
  const parsed = parsePathWithOptionalLineSuffix(target);
  line ??= parsed.line ?? parseLineFromHashFragment(hash);
  const home = getProjectHomeDirectory(projectId);
  let path = parsed.path.replace(/\\/g, "/");
  if (path === "~") path = home;
  else if (path.startsWith("~/"))
    path = normalizeAbsolutePath(path.slice(2), home);
  else if (!isAbsolutePath(path)) {
    path = normalizeAbsolutePath(path, basePath || home);
  } else {
    path = normalizeAbsolutePath(path);
  }
  return path ? { path, line } : undefined;
}

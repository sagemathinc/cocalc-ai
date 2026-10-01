/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { normalize as normalizePath } from "path";

// Normalize path as in node, except '' is the home dir, not '.'.
// Also, if ~/ is somewhere in the path, start over at home.
export function normalize(path: string): string {
  while (true) {
    const pattern = "/~/";
    const i = path.indexOf(pattern);
    if (i == -1) {
      break;
    }
    path = path.slice(i + pattern.length);
  }
  if (path.startsWith("~/")) {
    path = path.slice(2);
  }

  path = normalizePath(path);
  if (path === ".") {
    return "";
  } else {
    return path;
  }
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { projectRuntimeHomeRelativePath } from "./project-runtime";

export function normalizeCoursePath(path: string): string {
  const input = `${path ?? ""}`.trim().replace(/\\/g, "/");
  const raw = projectRuntimeHomeRelativePath(input) ?? input;
  if (!raw || raw.startsWith("/") || raw.includes("\0")) {
    throw new Error("invalid course path");
  }
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("invalid course path");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const normalized = parts.join("/");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    !normalized.toLowerCase().endsWith(".course")
  ) {
    throw new Error("invalid course path");
  }
  return normalized;
}

export function defaultCourseTitle(path: string): string {
  try {
    const normalized = normalizeCoursePath(path);
    return normalized.slice(0, -".course".length) || "Course";
  } catch {
    // Existing course files may use a legacy or transient client path. A
    // display default must not abort course-store initialization.
    const filename = `${path ?? ""}`
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop();
    return filename?.replace(/\.course$/i, "") || "Course";
  }
}

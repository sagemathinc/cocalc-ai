/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// One-click Scan: find .chat files in a project with fd through the
// project-host filesystem (no compute start), changed since this account's
// last scan of that project.

import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { resolveProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { joinAbsolutePath } from "@cocalc/util/path-model";
import { normalizeConversationPath } from "@cocalc/util/people";

export const SCAN_MAX_RESULTS = 2000;
// Places that hold agent or tool chats, caches and snapshots, not
// conversations between people.
export const SCAN_EXCLUDES = [
  ".snapshots",
  ".trash",
  ".local",
  ".cache",
  "node_modules",
];

export function fdOptions(scannedAt?: number | null, now = Date.now()) {
  const options = [
    "--type",
    "f",
    "--extension",
    "chat",
    "--hidden",
    "--no-ignore",
    "--max-results",
    `${SCAN_MAX_RESULTS}`,
  ];
  for (const exclude of SCAN_EXCLUDES) options.push("--exclude", exclude);
  if (scannedAt != null) {
    // A minute of overlap so edits during the previous scan are not missed.
    const seconds = Math.max(60, Math.ceil((now - scannedAt) / 1000) + 60);
    options.push("--changed-within", `${seconds}s`);
  }
  return options;
}

export function parseFdOutput(home: string, stdout: string): string[] {
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    const value = line.trim().replace(/^\.\//, "");
    if (!value) continue;
    try {
      paths.add(
        normalizeConversationPath(
          value.startsWith("/") ? value : joinAbsolutePath(home, value),
        ),
      );
    } catch {
      // not a usable .chat path
    }
  }
  return [...paths].sort();
}

export interface ProjectScanResult {
  project_id: string;
  paths: string[];
  truncated: boolean;
}

export async function scanProject(
  project_id: string,
  scannedAt?: number | null,
): Promise<ProjectScanResult> {
  await ensureProjectReduxRuntime();
  const project = redux.getProjectActions(project_id);
  if (project == null) throw Error("project is not available");
  const home = await resolveProjectHomeDirectory(project_id);
  const output = await project.fs().fd(home, {
    options: fdOptions(scannedAt),
    timeout: 30_000,
    maxSize: 4_000_000,
  });
  if (output.code && !output.stdout?.length) {
    throw Error(Buffer.from(output.stderr ?? "").toString() || "scan failed");
  }
  const paths = parseFdOutput(home, Buffer.from(output.stdout).toString());
  return {
    project_id,
    paths,
    truncated: !!output.truncated || paths.length >= SCAN_MAX_RESULTS,
  };
}

export async function fileModified(
  project_id: string,
  path: string,
): Promise<number | undefined> {
  const stat: any = await redux.getProjectActions(project_id)?.fs().stat(path);
  const mtime = stat?.mtimeMs ?? stat?.mtime;
  const value = mtime instanceof Date ? mtime.valueOf() : Number(mtime);
  return Number.isFinite(value) ? value : undefined;
}

export function titleFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  return (
    name
      .replace(/\.chat$/, "")
      .replace(/[-_]+/g, " ")
      .trim() || name
  );
}

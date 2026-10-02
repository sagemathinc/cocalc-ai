/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Search inside files: ripgrep from a project's home directory on its host
// (no compute start needed), a few matches per file. Literal and
// case-insensitive, like the rest of search.

import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { resolveProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";

export const MATCHES_PER_FILE = 3;
export const MATCHES_PER_PROJECT = 50;
const MAX_LINE = 200;

export interface ContentHit {
  project_id: string;
  // Relative to the project's home directory.
  path: string;
  line: number;
  text: string;
}

export function rgOptions(): string[] {
  return [
    "--json",
    "-F",
    "-i",
    "--max-count",
    `${MATCHES_PER_FILE}`,
    "--max-filesize",
    "2M",
  ];
}

// ripgrep --json output to hits, with paths relative to `home`.
export function parseRipgrepJson(
  project_id: string,
  output: string,
  home: string,
): { items: ContentHit[]; truncated: boolean } {
  const prefix = home.replace(/\/+$/, "") + "/";
  const items: ContentHit[] = [];
  let truncated = false;
  for (const line of output.split("\n")) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== "match") continue;
    if (items.length >= MATCHES_PER_PROJECT) {
      truncated = true;
      break;
    }
    const path: string = row.data?.path?.text ?? "";
    const text = `${row.data?.lines?.text ?? ""}`.replace(/\r?\n$/, "").trim();
    items.push({
      project_id,
      path: path.startsWith(prefix)
        ? path.slice(prefix.length)
        : path.replace(/^\.\//, ""),
      line: Number(row.data?.line_number) || 1,
      text: text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text,
    });
  }
  return { items, truncated };
}

export async function searchProjectContents(
  project_id: string,
  query: string,
  timeout: number,
): Promise<{ items: ContentHit[]; truncated: boolean }> {
  await ensureProjectReduxRuntime();
  const project = redux.getProjectActions(project_id);
  if (project == null) throw Error("project is not available");
  const home = await resolveProjectHomeDirectory(project_id);
  const output = await project.fs().ripgrep(home, query, {
    options: rgOptions(),
    timeout,
    maxSize: 1_000_000,
  });
  // ripgrep exits 1 when nothing matched; that is not an error.
  if (output.code && output.code !== 1 && !output.stdout?.length) {
    throw Error(Buffer.from(output.stderr ?? "").toString() || "search failed");
  }
  const result = parseRipgrepJson(
    project_id,
    Buffer.from(output.stdout).toString(),
    home,
  );
  return { ...result, truncated: result.truncated || !!output.truncated };
}

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

export interface SnapshotHit {
  project_id: string;
  snapshot: string; // the snapshot's name, a date
  // Relative to the snapshot (i.e., to the home directory then).
  path: string;
  // Set for a match inside the file; unset for a file name match.
  line?: number;
  text?: string;
}

// Hits in ~/.snapshots/<snapshot>/... to one hit per file and line (or per
// file name), from the newest snapshot that has it.
export function newestSnapshotHits(
  project_id: string,
  hits: { path: string; line?: number; text?: string }[],
  snapshotsDir: string,
): SnapshotHit[] {
  const prefix = snapshotsDir.replace(/\/+$/, "") + "/";
  const best = new Map<string, SnapshotHit>();
  for (const hit of hits) {
    const relative = hit.path.startsWith(prefix)
      ? hit.path.slice(prefix.length)
      : hit.path;
    const slash = relative.indexOf("/");
    if (slash <= 0) continue;
    const snapshot = relative.slice(0, slash);
    const path = relative.slice(slash + 1);
    const key = `${path}\0${hit.line ?? ""}`;
    const current = best.get(key);
    if (current == null || current.snapshot < snapshot)
      best.set(key, {
        project_id,
        snapshot,
        path,
        line: hit.line,
        text: hit.text,
      });
  }
  return [...best.values()].sort((a, b) =>
    a.path === b.path
      ? (a.line ?? 0) - (b.line ?? 0)
      : a.path < b.path
        ? -1
        : 1,
  );
}

// A few snapshots spread over time: the newest, and the ones closest to a
// day, a week and a month before it. Snapshots are frequent and nearly
// identical, so searching all of them would mostly repeat the same work.
export function spreadSnapshots(names: string[]): string[] {
  const dated = names
    .map((name) => ({ name, time: Date.parse(name) }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => b.time - a.time);
  if (!dated.length) return [];
  const newest = dated[0].time;
  const picks = new Set<string>([dated[0].name]);
  for (const days of [1, 7, 30]) {
    const target = newest - days * 24 * 60 * 60 * 1000;
    let best = dated[0];
    for (const d of dated)
      if (Math.abs(d.time - target) < Math.abs(best.time - target)) best = d;
    picks.add(best.name);
  }
  return [...picks];
}

// File names and contents in the project's snapshots (searched when the
// current files have nothing; e.g., to find something deleted).
export async function searchProjectSnapshots(
  project_id: string,
  query: string,
  timeout: number,
): Promise<{ items: SnapshotHit[]; truncated: boolean }> {
  await ensureProjectReduxRuntime();
  const project = redux.getProjectActions(project_id);
  if (project == null) throw Error("project is not available");
  const home = await resolveProjectHomeDirectory(project_id);
  const dir = `${home.replace(/\/+$/, "")}/.snapshots`;
  const fs = project.fs();
  const snapshots = spreadSnapshots(await fs.readdir(dir));
  let truncated = false;
  const hits: { path: string; line?: number; text?: string }[] = [];
  await Promise.all(
    snapshots.map(async (snapshot) => {
      const root = `${dir}/${snapshot}`;
      const [names, contents] = await Promise.all([
        fs.fd(root, {
          pattern: `*${query.trim()}*`,
          options: ["-g", "-i", "-H", "-I", "--max-results", "100"],
          timeout,
          maxSize: 500_000,
        }),
        fs.ripgrep(root, query, {
          options: [...rgOptions(), "-.", "--no-ignore"],
          timeout,
          maxSize: 500_000,
        }),
      ]);
      truncated ||= !!names.truncated || !!contents.truncated;
      // Paths come back relative to the directory searched, or absolute.
      const inSnapshot = (path: string) =>
        `${snapshot}/${(path.startsWith(root + "/")
          ? path.slice(root.length + 1)
          : path.replace(/^\.\//, "")
        ).replace(/\/+$/, "")}`;
      for (const path of Buffer.from(names.stdout ?? "")
        .toString()
        .split("\n")
        .filter(Boolean))
        hits.push({ path: inSnapshot(path) });
      for (const { path, line, text } of parseRipgrepJson(
        project_id,
        Buffer.from(contents.stdout ?? "").toString(),
        root,
      ).items)
        hits.push({ path: inSnapshot(path), line, text });
    }),
  );
  const items = newestSnapshotHits(project_id, hits, dir).slice(
    0,
    MATCHES_PER_PROJECT,
  );
  return {
    items,
    truncated: truncated || items.length >= MATCHES_PER_PROJECT,
  };
}

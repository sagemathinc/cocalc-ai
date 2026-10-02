/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Search projects": find files by name across projects, like the project
// search's Files tab (fd), but in several projects at once -- most recently
// used first, a few at a time, within a time budget. Projects whose host
// does not answer in time are reported as unavailable, not as no matches.
// "Search more" continues with the projects not reached yet.

import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { resolveProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { withTimeout } from "@cocalc/util/async-utils";

export const SEARCH_BUDGET_MS = 20_000;
export const PROJECT_TIMEOUT_MS = 8_000;
export const CONCURRENCY = 6;
export const RESULTS_PER_PROJECT = 50;
export const MAX_HITS = 500;

export interface FileSearchOptions {
  hidden: boolean;
  caseSensitive: boolean;
  // Respect .gitignore and friends (fd's default).
  ignore: boolean;
}

export interface FileHit {
  project_id: string;
  // Relative to the project's home directory.
  path: string;
}

export interface FileSearchProgress {
  hits: FileHit[];
  searched: string[];
  unavailable: string[];
  // Not reached within the budget; "Search more" continues with these.
  pending: string[];
  // Some project had more matches than shown.
  truncated: boolean;
}

export type ProjectFileSearch = (
  project_id: string,
  query: string,
  options: FileSearchOptions,
  timeout: number,
) => Promise<{ paths: string[]; truncated: boolean }>;

export function fdGlob(query: string): string {
  const q = query.trim();
  return /[*?[]/.test(q) ? q : `*${q}*`;
}

export function fdOptions(options: FileSearchOptions): string[] {
  return [
    "-g",
    ...(options.hidden ? ["-H"] : []),
    ...(options.ignore ? [] : ["-I"]),
    options.caseSensitive ? "-s" : "-i",
    "--max-results",
    `${RESULTS_PER_PROJECT}`,
  ];
}

// One project's search: fd from its home directory on the project host
// (no compute start needed).
export const searchProjectFiles: ProjectFileSearch = async (
  project_id,
  query,
  options,
  timeout,
) => {
  await ensureProjectReduxRuntime();
  const project = redux.getProjectActions(project_id);
  if (project == null) throw Error("project is not available");
  const home = await resolveProjectHomeDirectory(project_id);
  const output = await project.fs().fd(home, {
    pattern: fdGlob(query),
    options: fdOptions(options),
    timeout,
    maxSize: 1_000_000,
  });
  if (output.code && !output.stdout?.length) {
    throw Error(Buffer.from(output.stderr ?? "").toString() || "search failed");
  }
  const prefix = home.replace(/\/+$/, "") + "/";
  const paths = Buffer.from(output.stdout)
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((path) =>
      path.startsWith(prefix)
        ? path.slice(prefix.length)
        : path.replace(/^\.\//, ""),
    );
  return {
    paths,
    truncated: !!output.truncated || paths.length >= RESULTS_PER_PROJECT,
  };
};

export async function runProjectFileSearch({
  project_ids,
  query,
  options,
  canceled = () => false,
  report,
  search = searchProjectFiles,
  budgetMs = SEARCH_BUDGET_MS,
  now = () => Date.now(),
}: {
  // Most recently used first.
  project_ids: string[];
  query: string;
  options: FileSearchOptions;
  canceled?: () => boolean;
  report: (progress: FileSearchProgress) => void;
  search?: ProjectFileSearch;
  budgetMs?: number;
  now?: () => number;
}): Promise<FileSearchProgress> {
  const deadline = now() + budgetMs;
  const queue = [...project_ids];
  const progress: FileSearchProgress = {
    hits: [],
    searched: [],
    unavailable: [],
    pending: [...queue],
    truncated: false,
  };
  const publish = () =>
    report({
      ...progress,
      hits: [...progress.hits],
      pending: [...queue],
    });
  const more = () =>
    !canceled() &&
    now() < deadline &&
    progress.hits.length < MAX_HITS &&
    queue.length > 0;
  async function worker() {
    while (more()) {
      const project_id = queue.shift()!;
      const timeout = Math.max(
        1000,
        Math.min(PROJECT_TIMEOUT_MS, deadline - now()),
      );
      try {
        // A host that never answers must not hold a worker past its time.
        const result = await withTimeout(
          search(project_id, query, options, timeout),
          timeout + 2000,
        );
        if (canceled()) return;
        progress.searched.push(project_id);
        progress.truncated ||= result.truncated;
        for (const path of result.paths) {
          if (progress.hits.length >= MAX_HITS) {
            progress.truncated = true;
            break;
          }
          progress.hits.push({ project_id, path });
        }
      } catch {
        if (canceled()) return;
        progress.unavailable.push(project_id);
      }
      publish();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  );
  progress.pending = [...queue];
  return { ...progress, hits: [...progress.hits] };
}

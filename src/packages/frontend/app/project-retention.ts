/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// With sidebar navigation there are no project tabs to open and close.
// Visiting a project mounts it, and the least recently visited ones are
// released in the background, like agent workspaces. Releasing uses the same
// path as closing a tab, which saves the project's open files so they come
// back on the next visit.

import { defaultRetainedWorkspaceLimit } from "@cocalc/frontend/agents/use-retained-workspaces";

const visited = new Map<string, number>();
let clock = 0;

export function noteProjectVisit(project_id: string): void {
  // A counter, not Date.now(), so visits in the same millisecond still order.
  visited.set(project_id, ++clock);
}

// Projects to release so at most `limit` stay open; never the current one.
// Projects not visited in this session (e.g. restored from the last one)
// go first, in their open order.
export function projectsToRelease(
  open: string[],
  current: string | undefined,
  limit = defaultRetainedWorkspaceLimit(),
): string[] {
  const others = open.filter((id) => id !== current);
  const extra =
    others.length + (current && open.includes(current) ? 1 : 0) - limit;
  if (extra <= 0) return [];
  return others
    .map((id, index) => ({ id, index, at: visited.get(id) ?? 0 }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .slice(0, extra)
    .map(({ id }) => id);
}

export function resetProjectVisitsForTests(): void {
  visited.clear();
  clock = 0;
}

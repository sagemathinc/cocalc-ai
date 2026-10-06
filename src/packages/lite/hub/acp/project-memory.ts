/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A project's memory limit and how often the kernel has OOM-killed one of its
// processes, from its cgroup on a project host. Used to tell whether an agent
// that was killed mid-turn hit the project's memory limit. Both are
// undefined where there is no such cgroup (e.g. local Lite).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PROJECT_POOL = "/sys/fs/cgroup/cocalc-project-pool";

export interface ProjectMemoryEvents {
  oomKills?: number;
  limitBytes?: number;
}

export function parseOomKills(raw: string): number | undefined {
  const value = Number(raw.match(/(?:^|\n)oom_kill\s+(\d+)/)?.[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseMemoryMax(raw: string): number | undefined {
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export async function readProjectMemoryEvents(
  projectId: string,
  pool = PROJECT_POOL,
): Promise<ProjectMemoryEvents> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return {};
  const dir = join(pool, `project-${projectId}`);
  const read = async (name: string) => {
    try {
      return await readFile(join(dir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const [events, max] = await Promise.all([
    read("memory.events"),
    read("memory.max"),
  ]);
  return {
    oomKills: events == null ? undefined : parseOomKills(events),
    limitBytes: max == null ? undefined : parseMemoryMax(max),
  };
}

// Whether the project's processes were OOM-killed between two readings.
export function oomKilledBetween(
  before: ProjectMemoryEvents,
  after: ProjectMemoryEvents,
): boolean {
  return (
    before.oomKills != null &&
    after.oomKills != null &&
    after.oomKills > before.oomKills
  );
}

export function formatMemoryLimit(bytes?: number): string | undefined {
  if (bytes == null) return undefined;
  const gb = bytes / 1e9;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${Math.round(gb * 10) / 10} GB`;
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

function normalizeProjectIds(projectIds: Iterable<string>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const project_id of projectIds) {
    const trimmed = `${project_id ?? ""}`.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function partitionAcpStartupProjectIds(opts: {
  provisionedProjectIds: Iterable<string>;
  localAutomationProjectIds: Iterable<string>;
}): {
  rehydrateProjectIds: string[];
  staleProjectIds: string[];
} {
  const provisionedProjectIds = new Set(
    normalizeProjectIds(opts.provisionedProjectIds),
  );
  const localAutomationProjectIds = normalizeProjectIds(
    opts.localAutomationProjectIds,
  );
  const rehydrateProjectIds: string[] = [];
  const staleProjectIds: string[] = [];

  for (const project_id of localAutomationProjectIds) {
    if (provisionedProjectIds.has(project_id)) {
      rehydrateProjectIds.push(project_id);
    } else {
      staleProjectIds.push(project_id);
    }
  }

  return { rehydrateProjectIds, staleProjectIds };
}

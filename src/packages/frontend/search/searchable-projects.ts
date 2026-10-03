/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Projects to search: not deleted or archived, by this account's last use.
export function searchableProjects(project_map: any, account_id?: string) {
  const list: { id: string; used: number }[] = [];
  project_map?.forEach((project, project_id: string) => {
    if (project.get("deleted")) return;
    if (project.getIn(["state", "state"]) === "archived") return;
    const used = new Date(
      (account_id && project.getIn(["last_active", account_id])) ||
        project.get("last_edited") ||
        0,
    ).valueOf();
    list.push({ id: project_id, used: Number.isFinite(used) ? used : 0 });
  });
  return list.sort((a, b) => b.used - a.used).map(({ id }) => id);
}

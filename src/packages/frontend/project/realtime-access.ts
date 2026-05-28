/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function canUseCollaboratorProjectRealtime({
  account_id,
  is_admin,
  project_id,
  projectsStore,
}: {
  account_id?: string;
  is_admin?: boolean;
  project_id: string;
  projectsStore?:
    | {
        getIn?: (path: string[]) => unknown;
      }
    | undefined;
}): boolean {
  if (is_admin) {
    return true;
  }
  if (!account_id) {
    return false;
  }
  return isCollaboratorProjectRole(
    getProjectUserRole({ account_id, project_id, projectsStore }),
  );
}

export function getProjectUserRole({
  account_id,
  project_id,
  projectsStore,
}: {
  account_id?: string;
  project_id: string;
  projectsStore?:
    | {
        getIn?: (path: string[]) => unknown;
      }
    | undefined;
}): string | undefined {
  if (!account_id) {
    return;
  }
  const entry = projectsStore?.getIn?.([
    "project_map",
    project_id,
    "users",
    account_id,
  ]);
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof (entry as any).get === "function") {
    return `${(entry as any).get("group") ?? ""}` || undefined;
  }
  if (entry && typeof entry === "object") {
    return `${(entry as any).group ?? ""}` || undefined;
  }
}

export function isCollaboratorProjectRole(role?: string): boolean {
  return role === "owner" || role === "collaborator";
}

export function isViewerProjectRole(role?: string): boolean {
  return role === "viewer";
}

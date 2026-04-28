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
  return (
    projectsStore?.getIn?.(["project_map", project_id, "users", account_id]) !=
    null
  );
}

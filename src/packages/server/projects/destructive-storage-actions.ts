/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import isAdmin from "@cocalc/server/accounts/is-admin";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";

export async function assertCanPerformDestructiveStorageAction({
  account_id,
  project_id,
  action,
}: {
  account_id?: string;
  project_id: string;
  action: string;
}): Promise<void> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  if (await isAdmin(account_id)) {
    return;
  }
  const project = await assertProjectCollaboratorAccessAllowRemote({
    account_id,
    project_id,
  });
  const group = project.users?.[account_id]?.group;
  if (group === "owner") {
    return;
  }
  if (project.allow_collaborator_destructive_storage_actions === true) {
    return;
  }
  throw Error(
    `Only project owners can ${action} unless the owner allows collaborators to manage storage history.`,
  );
}

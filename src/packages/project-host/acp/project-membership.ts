/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import { setAcpProjectMembershipChecker } from "@cocalc/lite/hub/acp/agent-delivery-authorization";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import { isValidUUID } from "@cocalc/util/misc";

/** Owner or collaborator on the host's local project record, the same test
 * the host applies to conat access. Unknown projects and accounts fail. */
export function isAcpProjectMember({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): boolean {
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) return false;
  const row = getRow("projects", JSON.stringify({ project_id }));
  const entry = row?.users?.[account_id];
  const group = typeof entry === "string" ? entry : entry?.group;
  return isProjectCollaboratorGroup(group);
}

/** Agent work runs only for senders who may still use the project. */
export function initAcpProjectMembership(): void {
  setAcpProjectMembershipChecker(isAcpProjectMember);
}

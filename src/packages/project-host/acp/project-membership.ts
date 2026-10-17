/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import callHub from "@cocalc/conat/hub/call-hub";
import { setAcpProjectMembershipChecker } from "@cocalc/lite/hub/acp/agent-delivery-authorization";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import { isValidUUID } from "@cocalc/util/misc";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";
import { upsertProject } from "../sqlite/projects";

const logger = getLogger("project-host:acp:project-membership");

const OWNING_BAY_TIMEOUT_MS = 15_000;

function isMember(users: unknown, account_id: string): boolean {
  const entry = (users as Record<string, any> | undefined)?.[account_id];
  const group = typeof entry === "string" ? entry : entry?.group;
  return isProjectCollaboratorGroup(group);
}

function localProjectRow(project_id: string): any {
  return getRow("projects", JSON.stringify({ project_id }));
}

/** Owner or collaborator on the host's local project record, the same test
 * the host applies to conat access. Unknown projects and accounts fail. */
export function isLocalAcpProjectMember({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): boolean {
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) return false;
  return isMember(localProjectRow(project_id)?.users, account_id);
}

/** The owning bay's collaborator list for a project assigned to this host;
 * the hub refuses projects that are not. */
async function loadUsersFromOwningBay(
  project_id: string,
): Promise<{ users?: unknown; users_revision?: number } | undefined> {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) return undefined;
  return await callHub({
    client,
    host_id,
    name: "hosts.getProjectStartMetadata",
    args: [{ project_id }],
    timeout: OWNING_BAY_TIMEOUT_MS,
  });
}

/**
 * Whether an account may still have agent work run in a project. The host's
 * copy of the collaborator list is checked first. That copy can lag behind
 * the owning bay, so a miss is confirmed with the bay before refusing, and
 * the bay's (versioned) list is stored. Unknown projects and accounts fail,
 * and so does a bay that cannot be reached.
 */
export async function isAcpProjectMember({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<boolean> {
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) return false;
  if (isLocalAcpProjectMember({ account_id, project_id })) return true;
  let authoritative: Awaited<ReturnType<typeof loadUsersFromOwningBay>>;
  try {
    authoritative = await loadUsersFromOwningBay(project_id);
  } catch (err) {
    logger.warn("could not confirm project membership with the owning bay", {
      project_id,
      account_id,
      err: `${err}`,
    });
    return false;
  }
  if (authoritative?.users == null) return false;
  const member = isMember(authoritative.users, account_id);
  if (!member) return false;
  // The local copy wrongly refused a member: record how it differed.
  const local = localProjectRow(project_id);
  logger.warn("host collaborator list was missing a member", {
    project_id,
    account_id,
    local_row: local != null,
    local_users: Object.keys(local?.users ?? {}).length,
    local_users_revision: local?.users_revision ?? null,
    bay_users_revision: authoritative.users_revision ?? null,
  });
  if (local != null && authoritative.users_revision != null) {
    try {
      upsertProject({
        project_id,
        users: authoritative.users as Record<string, any>,
        users_revision: authoritative.users_revision,
      });
    } catch (err) {
      logger.warn("could not store the owning bay's collaborator list", {
        project_id,
        err: `${err}`,
      });
    }
  }
  return true;
}

/** Agent work runs only for senders who may still use the project. */
export function initAcpProjectMembership(): void {
  setAcpProjectMembershipChecker(isAcpProjectMember);
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

type ProjectLike = any;

export type ProjectStartPolicyBlockCode =
  | "autostart_disabled"
  | "collaborator_sponsor_disabled";

export interface ProjectStartPolicyBlock {
  code: ProjectStartPolicyBlockCode;
  message: string;
  action?: string;
  sponsor_account_id?: string;
}

function getValue(obj: any, key: string): any {
  if (obj == null) return undefined;
  if (typeof obj.get === "function") return obj.get(key);
  return obj[key];
}

function getInValue(obj: any, path: string[]): any {
  if (obj == null) return undefined;
  if (typeof obj.getIn === "function") return obj.getIn(path);
  let cur = obj;
  for (const key of path) {
    cur = getValue(cur, key);
    if (cur == null) return cur;
  }
  return cur;
}

function userAccountIds(users: any): string[] {
  if (users == null) return [];
  if (typeof users.keySeq === "function") return users.keySeq().toArray();
  if (users instanceof Map) return Array.from(users.keys());
  return Object.keys(users);
}

export function accountIsProjectCollaborator(
  project: ProjectLike,
  account_id: string | undefined,
): boolean {
  if (!account_id) return false;
  const group = getInValue(project, ["users", account_id, "group"]);
  return group === "owner" || group === "collaborator";
}

export function projectOwnerAccountId(
  project: ProjectLike,
): string | undefined {
  const users = getValue(project, "users");
  for (const account_id of userAccountIds(users)) {
    if (getInValue(users, [account_id, "group"]) === "owner") {
      return account_id;
    }
  }
  return undefined;
}

export function runtimeSponsorAccountId(
  project: ProjectLike,
): string | undefined {
  const explicitSponsor = `${getValue(project, "runtime_sponsor_account_id") ?? ""}`;
  if (accountIsProjectCollaborator(project, explicitSponsor)) {
    return explicitSponsor;
  }
  const usageSponsor = `${getValue(project, "usage_account_id") ?? ""}`;
  if (accountIsProjectCollaborator(project, usageSponsor)) {
    return usageSponsor;
  }
  return projectOwnerAccountId(project);
}

export function canActorStartUsingRuntimeSponsor({
  project,
  account_id,
  is_admin,
}: {
  project: ProjectLike;
  account_id: string | undefined;
  is_admin?: boolean;
}): boolean {
  if (!project) return true;
  if (is_admin) return true;
  const sponsorAccountId = runtimeSponsorAccountId(project);
  if (account_id && account_id === sponsorAccountId) return true;
  if (account_id && account_id === projectOwnerAccountId(project)) return true;
  if (getValue(project, "allow_collaborator_starts_using_sponsor") !== false) {
    return true;
  }
  return false;
}

export function getProjectStartPolicyBlock({
  project,
  account_id,
  is_admin,
  autostart,
}: {
  project: ProjectLike;
  account_id?: string;
  is_admin?: boolean;
  autostart?: boolean;
}): ProjectStartPolicyBlock | undefined {
  if (!project) return undefined;
  if (autostart && getValue(project, "autostart_enabled") === false) {
    return {
      code: "autostart_disabled",
      message:
        "Automatic starts are disabled for this project. Use the project Start button, then try again.",
      action: "Start the project manually, then try again.",
    };
  }
  if (!canActorStartUsingRuntimeSponsor({ project, account_id, is_admin })) {
    return {
      code: "collaborator_sponsor_disabled",
      sponsor_account_id: runtimeSponsorAccountId(project),
      message:
        "Collaborators cannot start this project using the current runtime sponsor's membership.",
      action:
        "Use your membership as the runtime sponsor to start it. If your running-project slots are full, CoCalc will show projects you can stop.",
    };
  }
  return undefined;
}

export function formatProjectStartPolicyBlock(
  block: ProjectStartPolicyBlock,
): string {
  return block.action ? `${block.message} ${block.action}` : block.message;
}

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ProjectUsers = Record<string, { group?: string }> | null;

export interface RuntimeSponsorProjectFields {
  runtime_sponsor_account_id?: string | null;
  usage_account_id?: string | null;
  users?: ProjectUsers;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isProjectCollaborator(
  users: ProjectUsers | undefined,
  account_id: string | undefined,
): boolean {
  if (users == null || account_id == null) return false;
  const group = users[account_id]?.group;
  return group === "owner" || group === "collaborator";
}

export function getProjectOwnerAccountId(
  users: ProjectUsers | undefined,
): string | undefined {
  if (users == null) return;
  const userIds = Object.keys(users);
  return userIds.find((id) => users[id]?.group === "owner") ?? userIds[0];
}

export function resolveRuntimeSponsorAccountId(
  project: RuntimeSponsorProjectFields,
): string | undefined {
  const runtimeSponsor = nonemptyString(project.runtime_sponsor_account_id);
  if (isProjectCollaborator(project.users, runtimeSponsor)) {
    return runtimeSponsor;
  }
  const usageSponsor = nonemptyString(project.usage_account_id);
  if (isProjectCollaborator(project.users, usageSponsor)) {
    return usageSponsor;
  }
  return getProjectOwnerAccountId(project.users);
}

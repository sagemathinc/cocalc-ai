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
  return (
    nonemptyString(project.runtime_sponsor_account_id) ??
    nonemptyString(project.usage_account_id) ??
    getProjectOwnerAccountId(project.users)
  );
}

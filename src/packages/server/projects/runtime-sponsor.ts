/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ProjectUsers = Record<string, { group?: string }> | null;

export interface RuntimeSponsorProjectFields {
  runtime_sponsor_account_id?: string | null;
  usage_account_id?: string | null;
  allow_collaborator_starts_using_sponsor?: boolean | null;
  autostart_enabled?: boolean | null;
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

export function canActorStartUsingRuntimeSponsor({
  project,
  actor_account_id,
  sponsor_account_id,
  is_admin = false,
}: {
  project: RuntimeSponsorProjectFields;
  actor_account_id?: string | null;
  sponsor_account_id?: string;
  is_admin?: boolean;
}): boolean {
  if (is_admin) return true;
  const actor = nonemptyString(actor_account_id);
  if (!actor) {
    return project.allow_collaborator_starts_using_sponsor !== false;
  }
  if (actor === sponsor_account_id) return true;
  if (actor === getProjectOwnerAccountId(project.users)) return true;
  return project.allow_collaborator_starts_using_sponsor !== false;
}

export function collaboratorSponsorStartDisabledError(): Error {
  return new Error(
    "Collaborator starts using the runtime sponsor's membership are disabled for this project. Ask a project owner or the runtime sponsor to start it, or ask them to enable collaborator starts.",
  );
}

export function projectAutostartDisabledError(): Error {
  const err = new Error(
    "Automatic starts are disabled for this project. Open the project and use the Start button, or ask a project owner to enable automatic starts.",
  ) as Error & { code?: string };
  err.code = "project_autostart_disabled";
  return err;
}

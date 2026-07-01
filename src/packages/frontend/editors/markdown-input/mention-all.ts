/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";

export const ALL_PROJECT_COLLABORATORS_MENTION_ID =
  "__cocalc_all_project_collaborators__";

export const ALL_PROJECT_COLLABORATORS_MENTION_NAME = "all";

export function isAllProjectCollaboratorsMention(account_id: string): boolean {
  return account_id === ALL_PROJECT_COLLABORATORS_MENTION_ID;
}

export function mentionDisplayText(account_id: string, text: string): string {
  return isAllProjectCollaboratorsMention(account_id) ? "@all" : text;
}

function projectUserGroup(user: any): string | undefined {
  return typeof user?.get === "function" ? user.get("group") : user?.group;
}

function isMentionableCollaboratorGroup(group: unknown): boolean {
  return group === "owner" || group === "collaborator";
}

export function getMentionAllAccountIds(project_id: string): string[] {
  const users = redux
    .getStore("projects")
    .getIn(["project_map", project_id, "users"]);
  const my_account_id = redux.getStore("account")?.get("account_id");
  const accountIds: string[] = [];
  for (const [account_id, user] of users ?? []) {
    if (account_id === my_account_id) {
      continue;
    }
    if (!isMentionableCollaboratorGroup(projectUserGroup(user))) {
      continue;
    }
    accountIds.push(account_id);
  }
  return accountIds;
}

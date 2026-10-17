/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { resolveProjectReferenceAllowRemote } from "@cocalc/server/conat/project-remote-access";
import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";

// Privileges that read like the person's mail. During a turn, everyone in the
// agent's project can use its key, so the key carries these only while that
// project has no other collaborators; any doubt drops them.
const SOLO_PROJECT_ACCOUNT_CAPABILITIES = new Set<string>([
  "notifications:manage",
]);

export async function issuableConnectorScope({
  account_id,
  source_project_id,
  scope,
}: {
  account_id: string;
  source_project_id: string;
  scope: ApiKeyScope;
}): Promise<ApiKeyScope> {
  if (!scope.account.some((cap) => SOLO_PROJECT_ACCOUNT_CAPABILITIES.has(cap)))
    return scope;
  let solo = false;
  try {
    const reference = await resolveProjectReferenceAllowRemote({
      account_id,
      project_id: source_project_id,
      warmRoute: false,
    });
    const members = Object.keys(reference?.users ?? {});
    solo = members.length === 1 && members[0] === account_id;
  } catch {
    solo = false;
  }
  if (solo) return scope;
  return {
    ...scope,
    account: scope.account.filter(
      (cap) => !SOLO_PROJECT_ACCOUNT_CAPABILITIES.has(cap),
    ),
  };
}

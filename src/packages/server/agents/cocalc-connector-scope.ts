/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getApiKeyAuthorizationState } from "@cocalc/server/api/key-authorization-state";
import { SOLO_PROJECT_ACCOUNT_CAPABILITIES } from "@cocalc/server/api/solo-project-capabilities";
import { resolveProjectReferenceAllowRemote } from "@cocalc/server/conat/project-remote-access";
import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";

/** Whether the account is the project's only member. Any doubt is "no". */
async function isSoloProject(
  account_id: string,
  project_id: string,
): Promise<boolean> {
  try {
    const reference = await resolveProjectReferenceAllowRemote({
      account_id,
      project_id,
      warmRoute: false,
    });
    const members = Object.keys(reference?.users ?? {});
    return members.length === 1 && members[0] === account_id;
  } catch {
    return false;
  }
}

/** A turn key's scope: solo-project privileges only for a solo project.
 * Issuance is a first filter; assertSoloProjectCapabilityInContext decides
 * on every use, since the project may become shared during the turn. */
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
  if (await isSoloProject(account_id, source_project_id)) return scope;
  return {
    ...scope,
    account: scope.account.filter(
      (cap) => !SOLO_PROJECT_ACCOUNT_CAPABILITIES.has(cap),
    ),
  };
}

/**
 * Each use of a solo-project privilege: a managed connector turn key may use
 * it only while its agent's project has no other collaborators right now. The
 * account's home bay says (authoritatively) whether the key is such a turn
 * key; a home that cannot say, or any doubt about membership, refuses.
 * Ordinary keys the person created themselves are not limited.
 */
export async function assertSoloProjectCapabilityInContext(principal: {
  account_id: string;
  key_id?: string;
  scope_revision?: number;
}): Promise<void> {
  if (!principal.key_id) throw Error("API key identity unavailable");
  const state = await getApiKeyAuthorizationState({
    account_id: principal.account_id,
    key_id: principal.key_id,
  });
  if (!state || state.scope_revision !== principal.scope_revision)
    throw Error("API key revoked or scope changed");
  if (state.connector_source_project_id === undefined)
    throw Error("this API key's notification access could not be confirmed");
  if (
    state.connector_source_project_id != null &&
    !(await isSoloProject(
      principal.account_id,
      state.connector_source_project_id,
    ))
  )
    throw Object.assign(
      Error(
        "an agent may manage notifications only in a project without other collaborators",
      ),
      { code: "api_key_shared_project" },
    );
}

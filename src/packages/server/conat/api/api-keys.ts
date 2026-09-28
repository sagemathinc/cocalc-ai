/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
export { decideApiKeyAction as decideAction } from "@cocalc/server/api/key-action-routing";
export { listApiKeyActions as listActions } from "@cocalc/server/api/key-action-routing";
import type { GetApiKeyViewerReadPolicyOptions } from "@cocalc/conat/hub/api/api-keys";
import { viewerPolicyForApiKeyGrant } from "@cocalc/util/api-key-scope";
import {
  isProjectCollaboratorRole,
  isProjectViewerRole,
} from "@cocalc/util/project-access";
import { getApiKeyAuthorizationState } from "@cocalc/server/api/key-authorization-state";
import { resolveProjectReferenceForMemberAllowRemote } from "@cocalc/server/conat/project-remote-access";

export async function getViewerReadPolicy({
  host_id,
  account_id,
  key_id,
  scope_revision,
  project_id,
  viewer_policy_hash,
}: GetApiKeyViewerReadPolicyOptions) {
  if (!host_id) throw new Error("host authorization is required");
  const state = await getApiKeyAuthorizationState({ account_id, key_id });
  if (!state || state.scope_revision !== scope_revision) {
    throw new Error("API key is revoked or its scope changed");
  }
  const policy = viewerPolicyForApiKeyGrant(state.scope, project_id);
  if (!policy) throw new Error("API key has no viewer read policy");
  const hash = createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex");
  if (hash !== viewer_policy_hash) {
    throw new Error("API key viewer policy has changed");
  }
  const reference = await resolveProjectReferenceForMemberAllowRemote({
    account_id,
    project_id,
  });
  const member = reference?.users?.[account_id];
  const group = typeof member === "string" ? member : member?.group;
  if (
    reference?.host_id !== host_id ||
    (!isProjectCollaboratorRole(group) && !isProjectViewerRole(group))
  ) {
    throw new Error("not authorized for API key viewer files");
  }
  return policy;
}

/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import {
  issueProjectHostApiKeyAuthToken,
  issueProjectHostApiKeyHttpToken,
} from "@cocalc/conat/auth/project-host-token";
import type {
  IssueProjectHostApiKeyAuthTokenRequest,
  IssueProjectHostAuthTokenResponse,
} from "@cocalc/conat/inter-bay/api";
import { getProjectHostAuthTokenPrivateKey } from "@cocalc/backend/data";
import { isValidUUID } from "@cocalc/util/misc";
import {
  apiKeyProjectGrant,
  viewerPolicyForApiKeyGrant,
} from "@cocalc/util/api-key-scope";
import { isProjectCollaboratorRole } from "@cocalc/util/project-access";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveHostBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveProjectReferenceForMemberAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { syncProjectUsersOnHostForBrowserAccess } from "@cocalc/server/conat/api/hosts-connection-auth";
import { getApiKeyAuthorizationState } from "./key-authorization-state";
import { assertApiKeyMembershipGrant } from "./project-membership-revocation";

export async function issueProjectHostApiKeyToken(
  request: IssueProjectHostApiKeyAuthTokenRequest,
): Promise<IssueProjectHostAuthTokenResponse> {
  const { host_id, project_id } = request;
  if (!isValidUUID(project_id) || !isValidUUID(host_id)) {
    throw new Error("invalid project-host API key target");
  }
  const hostBay = await resolveHostBay(host_id);
  if (!hostBay?.bay_id) {
    throw new Error("project host owner is unavailable");
  }
  if (hostBay.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge()
      .projectHostAuthToken(hostBay.bay_id)
      .issueApiKey(request);
  }
  return await issueProjectHostApiKeyTokenLocal(request);
}

export async function issueProjectHostApiKeyTokenLocal({
  account_id,
  key_id,
  scope_revision,
  project_id,
  host_id,
  http_proxy_port,
}: IssueProjectHostApiKeyAuthTokenRequest): Promise<IssueProjectHostAuthTokenResponse> {
  if (
    !isValidUUID(account_id) ||
    !isValidUUID(project_id) ||
    !isValidUUID(host_id) ||
    !Number.isSafeInteger(scope_revision) ||
    scope_revision < 1
  ) {
    throw new Error("invalid project-host API key request");
  }
  if (
    http_proxy_port !== undefined &&
    (!Number.isInteger(http_proxy_port) ||
      http_proxy_port < 1 ||
      http_proxy_port > 65535)
  ) {
    throw new Error("invalid project-host HTTP proxy port");
  }
  const hostBay = await resolveHostBay(host_id);
  if (hostBay?.bay_id !== getConfiguredBayId()) {
    throw new Error("project host is not owned by this bay");
  }
  const state = await getApiKeyAuthorizationState({ account_id, key_id });
  if (!state || state.scope_revision !== scope_revision) {
    throw new Error("API key is revoked or its scope changed");
  }
  const grant = apiKeyProjectGrant(state.scope, project_id);
  if (!grant) {
    throw new Error("API key does not grant this project");
  }
  if (
    http_proxy_port !== undefined &&
    !grant.capabilities.includes("project:exec")
  ) {
    throw new Error("HTTP proxy access requires project:exec");
  }
  const reference = await resolveProjectReferenceForMemberAllowRemote({
    account_id,
    project_id,
  });
  const member = reference?.users?.[account_id];
  const group = typeof member === "string" ? member : member?.group;
  if (reference?.host_id !== host_id || !isProjectCollaboratorRole(group)) {
    throw new Error("not authorized for project-host API key access");
  }
  const placement_revision = Number(reference.runtime_lifecycle_revision);
  assertApiKeyMembershipGrant(
    state.issuance_sequence,
    reference.api_key_membership_revocation,
  );
  if (!Number.isSafeInteger(placement_revision) || placement_revision < 0) {
    throw new Error("project-host placement revision is unavailable");
  }
  if (
    !grant.capabilities.some((capability) =>
      ["project:exec", "file:read", "file:write"].includes(capability),
    )
  ) {
    throw new Error("API key has no supported project-host data capability");
  }
  const viewerPolicy = viewerPolicyForApiKeyGrant(state.scope, project_id);
  const viewer_policy_hash = viewerPolicy
    ? createHash("sha256").update(JSON.stringify(viewerPolicy)).digest("hex")
    : undefined;
  await syncProjectUsersOnHostForBrowserAccess({
    account_id,
    project_id,
    expected_host_id: host_id,
  });
  const options = {
    account_id,
    host_id,
    project_id,
    key_id,
    scope_revision,
    placement_revision,
    capabilities: grant.capabilities,
    viewer_policy_hash,
    parent_exp_s:
      state.expire_ms == null ? undefined : Math.floor(state.expire_ms / 1000),
    private_key: getProjectHostAuthTokenPrivateKey(),
  };
  const { token, expires_at } =
    http_proxy_port === undefined
      ? issueProjectHostApiKeyAuthToken(options)
      : issueProjectHostApiKeyHttpToken({ ...options, port: http_proxy_port });
  return { host_id, token, expires_at };
}

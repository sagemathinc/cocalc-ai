/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import { isValidUUID } from "@cocalc/util/misc";
import {
  ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY,
  ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY,
  ANTHROPIC_API_PROVIDER,
  CLAUDE_SUBSCRIPTION_KIND,
  CLAUDE_SUBSCRIPTION_PROFILE_ID,
} from "@cocalc/util/ai/external-credential-profiles";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";
import {
  changedClaudeSubscriptionFiles,
  claudeSubscriptionBundleFiles,
  packClaudeSubscriptionBundle,
  packClaudeSubscriptionHome,
} from "./claude-subscription-home";

function caller() {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id)
    throw Error(
      "Claude account credentials are unavailable while the host is disconnected",
    );
  return { client, host_id };
}

function selector(accountId: string) {
  if (!isValidUUID(accountId)) throw Error("Invalid Claude credential owner");
  return {
    provider: ANTHROPIC_API_PROVIDER,
    kind: CLAUDE_SUBSCRIPTION_KIND,
    scope: "account" as const,
    owner_account_id: accountId,
  };
}

export async function getClaudeSubscriptionCredential(options: {
  projectId: string;
  accountId: string;
  credentialId: string;
}): Promise<{ payload: string; identity: string; plan: string }> {
  const { projectId, accountId, credentialId } = options;
  if (!isValidUUID(projectId) || !isValidUUID(credentialId))
    throw Error("Invalid Claude credential binding");
  const credential = await callHub({
    ...caller(),
    name: "hosts.getExternalCredential",
    args: [
      {
        project_id: projectId,
        selector: selector(accountId),
        credential_id: credentialId,
      },
    ],
    timeout: 15_000,
  });
  if (
    credential?.id !== credentialId ||
    credential.metadata?.[ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY] !==
      CLAUDE_SUBSCRIPTION_PROFILE_ID ||
    typeof credential.metadata?.[ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY] !==
      "string" ||
    typeof credential.metadata?.plan !== "string" ||
    typeof credential.payload !== "string"
  )
    throw Error("Claude subscription credential is unavailable or revoked");
  return {
    payload: credential.payload,
    identity: credential.metadata[ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY],
    plan: credential.metadata.plan,
  };
}

export async function publishClaudeSubscriptionCredential(options: {
  projectId: string;
  accountId: string;
  home: string;
  identity: string;
  plan: string;
  credentialId?: string;
  allowedPaths?: ReadonlySet<string>;
}): Promise<string> {
  const {
    projectId,
    accountId,
    home,
    identity,
    plan,
    credentialId,
    allowedPaths,
  } = options;
  if (!isValidUUID(projectId) || (credentialId && !isValidUUID(credentialId)))
    throw Error("Invalid Claude credential binding");
  if (!/^(?:claude\s+)?(?:pro|max)(?:\s|$)/i.test(plan))
    throw Error("Invalid Claude subscription plan");
  if (credentialId) {
    const current = await getClaudeSubscriptionCredential({
      projectId,
      accountId,
      credentialId,
    });
    if (current.identity !== identity)
      throw Error("Reconnect must use the same Claude account");
  }
  const payload = await packClaudeSubscriptionHome(home, allowedPaths);
  return await upsertClaudeSubscriptionPayload({
    projectId,
    accountId,
    payload,
    identity,
    plan,
    credentialId,
  });
}

async function upsertClaudeSubscriptionPayload(options: {
  projectId: string;
  accountId: string;
  payload: string;
  identity: string;
  plan: string;
  credentialId?: string;
}): Promise<string> {
  const { projectId, accountId, payload, identity, plan, credentialId } =
    options;
  const result = await callHub({
    ...caller(),
    name: "hosts.upsertExternalCredential",
    args: [
      {
        project_id: projectId,
        selector: selector(accountId),
        payload,
        metadata: {
          [ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY]:
            CLAUDE_SUBSCRIPTION_PROFILE_ID,
          [ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY]: identity,
          authentication: "claude-subscription",
          billing: "claude-plan",
          plan,
          verified_at: new Date().toISOString(),
        },
        credential_id: credentialId,
        create: !credentialId,
        max_active: credentialId ? undefined : 3,
        deduplicate_metadata: credentialId
          ? undefined
          : {
              key: ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY,
              value: identity,
            },
      },
    ],
    timeout: 15_000,
  });
  if (!result?.id || !isValidUUID(result.id))
    throw Error("Claude subscription credential was not published");
  return result.id;
}

/**
 * Save what a running controller changed in its Claude home, without
 * clobbering what other controllers saved meanwhile.
 *
 * Claude Code rotates the subscription refresh token when it refreshes, so
 * every controller restored from the stored bundle holds a copy that goes
 * stale as soon as any other controller refreshes. Writing a whole home back
 * would let a controller that never refreshed restore an already revoked
 * token. Instead, only files that changed since `baseline` (this controller's
 * last sync) replace the corresponding files of the currently stored bundle.
 *
 * Returns the new baseline: the controller's current files.
 */
export async function syncClaudeSubscriptionCredential(options: {
  projectId: string;
  accountId: string;
  credentialId: string;
  home: string;
  baseline: ReadonlyMap<string, Buffer>;
}): Promise<ReadonlyMap<string, Buffer>> {
  const { projectId, accountId, credentialId, home, baseline } = options;
  const current = claudeSubscriptionBundleFiles(
    await packClaudeSubscriptionHome(home, new Set(baseline.keys())),
  );
  const changed = changedClaudeSubscriptionFiles(baseline, current);
  if (changed.size === 0) return baseline;
  const stored = await getClaudeSubscriptionCredential({
    projectId,
    accountId,
    credentialId,
  });
  const merged = claudeSubscriptionBundleFiles(stored.payload);
  for (const [path, bytes] of changed) merged.set(path, bytes);
  await upsertClaudeSubscriptionPayload({
    projectId,
    accountId,
    credentialId,
    payload: packClaudeSubscriptionBundle(merged),
    identity: stored.identity,
    plan: stored.plan,
  });
  return current;
}

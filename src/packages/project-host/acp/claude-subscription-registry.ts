/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import callHub from "@cocalc/conat/hub/call-hub";
import getLogger from "@cocalc/backend/logger";
import { isExternalCredentialConflict } from "@cocalc/util/external-credential-conflict";
import { isValidUUID } from "@cocalc/util/misc";
import {
  ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY,
  ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY,
  ANTHROPIC_API_PROVIDER,
  CLAUDE_OAUTH_TOKEN_AUTHENTICATION,
  CLAUDE_SUBSCRIPTION_KIND,
  CLAUDE_SUBSCRIPTION_PROFILE_ID,
} from "@cocalc/util/ai/external-credential-profiles";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";
import {
  changedClaudeSubscriptionFiles,
  claudeSubscriptionBundleFiles,
  packClaudeSubscriptionBundle,
} from "./claude-subscription-home";
import { packClaudeSubscriptionToken } from "./claude-subscription-token";

const logger = getLogger("project-host:acp:claude-subscription-registry");
// Compare-and-swap conflicts are retried against the newly stored bundle.
const SYNC_ATTEMPTS = 3;

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
}): Promise<{ payload: string; identity?: string; plan?: string }> {
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
    typeof credential.payload !== "string"
  )
    throw Error("Claude subscription credential is unavailable or revoked");
  // A long-lived token cannot read its account's email or plan.
  const identity =
    credential.metadata[ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY];
  const plan = credential.metadata.plan;
  return {
    payload: credential.payload,
    ...(typeof identity === "string" ? { identity } : {}),
    ...(typeof plan === "string" ? { plan } : {}),
  };
}

/**
 * Store a long-lived inference token. Reconnecting replaces the credential's
 * payload in place, converting a home snapshot to a token. The token cannot
 * reveal its Claude account, so reconnect cannot check that it is the same.
 */
export async function publishClaudeSubscriptionToken(options: {
  projectId: string;
  accountId: string;
  token: string;
  expiresAt?: string;
  credentialId?: string;
}): Promise<string> {
  const { projectId, accountId, token, expiresAt, credentialId } = options;
  if (!isValidUUID(projectId) || (credentialId && !isValidUUID(credentialId)))
    throw Error("Invalid Claude credential binding");
  if (credentialId)
    await getClaudeSubscriptionCredential({
      projectId,
      accountId,
      credentialId,
    });
  const result = await callHub({
    ...caller(),
    name: "hosts.upsertExternalCredential",
    args: [
      {
        project_id: projectId,
        selector: selector(accountId),
        payload: packClaudeSubscriptionToken(token),
        metadata: {
          [ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY]:
            CLAUDE_SUBSCRIPTION_PROFILE_ID,
          // Updates merge metadata: clear a replaced snapshot's identity.
          [ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY]: null,
          plan: null,
          authentication: CLAUDE_OAUTH_TOKEN_AUTHENTICATION,
          billing: "claude-plan",
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          verified_at: new Date().toISOString(),
        },
        credential_id: credentialId,
        create: !credentialId,
        max_active: credentialId ? undefined : 3,
      },
    ],
    timeout: 15_000,
  });
  if (!result?.id || !isValidUUID(result.id))
    throw Error("Claude subscription credential was not published");
  return result.id;
}

async function upsertClaudeSubscriptionPayload(options: {
  projectId: string;
  accountId: string;
  payload: string;
  identity: string;
  plan: string;
  credentialId?: string;
  expectedPayloadSha256?: string;
}): Promise<string> {
  const {
    projectId,
    accountId,
    payload,
    identity,
    plan,
    credentialId,
    expectedPayloadSha256,
  } = options;
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
        expected_payload_sha256: expectedPayloadSha256,
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
 * Save what a controller changed in its Claude home without clobbering what
 * other controllers saved meanwhile.
 *
 * Claude Code rotates the subscription refresh token when it refreshes, so a
 * controller's copy goes stale as soon as any other controller refreshes. For
 * each file changed since `baseline` (this controller's last sync), compare
 * with the currently stored file (a three-way merge on opaque bytes):
 *
 * - stored equals the local change: already saved (e.g. an earlier write
 *   whose acknowledgement was lost), nothing to do;
 * - stored still equals the baseline: apply the local change;
 * - stored differs from both: another controller saved newer bytes; keep them.
 *
 * The merged bundle is written only if the stored bundle is unchanged since it
 * was read (compare-and-swap); on conflict the merge is redone.
 *
 * Returns the new baseline: the controller's current files.
 */
export async function syncClaudeSubscriptionCredential(options: {
  projectId: string;
  accountId: string;
  credentialId: string;
  baseline: ReadonlyMap<string, Buffer>;
  current: ReadonlyMap<string, Buffer>;
}): Promise<ReadonlyMap<string, Buffer>> {
  const { projectId, accountId, credentialId, baseline, current } = options;
  const changed = changedClaudeSubscriptionFiles(baseline, current);
  if (changed.size === 0) return current;
  for (let attempt = 1; ; attempt++) {
    const stored = await getClaudeSubscriptionCredential({
      projectId,
      accountId,
      credentialId,
    });
    const storedFiles = claudeSubscriptionBundleFiles(stored.payload);
    const merged = new Map(storedFiles);
    let writes = 0;
    const kept: string[] = [];
    for (const [path, local] of changed) {
      const storedFile = storedFiles.get(path);
      const before = baseline.get(path);
      if (storedFile?.equals(local)) continue;
      if (
        storedFile == null
          ? before == null
          : before != null && storedFile.equals(before)
      ) {
        merged.set(path, local);
        writes++;
      } else {
        kept.push(path);
      }
    }
    if (kept.length > 0)
      logger.debug("kept newer stored Claude credential files", {
        credentialId,
        files: kept.length,
      });
    if (writes === 0) return current;
    try {
      await upsertClaudeSubscriptionPayload({
        projectId,
        accountId,
        credentialId,
        payload: packClaudeSubscriptionBundle(merged),
        identity: stored.identity!,
        plan: stored.plan!,
        expectedPayloadSha256: createHash("sha256")
          .update(stored.payload, "utf8")
          .digest("hex"),
      });
      return current;
    } catch (error) {
      if (!isExternalCredentialConflict(error) || attempt >= SYNC_ATTEMPTS)
        throw error;
    }
  }
}

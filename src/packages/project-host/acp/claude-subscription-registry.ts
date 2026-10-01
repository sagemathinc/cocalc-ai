/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import callHub from "@cocalc/conat/hub/call-hub";
import getLogger from "@cocalc/backend/logger";
import { isExternalCredentialConflict } from "@cocalc/util/external-credential-conflict";
import { isValidUUID } from "@cocalc/util/misc";
import type { ClaudeControllerOwnershipResult } from "@cocalc/util/ai/claude-controller-ownership";
import {
  ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY,
  ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY,
  ANTHROPIC_API_PROVIDER,
  CLAUDE_SUBSCRIPTION_KIND,
  CLAUDE_SUBSCRIPTION_PROFILE_ID,
} from "@cocalc/util/ai/external-credential-profiles";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";
import { harnessOwner } from "./harness-reaper";
import {
  changedClaudeSubscriptionFiles,
  claudeSubscriptionBundleFiles,
  packClaudeSubscriptionBundle,
  packClaudeSubscriptionHome,
} from "./claude-subscription-home";

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

export async function manageClaudeControllerOwnership(options: {
  projectId: string;
  accountId: string;
  credentialId?: string;
  holder: string;
  operation: "acquire" | "release";
  runtimeId?: string;
  purpose?: "controller" | "sign-in";
}): Promise<ClaudeControllerOwnershipResult> {
  return await callHub({
    ...caller(),
    name: "hosts.manageClaudeControllerOwnership",
    args: [
      {
        project_id: options.projectId,
        owner_account_id: options.accountId,
        credential_id: options.credentialId,
        holder: options.holder,
        operation: options.operation,
        runtime_id: options.runtimeId ?? (await harnessOwner()),
        purpose: options.purpose ?? "controller",
      },
    ],
    timeout: 15_000,
  });
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

/** An omitted sign-in target reconnects the existing account subscription. */
export async function getExistingClaudeSubscriptionCredentialId(options: {
  projectId: string;
  accountId: string;
}): Promise<string | undefined> {
  const current = await callHub({
    ...caller(),
    name: "hosts.getExternalCredential",
    args: [
      { project_id: options.projectId, selector: selector(options.accountId) },
    ],
    timeout: 15_000,
  });
  if (!current) return undefined;
  if (
    !isValidUUID(current.id) ||
    current.metadata?.[ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY] !==
      CLAUDE_SUBSCRIPTION_PROFILE_ID
  )
    throw Error("Claude subscription credential is unavailable");
  return current.id;
}

export async function publishClaudeSubscriptionCredential(options: {
  projectId: string;
  accountId: string;
  home: string;
  identity: string;
  plan: string;
  credentialId?: string;
  allowedPaths?: ReadonlySet<string>;
  controllerHolder?: string;
  runtimeId?: string;
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
    controllerHolder: options.controllerHolder,
    runtimeId: options.runtimeId,
  });
}

async function upsertClaudeSubscriptionPayload(options: {
  projectId: string;
  accountId: string;
  payload: string;
  identity: string;
  plan: string;
  credentialId?: string;
  expectedPayloadSha256?: string;
  controllerHolder?: string;
  runtimeId?: string;
}): Promise<string> {
  const {
    projectId,
    accountId,
    payload,
    identity,
    plan,
    credentialId,
    expectedPayloadSha256,
    controllerHolder,
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
        controller_holder: controllerHolder,
        controller_runtime_id: controllerHolder
          ? (options.runtimeId ?? (await harnessOwner()))
          : undefined,
        create: !credentialId,
        max_active: credentialId ? undefined : 1,
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
  controllerHolder?: string;
  runtimeId?: string;
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
      logger.debug("unresolved Claude credential file conflict", {
        credentialId,
        files: kept.length,
      });
    if (kept.length > 0 && options.controllerHolder)
      throw Error("CLAUDE_CREDENTIAL_REVISION_CONFLICT");
    if (writes === 0) return current;
    try {
      await upsertClaudeSubscriptionPayload({
        projectId,
        accountId,
        credentialId,
        payload: packClaudeSubscriptionBundle(merged),
        identity: stored.identity,
        plan: stored.plan,
        expectedPayloadSha256: createHash("sha256")
          .update(stored.payload, "utf8")
          .digest("hex"),
        controllerHolder: options.controllerHolder,
        runtimeId: options.runtimeId,
      });
      return current;
    } catch (error) {
      if (!isExternalCredentialConflict(error) || attempt >= SYNC_ATTEMPTS)
        throw error;
    }
  }
}

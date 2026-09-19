/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  refreshCodexSubscriptionAuth,
  type CodexSubscriptionAuthRefreshResult,
} from "./codex-subscription-refresh";
import {
  createExternalCredential,
  ensureDefaultExternalCredential,
  getExternalCredential,
  getExternalCredentialById,
  hasExternalCredential,
  listExternalCredentials,
  revokeExternalCredential,
  touchExternalCredential,
  updateExternalCredentialById,
  updateExternalCredentialLabelById,
  upsertExternalCredential,
  type ExternalCredentialRecord,
  type ExternalCredentialScope,
  type ExternalCredentialSelector,
  type ExternalCredentialSummary,
} from "./store";

const EXTERNAL_CREDENTIAL_TIMEOUT_MS = 15_000;

function normalizeScope(scope: unknown): ExternalCredentialScope {
  const value = `${scope ?? ""}`.trim().toLowerCase();
  if (
    value === "account" ||
    value === "project" ||
    value === "organization" ||
    value === "site"
  ) {
    return value;
  }
  throw new Error(`unsupported external credential scope '${value}'`);
}

async function resolveExternalCredentialBay(
  selector: ExternalCredentialSelector,
): Promise<string> {
  const scope = normalizeScope(selector.scope);
  if (scope === "account") {
    const owner_account_id = `${selector.owner_account_id ?? ""}`.trim();
    if (!owner_account_id) {
      throw new Error("owner_account_id must be specified for account scope");
    }
    const location = await resolveAccountHomeBay({
      account_id: owner_account_id,
    });
    return `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  }
  if (scope === "project") {
    const project_id = `${selector.project_id ?? ""}`.trim();
    if (!project_id) {
      throw new Error("project_id must be specified for project scope");
    }
    const ownership = await resolveProjectBay(project_id);
    if (ownership == null) {
      throw new Error(`project '${project_id}' not found`);
    }
    return `${ownership.bay_id ?? ""}`.trim() || getConfiguredBayId();
  }
  return getConfiguredClusterSeedBayId();
}

function remoteCredentialsClient(dest_bay: string) {
  return getInterBayBridge().externalCredentials(dest_bay, {
    timeout_ms: EXTERNAL_CREDENTIAL_TIMEOUT_MS,
  });
}

async function withExternalCredentialAuthority<T>({
  selector,
  local,
  remote,
}: {
  selector: ExternalCredentialSelector;
  local: () => Promise<T>;
  remote: (dest_bay: string) => Promise<T>;
}): Promise<T> {
  const dest_bay = await resolveExternalCredentialBay(selector);
  if (dest_bay === getConfiguredBayId()) {
    return await local();
  }
  return await remote(dest_bay);
}

export async function upsertExternalCredentialRouted({
  selector,
  payload,
  metadata,
}: {
  selector: ExternalCredentialSelector;
  payload: string;
  metadata?: Record<string, any>;
}): Promise<{ id: string; created: boolean }> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () =>
      await upsertExternalCredential({ selector, payload, metadata }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).upsert({
        selector,
        payload,
        metadata,
      }),
  });
}

export async function createExternalCredentialRouted({
  selector,
  payload,
  metadata,
  maxActive,
  deduplicateMetadata,
  defaultMetadataKey,
}: {
  selector: ExternalCredentialSelector;
  payload: string;
  metadata?: Record<string, any>;
  maxActive?: number;
  deduplicateMetadata?: { key: string; value: string };
  defaultMetadataKey?: string;
}): Promise<{ id: string; created: boolean }> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () =>
      await createExternalCredential({
        selector,
        payload,
        metadata,
        maxActive,
        deduplicateMetadata,
        defaultMetadataKey,
      }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).create({
        selector,
        payload,
        metadata,
        max_active: maxActive,
        deduplicate_metadata: deduplicateMetadata,
        default_metadata_key: defaultMetadataKey,
      }),
  });
}

export async function updateExternalCredentialByIdRouted({
  id,
  selector,
  payload,
  metadata,
  revive,
}: {
  id: string;
  selector: ExternalCredentialSelector;
  payload: string;
  metadata?: Record<string, any>;
  revive?: boolean;
}): Promise<boolean> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () =>
      await updateExternalCredentialById({
        id,
        selector,
        payload,
        metadata: metadata ?? {},
        revive,
      }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).updateById({
        id,
        selector,
        payload,
        metadata,
        revive,
      }),
  });
}

export async function updateExternalCredentialLabelByIdRouted({
  id,
  selector,
  label,
}: {
  id: string;
  selector: ExternalCredentialSelector;
  label?: string;
}): Promise<boolean> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () =>
      await updateExternalCredentialLabelById({ id, selector, label }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).updateLabelById({
        id,
        selector,
        label,
      }),
  });
}

export async function getExternalCredentialRouted({
  selector,
  touchLastUsed = true,
}: {
  selector: ExternalCredentialSelector;
  touchLastUsed?: boolean;
}): Promise<ExternalCredentialRecord | undefined> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () => await getExternalCredential({ selector, touchLastUsed }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).get({
        selector,
        touch_last_used: touchLastUsed,
      }),
  });
}

export async function getExternalCredentialByIdRouted({
  id,
  selector,
  touchLastUsed = true,
}: {
  id: string;
  selector: ExternalCredentialSelector;
  touchLastUsed?: boolean;
}): Promise<ExternalCredentialRecord | undefined> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () =>
      await getExternalCredentialById({ id, selector, touchLastUsed }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).getById({
        id,
        selector,
        touch_last_used: touchLastUsed,
      }),
  });
}

export async function ensureDefaultExternalCredentialRouted({
  selector,
  metadataKey,
}: {
  selector: ExternalCredentialSelector;
  metadataKey: string;
}): Promise<ExternalCredentialSummary | undefined> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () =>
      await ensureDefaultExternalCredential({ selector, metadataKey }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).ensureDefault({
        selector,
        metadata_key: metadataKey,
      }),
  });
}

export async function hasExternalCredentialRouted({
  selector,
}: {
  selector: ExternalCredentialSelector;
}): Promise<boolean> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () => await hasExternalCredential({ selector }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).has({ selector }),
  });
}

export async function touchExternalCredentialRouted({
  selector,
}: {
  selector: ExternalCredentialSelector;
}): Promise<boolean> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () => await touchExternalCredential({ selector }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).touch({ selector }),
  });
}

export async function touchExternalCredentialByIdRouted({
  id,
  selector,
}: {
  id: string;
  selector: ExternalCredentialSelector;
}): Promise<boolean> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () => await touchExternalCredential({ selector, id }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).touchById({ id, selector }),
  });
}

export async function refreshCodexSubscriptionAuthRouted({
  owner_account_id,
  credential_id,
  previous_access_token_hash,
}: {
  owner_account_id: string;
  credential_id?: string;
  previous_access_token_hash: string;
}): Promise<CodexSubscriptionAuthRefreshResult> {
  const selector: ExternalCredentialSelector = {
    provider: "openai",
    kind: "codex-subscription-auth-json",
    scope: "account",
    owner_account_id,
  };
  return await withExternalCredentialAuthority({
    selector,
    local: async () =>
      await refreshCodexSubscriptionAuth({
        ownerAccountId: owner_account_id,
        credentialId: credential_id,
        previousAccessTokenHash: previous_access_token_hash,
      }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).refreshCodexSubscription({
        owner_account_id,
        credential_id,
        previous_access_token_hash,
      }),
  });
}

export async function listAccountExternalCredentialsRouted({
  owner_account_id,
  includeRevoked = false,
  provider,
  kind,
  scope,
}: {
  owner_account_id: string;
  includeRevoked?: boolean;
  provider?: string;
  kind?: string;
  scope?: ExternalCredentialScope;
}): Promise<ExternalCredentialSummary[]> {
  const selector: ExternalCredentialSelector = {
    provider: provider ?? "routing",
    kind: kind ?? "list",
    scope: "account",
    owner_account_id,
  };
  return await withExternalCredentialAuthority({
    selector,
    local: async () =>
      await listExternalCredentials({
        owner_account_id,
        includeRevoked,
        provider,
        kind,
        scope,
      }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).list({
        owner_account_id,
        include_revoked: includeRevoked,
        provider,
        kind,
        scope,
      }),
  });
}

export async function revokeAccountExternalCredentialRouted({
  id,
  owner_account_id,
}: {
  id: string;
  owner_account_id: string;
}): Promise<boolean> {
  const selector: ExternalCredentialSelector = {
    provider: "routing",
    kind: "revoke",
    scope: "account",
    owner_account_id,
  };
  return await withExternalCredentialAuthority({
    selector,
    local: async () => await revokeExternalCredential({ id, owner_account_id }),
    remote: async (dest_bay) =>
      await remoteCredentialsClient(dest_bay).revoke({
        id,
        owner_account_id,
      }),
  });
}

export async function revokeExternalCredentialBySelectorRouted({
  selector,
}: {
  selector: ExternalCredentialSelector;
}): Promise<boolean> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () => {
      const existing = await getExternalCredential({
        selector,
        touchLastUsed: false,
      });
      if (!existing) return false;
      return await revokeExternalCredential({ id: existing.id });
    },
    remote: async (dest_bay) => {
      const client = remoteCredentialsClient(dest_bay);
      const existing = await client.get({
        selector,
        touch_last_used: false,
      });
      if (!existing) return false;
      return await client.revoke({ id: existing.id });
    },
  });
}

export async function revokeExternalCredentialByIdAndSelectorRouted({
  id,
  selector,
}: {
  id: string;
  selector: ExternalCredentialSelector;
}): Promise<boolean> {
  return await withExternalCredentialAuthority({
    selector,
    local: async () => {
      const existing = await getExternalCredentialById({
        id,
        selector,
        touchLastUsed: false,
      });
      if (!existing) return false;
      return await revokeExternalCredential({ id });
    },
    remote: async (dest_bay) => {
      const client = remoteCredentialsClient(dest_bay);
      const existing = await client.getById({
        id,
        selector,
        touch_last_used: false,
      });
      if (!existing) return false;
      return await client.revoke({ id });
    },
  });
}

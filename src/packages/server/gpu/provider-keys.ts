/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key: connecting and removing an account's own GPU provider
key (RunPod). The key is verified with the provider before it is stored, then
kept in the external-credentials broker on the account's home bay. Nothing
here ever returns the key.
*/

import {
  RunpodApiError,
  RunpodClient,
  type RunpodProviderIdentity,
} from "@cocalc/cloud/runpod/client";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import {
  listAccountExternalCredentialsRouted,
  revokeAccountExternalCredentialRouted,
  upsertExternalCredentialRouted,
} from "@cocalc/server/external-credentials/routing";
import {
  getExternalCredential,
  type ExternalCredentialSummary,
} from "@cocalc/server/external-credentials/store";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import {
  GPU_PROVIDER_API_KEY_KIND,
  type GpuProvider,
  type GpuProviderAccount,
  type GpuProviderKeyStatus,
  isGpuProvider,
} from "@cocalc/util/gpu/provider-keys";

type Fetch = typeof globalThis.fetch;

export interface GpuProviderKeyDeps {
  // for tests
  fetch?: Fetch;
  isEntitled?: (account_id: string) => Promise<boolean>;
  isHomeBay?: (account_id: string) => Promise<boolean>;
}

function selector(account_id: string, provider: GpuProvider) {
  return {
    provider,
    kind: GPU_PROVIDER_API_KEY_KIND,
    scope: "account" as const,
    owner_account_id: account_id,
  };
}

function requireProvider(provider: unknown): GpuProvider {
  if (!isGpuProvider(provider)) {
    throw Error("unknown GPU provider");
  }
  return provider;
}

export async function isGpuProviderKeysEntitled(
  account_id: string,
): Promise<boolean> {
  const membership = await resolveMembershipForAccount(account_id);
  return membership?.entitlements?.features?.gpu_provider_keys === true;
}

function normalizeRunpodKey(value: unknown): string {
  const key = `${value ?? ""}`.trim();
  if (key.length < 20 || key.length > 512 || /\s|[\x00-\x1f\x7f]/.test(key)) {
    throw Error("Enter a valid RunPod API key.");
  }
  return key;
}

// Errors name what to fix, never provider text (which could echo the key).
function verificationError(err: unknown): Error {
  if (err instanceof RunpodApiError) {
    switch (err.kind) {
      case "auth":
        return Error("RunPod rejected this API key. Check that it is correct.");
      case "forbidden":
        return Error(
          "This RunPod API key can't read the account and its pods. Create a key with read and write access to pods.",
        );
      case "rate_limited":
        return Error("RunPod is rate-limiting requests. Try again shortly.");
      case "network":
      case "provider":
        return Error(
          "RunPod could not be reached to check this key. Try again shortly.",
        );
    }
  }
  return Error("RunPod could not verify this API key.");
}

// The key must act for a provider account and be able to see that account's
// pods: launches, cleanup and attribution all depend on that.
async function verifyRunpodKey(
  apiKey: string,
  fetch?: Fetch,
): Promise<RunpodProviderIdentity> {
  const client = new RunpodClient({ apiKey, fetch, timeoutMs: 15_000 });
  try {
    const identity = await client.getProviderIdentity();
    await client.listPods();
    return identity;
  } catch (err) {
    throw verificationError(err);
  }
}

function providerAccount(
  record: ExternalCredentialSummary,
): GpuProviderAccount | undefined {
  const m = record.metadata ?? {};
  if (
    (m.provider_account_kind !== "personal" &&
      m.provider_account_kind !== "organization") ||
    typeof m.provider_account_id !== "string"
  ) {
    return undefined;
  }
  return {
    kind: m.provider_account_kind,
    id: m.provider_account_id,
    ...(typeof m.provider_account_name === "string"
      ? { name: m.provider_account_name }
      : {}),
  };
}

function toStatus(
  provider: GpuProvider,
  entitled: boolean,
  record: ExternalCredentialSummary | undefined,
): GpuProviderKeyStatus {
  if (!record || record.revoked) {
    return { provider, entitled, connected: false };
  }
  return {
    provider,
    entitled,
    connected: true,
    provider_account: providerAccount(record),
    connected_at: new Date(record.updated).toISOString(),
  };
}

// Summaries only: the key itself never leaves the owner's home bay.
async function activeKeySummary(
  account_id: string,
  provider: GpuProvider,
): Promise<ExternalCredentialSummary | undefined> {
  const rows = await listAccountExternalCredentialsRouted({
    owner_account_id: account_id,
    provider,
    kind: GPU_PROVIDER_API_KEY_KIND,
    scope: "account",
  });
  return rows.find((row) => !row.revoked);
}

export async function getGpuProviderKeyStatus(
  {
    account_id,
    provider: providerInput,
  }: { account_id: string; provider: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<GpuProviderKeyStatus> {
  const provider = requireProvider(providerInput);
  const [entitled, record] = await Promise.all([
    (deps.isEntitled ?? isGpuProviderKeysEntitled)(account_id),
    activeKeySummary(account_id, provider),
  ]);
  return toStatus(provider, entitled, record);
}

// The caller has already required fresh auth for this session.
export async function setGpuProviderKey(
  {
    account_id,
    provider: providerInput,
    api_key,
  }: { account_id: string; provider: unknown; api_key: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<GpuProviderKeyStatus> {
  const provider = requireProvider(providerInput);
  if (!(await (deps.isEntitled ?? isGpuProviderKeysEntitled)(account_id))) {
    throw Error(
      "Your membership doesn't include connecting a GPU provider key.",
    );
  }
  const key = normalizeRunpodKey(api_key);
  const identity = await verifyRunpodKey(key, deps.fetch);
  await upsertExternalCredentialRouted({
    selector: selector(account_id, provider),
    payload: key,
    metadata: {
      source: "account-settings",
      provider_account_kind: identity.kind,
      provider_account_id: identity.id,
      ...(identity.kind === "organization" && identity.name
        ? { provider_account_name: identity.name.slice(0, 120) }
        : {}),
      verified_at: new Date().toISOString(),
    },
  });
  return await getGpuProviderKeyStatus({ account_id, provider }, deps);
}

// The caller has already required fresh auth for this session.
export async function deleteGpuProviderKey({
  account_id,
  provider: providerInput,
}: {
  account_id: string;
  provider: unknown;
}): Promise<{ revoked: boolean }> {
  const provider = requireProvider(providerInput);
  const existing = await activeKeySummary(account_id, provider);
  if (!existing) return { revoked: false };
  const revoked = await revokeAccountExternalCredentialRouted({
    id: existing.id,
    owner_account_id: account_id,
  });
  return { revoked };
}

async function isAccountHomeBay(account_id: string): Promise<boolean> {
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  return (
    (`${home_bay_id ?? ""}`.trim() || getConfiguredBayId()) ===
    getConfiguredBayId()
  );
}

// A RunPod client acting with the account's own key, for the server code
// that launches, inspects or cleans up GPUs on its behalf.
//
// Custody: this runs only on the key owner's home bay, and reads the key
// from the local store; anywhere else it throws. A GPU operation for an
// account on another bay must be routed to that bay as a whole; the key
// never crosses the inter-bay bridge.
//
// Purpose: "operate" (launch, start, inspect) also requires the owner's
// live gpu_provider_keys entitlement. "cleanup" (inventory, terminate,
// delete storage) doesn't, so a lapsed membership can still be cleaned up.
//
// Never log or return the client's key; RunpodClient hides it from inspect
// and JSON.
export async function getRunpodClientForAccount(
  account_id: string,
  { purpose }: { purpose: "operate" | "cleanup" },
  deps: GpuProviderKeyDeps = {},
): Promise<RunpodClient | undefined> {
  if (!(await (deps.isHomeBay ?? isAccountHomeBay)(account_id))) {
    throw Error("GPU provider keys are used only on the key owner's home bay");
  }
  if (
    purpose === "operate" &&
    !(await (deps.isEntitled ?? isGpuProviderKeysEntitled)(account_id))
  ) {
    throw Error("Your membership doesn't include using a GPU provider key.");
  }
  const record = await getExternalCredential({
    selector: selector(account_id, "runpod"),
  });
  if (!record || record.revoked || !record.payload) return undefined;
  return new RunpodClient({ apiKey: record.payload, fetch: deps.fetch });
}

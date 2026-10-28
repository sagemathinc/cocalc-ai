/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key: connecting and removing an account's own GPU provider
key (RunPod). The key is verified with the provider before it is stored, then
kept in the external-credentials broker on the account's home bay. Nothing
here ever returns the key.

Each operation runs whole on the account's home bay: the bay the user is
signed in to forwards it there (after its own fresh-auth check), so the
entitlement, the check with RunPod and the store all happen where the key
lives, in one inter-bay call.
*/

import {
  RunpodApiError,
  RunpodClient,
  type RunpodProviderIdentity,
} from "@cocalc/cloud/runpod/client";
import {
  createInterBayAccountLocalClient,
  type InterBayGpuApi,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import {
  getExternalCredential,
  listExternalCredentials,
  revokeExternalCredential,
  upsertExternalCredential,
  type ExternalCredentialSummary,
} from "@cocalc/server/external-credentials/store";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import {
  GPU_PROVIDER_API_KEY_KIND,
  type GpuProvider,
  type GpuProviderAccount,
  type GpuProviderKeyStatus,
  isGpuProvider,
  KEY_HOME_BAY_TIMEOUT_MS,
  SET_KEY_HOME_BAY_TIMEOUT_MS,
} from "@cocalc/util/gpu/provider-keys";

type Fetch = typeof globalThis.fetch;

// Verification is at most seven requests (organization, maybe GraphQL
// `myself`, one page of pods, then a template created and deleted to prove
// write access; an unclear create adds a lookup by name, and a delete may be
// retried once) of at most 4 s each. Cleanup after a failed probe can run
// past 25 s, but verification must succeed within
// VERIFY_DEADLINE_MS or nothing is stored. The store after that has no
// deadline of its own (it may wait on the database and the selector lock);
// a save forwarded from another bay may take SET_KEY_HOME_BAY_TIMEOUT_MS
// (75 s) and the browser's VERIFY_RPC_TIMEOUT_MS (90 s) exceeds that (both in
// util/gpu/provider-keys); a store that is later still shows up at the next
// status load.
const VERIFY_REQUEST_TIMEOUT_MS = 4_000;
const VERIFY_DEADLINE_MS = 25_000;

export interface GpuProviderKeyDeps {
  // for tests
  fetch?: Fetch;
  isEntitled?: (account_id: string) => Promise<boolean>;
  isHomeBay?: (account_id: string) => Promise<boolean>;
  verifyDeadlineMs?: number;
  // the home bay's API, or undefined when this is the home bay
  homeClient?: (
    account_id: string,
    timeout: number,
  ) => Promise<InterBayGpuApi | undefined>;
}

async function gpuKeyHomeClient(
  account_id: string,
  timeout: number,
): Promise<InterBayGpuApi | undefined> {
  const dest_bay = await accountHomeBay(account_id);
  if (dest_bay === getConfiguredBayId()) return undefined;
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
    timeout,
  });
}

async function homeClientFor(
  account_id: string,
  timeout: number,
  deps: GpuProviderKeyDeps,
): Promise<InterBayGpuApi | undefined> {
  return await (deps.homeClient ?? gpuKeyHomeClient)(account_id, timeout);
}

// The *Local functions below are what the home bay runs, never forwarding
// again; anywhere else they refuse.
async function requireHomeBay(account_id: string, deps: GpuProviderKeyDeps) {
  if (!(await (deps.isHomeBay ?? isAccountHomeBay)(account_id))) {
    throw Error("GPU provider keys are used only on the key owner's home bay");
  }
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
          'This RunPod API key can\'t manage pods. Create a key with "All" permissions.',
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

// The key must act for a provider account, see that account's pods, and be
// allowed to change them: launches, cleanup and attribution depend on that.
async function verifyRunpodKey(
  apiKey: string,
  fetch?: Fetch,
): Promise<RunpodProviderIdentity> {
  const client = new RunpodClient({
    apiKey,
    fetch,
    timeoutMs: VERIFY_REQUEST_TIMEOUT_MS,
  });
  try {
    const identity = await client.getProviderIdentity();
    await client.canListPods();
    await client.canWritePods();
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

// Summaries only, from the local store.
async function activeKeySummaries(
  account_id: string,
  provider: GpuProvider,
): Promise<ExternalCredentialSummary[]> {
  const rows = await listExternalCredentials({
    owner_account_id: account_id,
    provider,
    kind: GPU_PROVIDER_API_KEY_KIND,
    scope: "account",
  });
  return rows.filter((row) => !row.revoked);
}

export async function getGpuProviderKeyStatus(
  { account_id, provider }: { account_id: string; provider: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<GpuProviderKeyStatus> {
  requireProvider(provider);
  const home = await homeClientFor(account_id, KEY_HOME_BAY_TIMEOUT_MS, deps);
  if (home) return await home.gpuKeyStatus({ account_id, provider });
  return await getGpuProviderKeyStatusLocal({ account_id, provider }, deps);
}

export async function getGpuProviderKeyStatusLocal(
  {
    account_id,
    provider: providerInput,
  }: { account_id: string; provider: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<GpuProviderKeyStatus> {
  const provider = requireProvider(providerInput);
  await requireHomeBay(account_id, deps);
  const [entitled, record] = await Promise.all([
    (deps.isEntitled ?? isGpuProviderKeysEntitled)(account_id),
    activeKeySummaries(account_id, provider),
  ]);
  return toStatus(provider, entitled, record[0]);
}

// The caller has already required fresh auth for this session.
export async function setGpuProviderKey(
  {
    account_id,
    provider,
    api_key,
  }: { account_id: string; provider: unknown; api_key: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<GpuProviderKeyStatus> {
  requireProvider(provider);
  const home = await homeClientFor(
    account_id,
    SET_KEY_HOME_BAY_TIMEOUT_MS,
    deps,
  );
  if (home) return await home.gpuKeySet({ account_id, provider, api_key });
  return await setGpuProviderKeyLocal({ account_id, provider, api_key }, deps);
}

export async function setGpuProviderKeyLocal(
  {
    account_id,
    provider: providerInput,
    api_key,
  }: { account_id: string; provider: unknown; api_key: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<GpuProviderKeyStatus> {
  const provider = requireProvider(providerInput);
  await requireHomeBay(account_id, deps);
  if (!(await (deps.isEntitled ?? isGpuProviderKeysEntitled)(account_id))) {
    throw Error(
      "Your membership doesn't include connecting a GPU provider key.",
    );
  }
  const key = normalizeRunpodKey(api_key);
  const started = Date.now();
  const identity = await verifyRunpodKey(key, deps.fetch);
  if (Date.now() - started > (deps.verifyDeadlineMs ?? VERIFY_DEADLINE_MS)) {
    // The browser may have given up; storing now would surprise it.
    throw Error("RunPod took too long to check this key. Try again shortly.");
  }
  // A removal (say, in another tab) while this key was being checked
  // normally wins: saving would reconnect an account the user just
  // disconnected. This is a check, not a lock: a removal landing in the few
  // milliseconds between it and the store below can still lose, which only
  // stores the key this same user just pasted (accepted as low impact). It
  // counts only removals after this save started, so a removal just before
  // it never blocks it; clock skew with the database is milliseconds.
  const removedSince = (
    await listExternalCredentials({
      owner_account_id: account_id,
      provider,
      kind: GPU_PROVIDER_API_KEY_KIND,
      scope: "account",
      includeRevoked: true,
    })
  ).some((row) => row.revoked && new Date(row.revoked).getTime() > started);
  if (removedSince) {
    throw Error(
      "Your RunPod key was removed while this one was being checked, so it wasn't saved. Paste it again to connect it.",
    );
  }
  const verified_at = new Date().toISOString();
  const provider_account_name =
    identity.kind === "organization" && identity.name
      ? identity.name.slice(0, 120)
      : undefined;
  await upsertExternalCredential({
    selector: selector(account_id, provider),
    payload: key,
    metadata: {
      source: "account-settings",
      provider_account_kind: identity.kind,
      provider_account_id: identity.id,
      ...(provider_account_name ? { provider_account_name } : {}),
      verified_at,
    },
  });
  // Built from what was just verified and stored, with no further read.
  return {
    provider,
    entitled: true,
    connected: true,
    provider_account: {
      kind: identity.kind,
      id: identity.id,
      ...(provider_account_name ? { name: provider_account_name } : {}),
    },
    connected_at: verified_at,
  };
}

// The caller has already required fresh auth for this session.
export async function deleteGpuProviderKey(
  { account_id, provider }: { account_id: string; provider: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<{ revoked: boolean }> {
  requireProvider(provider);
  const home = await homeClientFor(account_id, KEY_HOME_BAY_TIMEOUT_MS, deps);
  if (home) return await home.gpuKeyDelete({ account_id, provider });
  return await deleteGpuProviderKeyLocal({ account_id, provider }, deps);
}

export async function deleteGpuProviderKeyLocal(
  {
    account_id,
    provider: providerInput,
  }: { account_id: string; provider: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<{ revoked: boolean }> {
  const provider = requireProvider(providerInput);
  await requireHomeBay(account_id, deps);
  // The store keeps one active key per selector (upsert holds the selector
  // lock), so there is at most one to revoke.
  const [existing] = await activeKeySummaries(account_id, provider);
  if (!existing) return { revoked: false };
  const revoked = await revokeExternalCredential({
    id: existing.id,
    owner_account_id: account_id,
  });
  return { revoked };
}

async function accountHomeBay(account_id: string): Promise<string> {
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  return `${home_bay_id ?? ""}`.trim() || getConfiguredBayId();
}

async function isAccountHomeBay(account_id: string): Promise<boolean> {
  return (await accountHomeBay(account_id)) === getConfiguredBayId();
}

async function readLocalKey(
  account_id: string,
  deps: GpuProviderKeyDeps,
): Promise<string | undefined> {
  await requireHomeBay(account_id, deps);
  const record = await getExternalCredential({
    selector: selector(account_id, "runpod"),
  });
  if (!record || record.revoked || !record.payload) return undefined;
  return record.payload;
}

// Custody (both functions below): they run only on the key owner's home bay
// and read the key from the local store; anywhere else they throw. A GPU
// operation for an account on another bay is routed to that bay as a whole,
// so the key never crosses the inter-bay bridge. Never log or return a key;
// RunpodClient hides it from inspect and JSON.

// Full RunPod access with the account's own key, for launching, starting
// and inspecting GPUs. Requires the owner's live gpu_provider_keys
// entitlement.
export async function getRunpodClientForAccount(
  account_id: string,
  deps: GpuProviderKeyDeps = {},
): Promise<RunpodClient | undefined> {
  if (!(await (deps.isEntitled ?? isGpuProviderKeysEntitled)(account_id))) {
    throw Error("Your membership doesn't include using a GPU provider key.");
  }
  const apiKey = await readLocalKey(account_id, deps);
  return apiKey ? new RunpodClient({ apiKey, fetch: deps.fetch }) : undefined;
}

// What cleanup may do with an account's key: find the pods and storage it
// manages, check billing, and (from step 3) terminate them. Nothing here can
// create or start anything, so it needs no entitlement: a lapsed membership
// or a removed key can still be cleaned up. The client itself stays private
// to these closures.
export interface RunpodCleanupCapability {
  getProviderIdentity(): Promise<RunpodProviderIdentity>;
  listPods(): ReturnType<RunpodClient["listPods"]>;
  getPod(podId: string): ReturnType<RunpodClient["getPod"]>;
  listPodBilling(
    ...args: Parameters<RunpodClient["listPodBilling"]>
  ): ReturnType<RunpodClient["listPodBilling"]>;
}

export async function getRunpodCleanupForAccount(
  account_id: string,
  deps: GpuProviderKeyDeps = {},
): Promise<RunpodCleanupCapability | undefined> {
  const apiKey = await readLocalKey(account_id, deps);
  if (!apiKey) return undefined;
  const client = new RunpodClient({ apiKey, fetch: deps.fetch });
  return Object.freeze({
    getProviderIdentity: () => client.getProviderIdentity(),
    listPods: () => client.listPods(),
    getPod: (podId: string) => client.getPod(podId),
    listPodBilling: (...args: Parameters<RunpodClient["listPodBilling"]>) =>
      client.listPodBilling(...args),
  });
}

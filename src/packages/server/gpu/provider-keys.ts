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
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { lockGpuAccountFence } from "@cocalc/server/gpu/account-fence";
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
import { clearHostkeysForCredential } from "@cocalc/server/gpu/hostkey-clear";
import {
  recordKeyEvent,
  type GpuKeyEventActor,
} from "@cocalc/server/gpu/key-events";
import { onKeyGone, raiseAlert } from "@cocalc/server/gpu/alerts";
import { lockProviderIdentity } from "@cocalc/server/gpu/account-watch-db";
import {
  carryKeyBudget,
  ensureKeyBudget,
  INVENTORY_STALE_MS,
} from "@cocalc/server/gpu/budgets";
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
  // pods launched with this account's key that aren't finished
  unfinishedPods?: (account_id: string) => Promise<number>;
  // does RunPod reject the stored key (deleted or revoked at RunPod)?
  storedKeyRejected?: (
    account_id: string,
    deps: GpuProviderKeyDeps,
  ) => Promise<boolean>;
  // the account fence shared with launches (default: a transaction holding
  // the account rehome fence)
  keyFence?: <T>(
    account_id: string,
    fn: (db: PoolClient) => Promise<T>,
  ) => Promise<T>;
  verifyDeadlineMs?: number;
  // the home bay's API, or undefined when this is the home bay
  homeClient?: (
    account_id: string,
    timeout: number,
  ) => Promise<InterBayGpuApi | undefined>;
  clearHostkeys?: typeof clearHostkeysForCredential;
  // removal (for tests): the key's unfinished managed pods, a drain pass,
  // marking what is left unmanaged, and the drain's timing
  credentialPods?: (
    credential_id: string,
  ) => Promise<{ id: string; handle: string }[]>;
  // the per-request timeout of the RunPod client a cleanup capability uses
  runpodTimeoutMs?: number;
  drain?: (account_id: string, guard: () => Promise<void>) => Promise<unknown>;
  markUnmanaged?: (credential_id: string) => Promise<string[]>;
  drainMs?: number;
  drainPollMs?: number;
  // the bounded inventory pass a connect runs for its new key (for tests);
  // true if it completed
  connectInventory?: (k: {
    account_id: string;
    credential_id: string;
    deadline: number;
  }) => Promise<boolean>;
}

// A connect checks the new key's RunPod account once, inside the request
// (STEP5D): launches need a complete inventory, and this one usually
// satisfies the first launch. Counted from the start of the whole connect;
// its own RunPod client gives up on a call after 5 s, so the request stays
// well inside SET_KEY_HOME_BAY_TIMEOUT_MS. Not done in time: "checking",
// and the reconciler's next sweep takes the new key first.
export const CONNECT_INVENTORY_MS = 15_000;
export const CONNECT_INVENTORY_CALL_MS = 5_000;

async function connectInventory(
  {
    account_id,
    credential_id,
    deadline,
  }: { account_id: string; credential_id: string; deadline: number },
  deps: GpuProviderKeyDeps,
): Promise<boolean> {
  // loaded here: reconcile.ts reads keys through this module
  const { reconcileKey } = await import("@cocalc/server/gpu/reconcile");
  const outcome = await reconcileKey(
    { credential_id, key_owner_account_id: account_id, deadline },
    {
      getReconcile: (a) =>
        getRunpodCleanupForAccount(a, {
          ...deps,
          runpodTimeoutMs: CONNECT_INVENTORY_CALL_MS,
        }),
    },
  );
  return outcome.complete === true;
}

// "complete" while the key's last complete inventory is recent enough for
// launches
async function inventoryState(
  credential_id: string,
): Promise<"complete" | "checking"> {
  const { rows } = await getPool().query(
    `SELECT last_inventory_at FROM gpu_key_fences WHERE credential_id = $1`,
    [credential_id],
  );
  const last = rows[0]?.last_inventory_at;
  return last && Date.now() - new Date(last).getTime() <= INVENTORY_STALE_MS
    ? "complete"
    : "checking";
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
  const status = toStatus(provider, entitled, record[0]);
  if (!status.connected) return status;
  return { ...status, inventory: await inventoryState(record[0].id) };
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

// Pods launched with the account's key that may still exist at RunPod. While
// there are any, the key can be neither replaced nor removed: the stored key
// keeps its id when replaced, and a key for another RunPod account (or no
// key) couldn't reach those pods, so CoCalc could no longer terminate them.
// Step 5c replaces this with draining and a cleanup-only copy of the key.
async function countUnfinishedPods(
  account_id: string,
  db: Pick<PoolClient, "query"> = getPool(),
): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM gpu_pods
      WHERE key_owner_account_id = $1 AND state NOT IN ('terminated', 'failed')
        AND unmanaged_at IS NULL`,
    [account_id],
  );
  return rows[0]?.n ?? 0;
}

// Does RunPod reject the stored key itself (401)? Only that counts: a
// network error, a timeout or any other answer is "don't know".
async function storedKeyRejectedByRunpod(
  account_id: string,
  deps: GpuProviderKeyDeps,
): Promise<boolean> {
  const key = await readLocalKey(account_id, deps).catch(() => undefined);
  if (!key) return false;
  const client = new RunpodClient({
    apiKey: key.apiKey,
    fetch: deps.fetch,
    timeoutMs: VERIFY_REQUEST_TIMEOUT_MS,
  });
  try {
    await client.getProviderIdentity();
    return false;
  } catch (err) {
    return err instanceof RunpodApiError && err.kind === "auth";
  }
}

// Key replacement and removal run under the same account fence a launch
// holds while it reads the key and records its intent (pods.ts), so the
// count of unfinished pods can't change between the check and the change.
export async function underKeyFence<T>(
  account_id: string,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await lockGpuAccountFence(db, account_id, "change a GPU provider key");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

// A connected key can be replaced (a new credential, 5c) only once the old
// one has nothing left to do: no unfinished pods, and its fence not being
// drained or cleaned up after a compromise. No exception, not even a key
// RunPod rejects: the new key gets a new identity, so the old pods would be
// orphaned. Remove the old key first (removal handles pods it can't reach).
async function requireReplaceable(
  account_id: string,
  credential_id: string,
  deps: GpuProviderKeyDeps,
  db: Pick<PoolClient, "query"> = getPool(),
): Promise<void> {
  const { rows } = await db.query(
    "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
    [credential_id],
  );
  const state = rows[0]?.state;
  if (state === "draining" || state === "compromised") {
    throw Error(
      state === "draining"
        ? "Your RunPod key is being removed; connect a new one once the removal finishes."
        : "Your RunPod key was reported compromised and CoCalc is still cleaning up its RunPod account; connect a new key once that finishes.",
    );
  }
  const n = await (deps.unfinishedPods ?? ((a) => countUnfinishedPods(a, db)))(
    account_id,
  );
  if (n === 0) return;
  throw Error(
    `${n} GPU pod${n === 1 ? " was" : "s were"} launched with your current RunPod key and ${n === 1 ? "isn't" : "aren't"} finished, so the key can't be replaced yet. Terminate ${n === 1 ? "it" : "them"} first (cocalc gpu kill), or remove the key (which terminates them), then connect the new one.`,
  );
}

// A removed or replaced key's fence is closed (final), with its log row.
export async function closeKeyFence(
  db: Pick<PoolClient, "query">,
  account_id: string,
  credential_id: string,
  action: "removed" | "compromise_closed" | "forced_removal",
  details?: Record<string, unknown>,
  actor: GpuKeyEventActor = { kind: "user", account_id },
): Promise<void> {
  await db.query(
    `UPDATE gpu_key_fences SET state = 'closed', updated = now()
      WHERE credential_id = $1 AND state <> 'closed'`,
    [credential_id],
  );
  // what can't be checked without the key stays open, for the owner
  await onKeyGone({ credential_id, by: action }, db);
  await recordKeyEvent(
    {
      credential_id,
      key_owner_account_id: account_id,
      actor,
      action,
      details,
    },
    db,
  );
}

export async function setGpuProviderKeyLocal(
  {
    account_id,
    provider: providerInput,
    api_key,
  }: { account_id: string; provider: unknown; api_key: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<GpuProviderKeyStatus> {
  // the connect's whole time counts from here (the inventory pass's too)
  const operationStarted = Date.now();
  const provider = requireProvider(providerInput);
  await requireHomeBay(account_id, deps);
  if (!(await (deps.isEntitled ?? isGpuProviderKeysEntitled)(account_id))) {
    throw Error(
      "Your membership doesn't include connecting a GPU provider key.",
    );
  }
  const key = normalizeRunpodKey(api_key);
  const [prior] = await activeKeySummaries(account_id, provider);
  if (prior) await requireReplaceable(account_id, prior.id, deps);
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
  // Checked again and stored under the fence launches take: no launch can
  // read the old key between this check and the store. Every connect is a
  // new credential (a new id, fence and budget layer): the old one, if any,
  // is revoked first and its fence closed.
  let credential_id: string | undefined;
  await (deps.keyFence ?? underKeyFence)(account_id, async (db) => {
    const [current] = await activeKeySummaries(account_id, provider);
    if (current) await requireReplaceable(account_id, current.id, deps, db);
    // never looser than what the account's previous key layer allowed
    const caps = await carryKeyBudget(db, account_id);
    // One transaction: the old key is revoked and its fence closed, the new
    // one stored with a new id, and its fence and layer (with the carried
    // caps) created; or none of it happens.
    ({ id: credential_id } = await upsertExternalCredential({
      selector: selector(account_id, provider),
      payload: key,
      metadata: {
        source: "account-settings",
        provider_account_kind: identity.kind,
        provider_account_id: identity.id,
        ...(provider_account_name ? { provider_account_name } : {}),
        verified_at,
      },
      newIdentity: true,
      alsoInTransaction: async (client, { id, previous }) => {
        for (const old of previous) {
          await (deps.clearHostkeys ?? clearHostkeysForCredential)(
            { account_id, credential_id: old },
            client,
          );
          await closeKeyFence(client, account_id, old, "removed", {
            replaced: true,
          });
        }
        // the fence and layer exist from the start (the kill switch and
        // the first launch both find them)
        await ensureKeyBudget(client, {
          credential_id: id,
          key_owner_account_id: account_id,
          ...(caps ? { initial: caps } : {}),
        });
        // a kill switch's pause outlives the key it was pressed on: lifting
        // it is resume's (with fresh authentication), not a rotation's
        if (previous.length > 0) {
          await client.query(
            `UPDATE gpu_key_fences SET kill_switch_at = (
                SELECT max(kill_switch_at) FROM gpu_key_fences WHERE credential_id = ANY($2::uuid[]))
              WHERE credential_id = $1 AND kill_switch_at IS NULL`,
            [id, previous],
          );
        }
        // last (after every fence row above): a key for this RunPod account
        // and the account checks on it take turns (5d-2b)
        await lockProviderIdentity(client, {
          provider,
          kind: identity.kind,
          id: identity.id,
        });
      },
    }));
  });
  // The key is stored: whatever the inventory pass does, the connect stands.
  let complete = false;
  if (credential_id) {
    complete = await (
      deps.connectInventory ?? ((k) => connectInventory(k, deps))
    )({
      account_id,
      credential_id,
      deadline: operationStarted + CONNECT_INVENTORY_MS,
    }).catch(() => false);
  }
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
    inventory: complete ? "complete" : "checking",
  };
}

// What a removal did. A key with unfinished pods is drained first: CoCalc
// terminates them with it, and keeps it until RunPod confirms. If some are
// still there when the request's time is up, the key stays (being removed:
// no new launches) and the cleanup worker keeps terminating them; removing
// again, or forcing, finishes it.
export interface GpuKeyRemoval {
  revoked: boolean;
  // pods still being terminated with the key
  remaining?: string[];
  // pods a forced removal left outside CoCalc's management: they may still
  // run and bill at RunPod, and CoCalc's limits no longer cover them
  unmanaged?: string[];
  warning?: string;
}

// How long a removal request waits for RunPod to confirm its pods are gone,
// counted from the start of the removal (the rejection probe's time comes
// out of it). The browser waits KEY_HOME_BAY_TIMEOUT_MS (30 s) for the home
// bay: the drain, plus one RunPod call still in flight at its end, plus the
// fenced database work, must fit, so it always gets the remaining pods (and
// "Remove anyway") rather than a timeout.
export const KEY_REMOVAL_DRAIN_MS = 15_000;
// Each RunPod call the removal's drain makes.
export const KEY_REMOVAL_CALL_TIMEOUT_MS = 5_000;

// The caller has already required fresh auth for this session (removal,
// forced or not, needs it).
export async function deleteGpuProviderKey(
  {
    account_id,
    provider,
    force,
  }: { account_id: string; provider: unknown; force?: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<GpuKeyRemoval> {
  requireProvider(provider);
  const home = await homeClientFor(account_id, KEY_HOME_BAY_TIMEOUT_MS, deps);
  if (home) {
    return await home.gpuKeyDelete({
      account_id,
      provider,
      force: force === true,
    });
  }
  return await deleteGpuProviderKeyLocal({ account_id, provider, force }, deps);
}

export async function deleteGpuProviderKeyLocal(
  {
    account_id,
    provider: providerInput,
    force: forceInput,
  }: { account_id: string; provider: unknown; force?: unknown },
  deps: GpuProviderKeyDeps = {},
): Promise<GpuKeyRemoval> {
  const provider = requireProvider(providerInput);
  const started = Date.now();
  await requireHomeBay(account_id, deps);
  const force = forceInput === true;
  // The store keeps one active key per selector, so there is at most one.
  const [existing] = await activeKeySummaries(account_id, provider);
  if (!existing) return { revoked: false };
  const credential_id = existing.id;
  const pods = await import("@cocalc/server/gpu/pods");
  const unfinished = (db?: Pick<PoolClient, "query">) =>
    deps.credentialPods
      ? deps.credentialPods(credential_id)
      : pods.unfinishedCredentialPods(credential_id, db);

  // 1. Under the fence launches take: the key admits nothing more, and its
  // pods are marked to terminate. It must still be the connected key (a
  // replacement may have won the fence first).
  await (deps.keyFence ?? underKeyFence)(account_id, async (db) => {
    const [current] = await activeKeySummaries(account_id, provider);
    if (current?.id !== credential_id) {
      throw Error(
        "Your RunPod key changed while it was being removed; check it and try again.",
      );
    }
    const { rows } = await db.query(
      "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
      [credential_id],
    );
    if (rows[0]?.state === "compromised" && !force) {
      throw Error(
        "CoCalc is still cleaning up the RunPod account of this key, reported compromised; it removes the key itself when that finishes. Remove it now only with force (then terminate any pods and revoke the key at RunPod).",
      );
    }
    await db.query(
      `INSERT INTO gpu_key_fences (credential_id, key_owner_account_id, state, created, updated)
       VALUES ($1, $2, 'draining', now(), now())
       ON CONFLICT (credential_id) DO UPDATE SET state = 'draining', updated = now()
         WHERE gpu_key_fences.state = 'active'`,
      [credential_id, account_id],
    );
    const marked = await pods.markCredentialPodsToTerminate(db, {
      account_id,
      credential_id,
      cause: "key_removal",
    });
    await recordKeyEvent(
      {
        credential_id,
        key_owner_account_id: account_id,
        actor: { kind: "user", account_id },
        action: "removal_started",
        details: { marked, force },
      },
      db,
    );
  });
  // From here the key can't change (a draining key can't be replaced).
  // A key RunPod rejects (401: deleted or revoked there) can't terminate
  // anything, so removing it goes straight to the forced outcome.
  const rejected =
    (await unfinished()).length > 0 &&
    (await (deps.storedKeyRejected ?? storedKeyRejectedByRunpod)(
      account_id,
      deps,
    ));

  // 2. Terminate them with the key while it is still stored (bounded).
  if (!rejected) {
    const drain =
      deps.drain ??
      ((a: string, guard: () => Promise<void>) =>
        pods.resolvePendingForAccount(
          a,
          {
            getCleanup: (acct) =>
              getRunpodCleanupForAccount(acct, {
                ...deps,
                runpodTimeoutMs: KEY_REMOVAL_CALL_TIMEOUT_MS,
              }),
          },
          { guard },
        ));
    const deadline = started + (deps.drainMs ?? KEY_REMOVAL_DRAIN_MS);
    // the resolver stops at the deadline too, before its next pod (one slow
    // RunPod call can't turn into a whole batch of them)
    const guard = async () => {
      if (Date.now() >= deadline) throw Error("key removal drain deadline");
    };
    for (;;) {
      await drain(account_id, guard).catch(() => {});
      if ((await unfinished()).length === 0 || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, deps.drainPollMs ?? 2_000));
    }
  }

  // 3. Under the fence: close the key's fence (it admits nothing, ever), or
  // report what is left. The key itself is revoked after this commits, so
  // its revocation (which clears the pods' host keys) never waits on rows
  // this transaction holds; a retry finishes a revocation that failed.
  const outcome = await (deps.keyFence ?? underKeyFence)(
    account_id,
    async (db): Promise<GpuKeyRemoval> => {
      // a compromise report that came in while this drained takes over: its
      // cleanup keeps the key (to watch the account) until RunPod rejects it
      const { rows } = await db.query(
        "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
        [credential_id],
      );
      if (rows[0]?.state === "compromised" && !force) {
        return {
          revoked: false,
          warning:
            "This key was reported compromised while it was being removed: CoCalc keeps cleaning up its RunPod account, and removes the key itself once you revoke it at RunPod.",
        };
      }
      const left = await unfinished(db);
      if (left.length === 0) {
        await closeKeyFence(db, account_id, credential_id, "removed");
        return { revoked: true };
      }
      if (!force && !rejected) {
        return { revoked: false, remaining: left.map((p) => p.handle) };
      }
      const unmanaged = deps.markUnmanaged
        ? await deps.markUnmanaged(credential_id)
        : await pods.markCredentialPodsUnmanaged(db, {
            account_id,
            credential_id,
          });
      // the owner must terminate them at RunPod: an alert each, now
      const observed_at = new Date();
      for (const handle of unmanaged) {
        await raiseAlert(
          {
            key_owner_account_id: account_id,
            credential_id,
            kind: "unmanaged_pod",
            severity: "warning",
            dedupe_key: handle,
            details: { handle, ...(rejected ? { key_rejected: true } : {}) },
            observed_at,
          },
          db,
        );
      }
      await closeKeyFence(db, account_id, credential_id, "forced_removal", {
        unmanaged,
        rejected,
      });
      return {
        revoked: true,
        unmanaged,
        warning: `${unmanaged.length} pod${unmanaged.length === 1 ? "" : "s"} launched with this key may still be running and billing at RunPod, and CoCalc's GPU limits no longer cover ${unmanaged.length === 1 ? "it" : "them"}: terminate ${unmanaged.length === 1 ? "it" : "them"} at RunPod, and revoke the key there.`,
      };
    },
  );
  if (outcome.revoked) {
    await revokeExternalCredential({
      id: credential_id,
      owner_account_id: account_id,
      alsoOnRevoke: async (client) => {
        await (deps.clearHostkeys ?? clearHostkeysForCredential)(
          { account_id, credential_id },
          client,
        );
      },
    });
  }
  return outcome;
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
): Promise<{ id: string; apiKey: string; revision: string } | undefined> {
  await requireHomeBay(account_id, deps);
  const record = await getExternalCredential({
    selector: selector(account_id, "runpod"),
  });
  if (!record || record.revoked || !record.payload) return undefined;
  // the record's last write: an in-place replacement keeps the id but not this
  return {
    id: record.id,
    apiKey: record.payload,
    revision: new Date(record.updated).toISOString(),
  };
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
  return (await getRunpodLaunchAccessForAccount(account_id, deps))?.client;
}

// The full client together with the id of the stored key it uses, which
// every pod record keeps. Same custody and entitlement as above.
export async function getRunpodLaunchAccessForAccount(
  account_id: string,
  deps: GpuProviderKeyDeps = {},
): Promise<
  { client: RunpodClient; credential_id: string; revision: string } | undefined
> {
  if (!(await (deps.isEntitled ?? isGpuProviderKeysEntitled)(account_id))) {
    throw Error("Your membership doesn't include using a GPU provider key.");
  }
  const key = await readLocalKey(account_id, deps);
  if (!key) return undefined;
  return {
    client: new RunpodClient({ apiKey: key.apiKey, fetch: deps.fetch }),
    credential_id: key.id,
    revision: key.revision,
  };
}

// What cleanup may do with an account's key: find the pods and storage it
// manages, check billing, and terminate them. Nothing here can
// create or start anything, so it needs no entitlement: a lapsed membership
// or a removed key can still be cleaned up. The client itself stays private
// to these closures.
export interface RunpodCleanupCapability {
  // the stored key this capability holds: a pod is only ever acted on with
  // the key that launched it (its record's credential_id)
  readonly credential_id: string;
  getProviderIdentity(): Promise<RunpodProviderIdentity>;
  listPods(
    ...args: Parameters<RunpodClient["listPods"]>
  ): ReturnType<RunpodClient["listPods"]>;
  getPod(podId: string): ReturnType<RunpodClient["getPod"]>;
  listPodBilling(
    ...args: Parameters<RunpodClient["listPodBilling"]>
  ): ReturnType<RunpodClient["listPodBilling"]>;
  terminatePod(podId: string): Promise<void>;
  findPodsByName(
    ...args: Parameters<RunpodClient["findPodsByName"]>
  ): ReturnType<RunpodClient["findPodsByName"]>;
  // the account's balance and spend rate (5d-2b's account checks)
  getAccountBalance(): ReturnType<RunpodClient["getAccountBalance"]>;
}

export async function getRunpodCleanupForAccount(
  account_id: string,
  deps: GpuProviderKeyDeps = {},
): Promise<RunpodCleanupCapability | undefined> {
  const key = await readLocalKey(account_id, deps);
  if (!key) return undefined;
  const client = new RunpodClient({
    apiKey: key.apiKey,
    fetch: deps.fetch,
    ...(deps.runpodTimeoutMs ? { timeoutMs: deps.runpodTimeoutMs } : {}),
  });
  return Object.freeze({
    credential_id: key.id,
    getProviderIdentity: () => client.getProviderIdentity(),
    listPods: (...args: Parameters<RunpodClient["listPods"]>) =>
      client.listPods(...args),
    getPod: (podId: string) => client.getPod(podId),
    listPodBilling: (...args: Parameters<RunpodClient["listPodBilling"]>) =>
      client.listPodBilling(...args),
    terminatePod: (podId: string) => client.terminatePod(podId),
    findPodsByName: (...args: Parameters<RunpodClient["findPodsByName"]>) =>
      client.findPodsByName(...args),
    getAccountBalance: () => client.getAccountBalance(),
  });
}

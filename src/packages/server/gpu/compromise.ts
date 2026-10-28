/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Reporting a RunPod key compromised (step 5c). The owner has confirmed the
RunPod account is used only for CoCalc, so every pod in it may be
terminated, including ones CoCalc didn't start (the theft case).

1. Under the account fence, before any provider call: the key's fence
   becomes `compromised` (it admits nothing; connect, replace and remove
   refuse until the cleanup closes it) and the key's pods are marked to
   terminate.
2. Cleanup passes, run by the request and then by the reaper each sweep
   until done (resumable: the state is the fence and the stored key):
   list every pod in the RunPod account (a listing that may be incomplete
   throws), terminate each one, and the managed ones through their normal
   paths.
3. Done only when a complete listing shows no pods at all and no managed
   pod of the key is unfinished: then the fence is closed and the key
   revoked. Otherwise only an explicit forced removal ends it.
*/

import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  createInterBayAccountLocalClient,
  type InterBayGpuApi,
} from "@cocalc/conat/inter-bay/api";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { revokeExternalCredential } from "@cocalc/server/external-credentials/store";
import { clearHostkeysForCredential } from "@cocalc/server/gpu/hostkey-clear";
import {
  closeKeyFence,
  getRunpodCleanupForAccount,
  underKeyFence,
  type RunpodCleanupCapability,
} from "@cocalc/server/gpu/provider-keys";
import {
  markCredentialPodsToTerminate,
  resolvePendingForAccount,
  unfinishedCredentialPods,
} from "@cocalc/server/gpu/pods";
import {
  recordKeyEvent,
  sanitizeProviderName,
} from "@cocalc/server/gpu/key-events";

const log = getLogger("server:gpu:compromise");

export interface GpuCompromiseStatus {
  // the cleanup finished: the key is revoked and its fence closed
  closed: boolean;
  // pods still in the RunPod account at the last complete listing
  provider_pods?: number;
  // CoCalc's pods of this key not yet confirmed terminated
  managed_pods?: number;
  // the last pass couldn't list the account (it retries)
  listing_failed?: boolean;
}

export interface GpuCompromiseDeps {
  // for tests
  getCleanup?: (
    account_id: string,
  ) => Promise<RunpodCleanupCapability | undefined>;
  resolvePending?: (account_id: string) => Promise<unknown>;
  keyFence?: typeof underKeyFence;
  homeClient?: (account_id: string) => Promise<InterBayGpuApi | undefined>;
  freshAuth?: typeof requireDangerousSessionAuth;
}

function requireAccount(account_id: unknown): string {
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    throw Error("Sign in to do this.");
  }
  return account_id;
}

async function activeCredential(
  account_id: string,
  deps: GpuCompromiseDeps,
): Promise<RunpodCleanupCapability | undefined> {
  return await (deps.getCleanup ?? getRunpodCleanupForAccount)(account_id);
}

// One cleanup pass for a compromised key. Idempotent; safe to run again at
// any point, by the request or the reaper.
export async function runCompromiseCleanup(
  account_id: string,
  credential_id: string,
  deps: GpuCompromiseDeps = {},
): Promise<GpuCompromiseStatus> {
  const c = await activeCredential(account_id, deps);
  // the key is no longer stored (a forced removal ended it), or another key
  // is: nothing to do with this one
  if (!c || c.credential_id !== credential_id) return { closed: false };
  // the key's own pods, through their normal paths
  await (deps.resolvePending ?? ((a) => resolvePendingForAccount(a, {})))(
    account_id,
  ).catch(() => {});
  let listed: Awaited<ReturnType<RunpodCleanupCapability["listPods"]>>;
  try {
    listed = await c.listPods();
  } catch (err) {
    log.warn("listing a compromised key's RunPod account failed", `${err}`);
    return { closed: false, listing_failed: true };
  }
  const { rows: managed } = await getPool().query(
    "SELECT provider_pod_id FROM gpu_pods WHERE credential_id = $1 AND provider_pod_id IS NOT NULL",
    [credential_id],
  );
  const known = new Set(managed.map((r) => r.provider_pod_id));
  for (const pod of listed) {
    if (known.has(pod.id)) continue;
    // a pod CoCalc didn't start: record it the first time it is seen, and
    // terminate it every pass until it is gone
    const { rows: seen } = await getPool().query(
      `SELECT 1 FROM gpu_key_events WHERE credential_id = $1
         AND action = 'unknown_pod_seen' AND details->>'provider_pod_id' = $2 LIMIT 1`,
      [credential_id, pod.id],
    );
    if (seen.length === 0) {
      await recordKeyEvent({
        credential_id,
        key_owner_account_id: account_id,
        actor: { kind: "cleanup" },
        action: "unknown_pod_seen",
        details: {
          provider_pod_id: pod.id,
          name: sanitizeProviderName(pod.name),
        },
      });
    }
    try {
      await c.terminatePod(pod.id);
      await recordKeyEvent({
        credential_id,
        key_owner_account_id: account_id,
        actor: { kind: "cleanup" },
        action: "unknown_pod_terminated",
        details: { provider_pod_id: pod.id },
      });
    } catch (err) {
      log.warn("terminating an unknown pod failed", pod.id, `${err}`);
    }
  }
  const left = await unfinishedCredentialPods(credential_id);
  if (listed.length > 0 || left.length > 0) {
    return {
      closed: false,
      provider_pods: listed.length,
      managed_pods: left.length,
    };
  }
  // A complete listing shows no pods, and none of CoCalc's is unfinished:
  // close the fence, then revoke the key (after the commit, so the
  // revocation never waits on rows this transaction holds).
  const closed = await (deps.keyFence ?? underKeyFence)(
    account_id,
    async (db) => {
      const { rows } = await db.query(
        "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
        [credential_id],
      );
      if (rows[0]?.state !== "compromised") return false;
      if ((await unfinishedCredentialPods(credential_id, db)).length > 0) {
        return false;
      }
      await closeKeyFence(db, account_id, credential_id, "compromise_closed");
      return true;
    },
  );
  if (!closed) return { closed: false, provider_pods: 0, managed_pods: 0 };
  await revokeExternalCredential({
    id: credential_id,
    owner_account_id: account_id,
    alsoOnRevoke: async (client) => {
      await clearHostkeysForCredential({ account_id, credential_id }, client);
    },
  });
  return { closed: true, provider_pods: 0, managed_pods: 0 };
}

// On the key owner's home bay. The caller checked fresh authentication.
export async function reportCompromisedLocal(
  opts: {
    account_id?: string;
    confirm_cocalc_only?: unknown;
    fresh_auth_verified?: boolean;
  },
  deps: GpuCompromiseDeps = {},
): Promise<GpuCompromiseStatus> {
  const account_id = requireAccount(opts.account_id);
  if (opts.fresh_auth_verified !== true) {
    throw Object.assign(
      Error("Reporting a key compromised needs you to sign in again."),
      { code: "fresh_auth_required" },
    );
  }
  if (opts.confirm_cocalc_only !== true) {
    throw Error(
      "Confirm that this RunPod account is used only for CoCalc: CoCalc will terminate every pod in it, including ones it didn't start.",
    );
  }
  const c = await activeCredential(account_id, deps);
  if (!c) throw Error("No RunPod API key is connected.");
  const credential_id = c.credential_id;
  // 1. Before any provider call: the fence is compromised, the pods marked.
  await (deps.keyFence ?? underKeyFence)(account_id, async (db) => {
    await db.query(
      `INSERT INTO gpu_key_fences (credential_id, key_owner_account_id, state, created, updated)
       VALUES ($1, $2, 'compromised', now(), now())
       ON CONFLICT (credential_id) DO UPDATE SET state = 'compromised', updated = now()
         WHERE gpu_key_fences.state IN ('active', 'draining')`,
      [credential_id, account_id],
    );
    const marked = await markCredentialPodsToTerminate(db, {
      account_id,
      credential_id,
      cause: "compromised",
    });
    await recordKeyEvent(
      {
        credential_id,
        key_owner_account_id: account_id,
        actor: { kind: "user", account_id },
        action: "compromised",
        details: { marked },
      },
      db,
    );
  });
  // 2. One pass now; the reaper continues.
  return await runCompromiseCleanup(account_id, credential_id, deps);
}

async function compromiseHomeClient(
  account_id: string,
): Promise<InterBayGpuApi | undefined> {
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  const dest_bay = `${home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (dest_bay === getConfiguredBayId()) return undefined;
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
    timeout: 60_000,
  });
}

// On the bay the user is signed in to: fresh authentication for the
// caller's own session, then the home bay does the rest.
export async function reportCompromised(
  opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    confirm_cocalc_only?: unknown;
  },
  deps: GpuCompromiseDeps = {},
): Promise<GpuCompromiseStatus> {
  const account_id = requireAccount(opts.account_id);
  await (deps.freshAuth ?? requireDangerousSessionAuth)({
    account_id,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: false,
  });
  const forwarded = {
    account_id,
    confirm_cocalc_only: opts.confirm_cocalc_only === true,
    fresh_auth_verified: true,
  };
  const home = await (deps.homeClient ?? compromiseHomeClient)(account_id);
  if (home) return await home.gpuReportCompromised(forwarded);
  return await reportCompromisedLocal(forwarded, deps);
}

// The reaper's part: a pass for every compromised key still stored on this
// bay. `guard` renews the reaper's lease before each one.
export async function continueCompromiseCleanups(
  guard: () => Promise<void>,
  deps: GpuCompromiseDeps = {},
): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT f.credential_id, f.key_owner_account_id FROM gpu_key_fences f
       JOIN external_credentials c ON c.id = f.credential_id
      WHERE f.state = 'compromised' AND c.revoked IS NULL`,
  );
  for (const r of rows) {
    await guard();
    await runCompromiseCleanup(
      r.key_owner_account_id,
      r.credential_id,
      deps,
    ).catch((err) => log.warn("a compromise cleanup pass failed", `${err}`));
  }
  return rows.length;
}

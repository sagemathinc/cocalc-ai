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
   Bound pods a complete listing no longer shows are gone at RunPod: they
   end through the normal terminated path, settling their cost.
3. The key is still valid at RunPod (CoCalc can't revoke a RunPod key), so
   an empty account isn't the end: CoCalc keeps its copy, the only way to
   see and stop pods a thief starts, and keeps cleaning every sweep. It
   closes the fence and drops its copy only once RunPod authoritatively
   rejects the key (401: the owner deleted it at RunPod) and nothing of the
   key is unfinished. Otherwise only an explicit forced removal ends it.
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
import { RunpodApiError } from "@cocalc/cloud/runpod/client";
import {
  endPodsAbsentFromInventory,
  markCredentialPodsToTerminate,
  resolvePendingForAccount,
  unfinishedCredentialPods,
} from "@cocalc/server/gpu/pods";
import {
  recordKeyEvent,
  sanitizeProviderName,
} from "@cocalc/server/gpu/key-events";

import type { GpuCompromiseStatus } from "@cocalc/util/gpu/types";

const log = getLogger("server:gpu:compromise");

// RunPod rejects the key while CoCalc's own pods of it may still run: CoCalc
// can't stop them anymore, and won't close the report by itself
const PROVIDER_REJECTED_WARNING =
  "RunPod no longer accepts this key, but pods CoCalc launched with it may still be running and billing at RunPod, and CoCalc can't terminate them anymore. Terminate them on RunPod's Pods page, then remove the key in CoCalc's Settings with \"Remove anyway\".";

// A close follows RunPod rejecting the key, after CoCalc's last look at the
// account: a pod started between that look and the revocation is one
// CoCalc never saw, and now can't (deleting a key at RunPod doesn't stop its
// pods). So the owner checks once.
const CLOSED_WARNING =
  "CoCalc removed this key and stopped watching the RunPod account. It can't see pods started after its last check: look at RunPod's Pods page once, and terminate any pod you don't recognize.";

// What the owner does next, told by every report (the close itself usually
// happens later, in the background, where no one sees its result).
const NEXT_STEPS_WARNING =
  "Delete this key on RunPod's Credentials page: until then CoCalc keeps it, to watch the account and terminate every pod in it. After you delete it, check RunPod's Pods page once and terminate any pod you don't recognize: CoCalc can't see pods started after its last check.";

// how long the report request's own pass may spend terminating pods (the
// compromise worker continues)
const REQUEST_PASS_MS = 15_000;

export type { GpuCompromiseStatus };

export interface GpuCompromiseDeps {
  // for tests
  getCleanup?: (
    account_id: string,
  ) => Promise<RunpodCleanupCapability | undefined>;
  resolvePending?: (
    account_id: string,
    guard: () => Promise<void>,
  ) => Promise<unknown>;
  keyFence?: typeof underKeyFence;
  homeClient?: (account_id: string) => Promise<InterBayGpuApi | undefined>;
  freshAuth?: typeof requireDangerousSessionAuth;
  // bounds one pass: before each pod it terminates, guard runs (the
  // worker's lease) and the pass stops once passMs is spent (the next one
  // continues; nothing is lost)
  guard?: () => Promise<void>;
  passMs?: number;
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
  // the key's own pods, through their normal paths, every pass: a compromised
  // key's terminates don't back off (the reaper's backoff is for one bad pod
  // among many; here each is retried until RunPod confirms)
  await getPool().query(
    `UPDATE gpu_pods SET reap_after = NULL
      WHERE credential_id = $1 AND desired_state = 'terminated'
        AND state NOT IN ('terminated', 'failed')
        AND unmanaged_at IS NULL AND reap_after IS NOT NULL`,
    [credential_id],
  );
  // the whole pass, resolving included, is bounded: past the deadline it
  // stops (the next pass continues)
  const deadline = Date.now() + (deps.passMs ?? REQUEST_PASS_MS);
  let cut = false;
  const bounded = async () => {
    await deps.guard?.();
    if (Date.now() >= deadline) {
      cut = true;
      throw Error("compromise pass deadline");
    }
  };
  await (
    deps.resolvePending ??
    ((a, guard) => resolvePendingForAccount(a, {}, { guard }))
  )(account_id, bounded).catch(() => {});
  // out of time: nothing more this pass (the next one continues)
  const cutShort = async (): Promise<GpuCompromiseStatus> => ({
    closed: false,
    managed_pods: (await unfinishedCredentialPods(credential_id)).length,
  });
  if (cut) return await cutShort();
  // CoCalc's pods bound before the listing starts: only these can be ended
  // for being absent from it (one bound later may have been created after
  // RunPod took the snapshot; the next pass sees it)
  const boundBefore = await boundCredentialPods(credential_id);
  let listed: Awaited<ReturnType<RunpodCleanupCapability["listPods"]>>;
  try {
    // every page is bounded by the pass too (RunPod may be slow, or the
    // account large)
    listed = await c.listPods({ beforePage: bounded });
  } catch (err) {
    if (cut) return await cutShort();
    // RunPod rejects the key outright (the owner deleted it there): the same
    // end as the identity check below, once CoCalc has no unfinished pod on
    // it. Any other failure says nothing about the account: fail closed.
    if (err instanceof RunpodApiError && err.kind === "auth") {
      // the answer may have come after the pass's time (or lease) ran out
      await bounded().catch((e) => {
        if (!cut) throw e;
      });
      if (cut) return await cutShort();
      const left = await unfinishedCredentialPods(credential_id);
      if (left.length > 0) {
        return {
          closed: false,
          provider_rejected: true,
          managed_pods: left.length,
          warning: PROVIDER_REJECTED_WARNING,
        };
      }
      return await revokeAndClose(account_id, credential_id, deps);
    }
    log.warn("listing a compromised key's RunPod account failed", `${err}`);
    return { closed: false, listing_failed: true };
  }
  // The last (or only) page may have come back after the pass's time ran
  // out, or its lease was lost meanwhile: act on the listing only within
  // both (a lost lease throws; the next holder continues).
  await bounded().catch((e) => {
    if (!cut) throw e;
  });
  if (cut) return await cutShort();
  const { rows: managed } = await getPool().query(
    "SELECT provider_pod_id, state FROM gpu_pods WHERE credential_id = $1 AND provider_pod_id IS NOT NULL",
    [credential_id],
  );
  // CoCalc's unfinished pods end through their normal paths; one it records
  // as ended but RunPod still lists is terminated again (quietly: it is
  // CoCalc's, and terminating is idempotent)
  const live = new Set<string>();
  const ended = new Set<string>();
  for (const r of managed) {
    (FINISHED.has(r.state) ? ended : live).add(r.provider_pod_id);
  }
  // the listing is complete: CoCalc's pods bound before it that it doesn't
  // show are gone
  await endPodsAbsentFromInventory(
    credential_id,
    new Set(listed.map((p) => p.id)),
    boundBefore,
  );
  for (const pod of listed) {
    if (live.has(pod.id)) continue;
    if (Date.now() >= deadline) {
      cut = true;
      break;
    }
    await deps.guard?.();
    if (ended.has(pod.id)) {
      await c.terminatePod(pod.id).catch((err) => {
        log.warn("terminating an ended pod again failed", pod.id, `${err}`);
      });
      continue;
    }
    // a pod CoCalc didn't start: record it the first time it is seen, and
    // terminate it every pass until it is gone
    const { rows: seen } = await getPool().query(
      `SELECT 1 FROM gpu_key_events WHERE credential_id = $1
         AND action = 'unknown_pod_seen' AND details->>'provider_pod_id' = $2 LIMIT 1`,
      [credential_id, sanitizeProviderName(pod.id)],
    );
    if (seen.length === 0) {
      await recordKeyEvent({
        credential_id,
        key_owner_account_id: account_id,
        actor: { kind: "cleanup" },
        action: "unknown_pod_seen",
        details: {
          provider_pod_id: sanitizeProviderName(pod.id),
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
        details: { provider_pod_id: sanitizeProviderName(pod.id) },
      });
    } catch (err) {
      log.warn("terminating an unknown pod failed", pod.id, `${err}`);
    }
  }
  const left = await unfinishedCredentialPods(credential_id);
  if (cut || listed.length > 0 || left.length > 0) {
    return {
      closed: false,
      provider_pods: listed.length,
      managed_pods: left.length,
    };
  }
  // Empty, but a thief may still use the key: keep it (CoCalc's only way to
  // see and stop their pods) until RunPod itself rejects it.
  let rejected = false;
  try {
    await c.getProviderIdentity();
  } catch (err) {
    rejected = err instanceof RunpodApiError && err.kind === "auth";
  }
  // the answer may have come after the pass's time (or lease) ran out
  await bounded().catch((e) => {
    if (!cut) throw e;
  });
  if (cut) return await cutShort();
  if (!rejected) {
    return {
      closed: false,
      awaiting_provider_revocation: true,
      provider_pods: 0,
      managed_pods: 0,
      warning: NEXT_STEPS_WARNING,
    };
  }
  return await revokeAndClose(account_id, credential_id, deps);
}

// RunPod rejects the key and nothing is left: revoke CoCalc's copy, then
// close the fence. In that order: if closing fails, the fence stays
// compromised with its key revoked, and the next sweep closes it
// (closeRevokedCompromises); the key is never left active outside the
// reaper's view. (Nothing can change between: a compromised fence admits
// nothing and can't be replaced.)
async function revokeAndClose(
  account_id: string,
  credential_id: string,
  deps: GpuCompromiseDeps,
): Promise<GpuCompromiseStatus> {
  await revokeExternalCredential({
    id: credential_id,
    owner_account_id: account_id,
    alsoOnRevoke: async (client) => {
      await clearHostkeysForCredential({ account_id, credential_id }, client);
    },
  });
  await closeCompromise(account_id, credential_id, deps);
  return {
    closed: true,
    provider_pods: 0,
    managed_pods: 0,
    warning: CLOSED_WARNING,
  };
}

const FINISHED = new Set(["terminated", "failed"]);

async function boundCredentialPods(
  credential_id: string,
): Promise<Set<string>> {
  const { rows } = await getPool().query(
    `SELECT provider_pod_id FROM gpu_pods
      WHERE credential_id = $1 AND provider_pod_id IS NOT NULL
        AND state NOT IN ('terminated', 'failed') AND unmanaged_at IS NULL`,
    [credential_id],
  );
  return new Set(rows.map((r) => r.provider_pod_id));
}

async function closeCompromise(
  account_id: string,
  credential_id: string,
  deps: GpuCompromiseDeps,
): Promise<void> {
  await (deps.keyFence ?? underKeyFence)(account_id, async (db) => {
    const { rows } = await db.query(
      "SELECT state FROM gpu_key_fences WHERE credential_id = $1",
      [credential_id],
    );
    if (rows[0]?.state !== "compromised") return;
    await closeKeyFence(
      db,
      account_id,
      credential_id,
      "compromise_closed",
      undefined,
      { kind: "cleanup" },
    );
  });
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
  // It must still be the connected key (a replacement may have won the
  // fence first); the cleanup acts only with that same key.
  await (deps.keyFence ?? underKeyFence)(account_id, async (db) => {
    const { rows: current } = await db.query(
      `SELECT id FROM external_credentials
        WHERE owner_account_id = $1 AND kind = 'gpu-provider-api-key' AND revoked IS NULL`,
      [account_id],
    );
    if (current[0]?.id !== credential_id) {
      throw Error(
        "Your RunPod key changed while this was being reported; check it and report again.",
      );
    }
    // A closed fence on a key still stored: a removal finished (or is just
    // revoking it, after its own fence). CoCalc launches nothing with it and
    // is about to drop its copy, so it can't watch the account: say so, and
    // claim nothing.
    const { rows: fence } = await db.query(
      "SELECT state FROM gpu_key_fences WHERE credential_id = $1 FOR UPDATE",
      [credential_id],
    );
    if (fence[0]?.state === "closed") {
      throw Error(
        "This RunPod key was already removed from CoCalc, which no longer uses it. Delete it on RunPod's Credentials page and terminate any pods there; if it still shows as connected here, remove it again.",
      );
    }
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
  const status = await runCompromiseCleanup(account_id, credential_id, deps);
  return { ...status, warning: status.warning ?? NEXT_STEPS_WARNING };
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
  // a cleanup that revoked its key but didn't get to close its fence
  const { rows: revoked } = await getPool().query(
    `SELECT f.credential_id, f.key_owner_account_id FROM gpu_key_fences f
       JOIN external_credentials c ON c.id = f.credential_id
      WHERE f.state = 'compromised' AND c.revoked IS NOT NULL`,
  );
  for (const r of revoked) {
    await guard();
    await closeCompromise(r.key_owner_account_id, r.credential_id, deps).catch(
      (err) => log.warn("closing a finished compromise failed", `${err}`),
    );
  }
  const { rows } = await getPool().query(
    `SELECT f.credential_id, f.key_owner_account_id FROM gpu_key_fences f
       JOIN external_credentials c ON c.id = f.credential_id
      WHERE f.state = 'compromised' AND c.revoked IS NULL`,
  );
  for (const r of rows) {
    await guard();
    await runCompromiseCleanup(r.key_owner_account_id, r.credential_id, {
      ...deps,
      guard,
    }).catch((err) => log.warn("a compromise cleanup pass failed", `${err}`));
  }
  return rows.length;
}

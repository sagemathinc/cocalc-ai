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
import { endAccountWatch } from "@cocalc/server/gpu/account-watch-db";
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
  underKeyFence,
  withRunpodCleanup,
  type RunpodCleanupCapability,
} from "@cocalc/server/gpu/provider-keys";
import { RunpodApiError } from "@cocalc/cloud/runpod/client";
import {
  currentGpuKeyMeta,
  withKeyUseOutcome,
  type GpuKeyCapability,
  type GpuKeyUse,
} from "@cocalc/server/gpu/key-use";
import type { RunpodPodView } from "@cocalc/cloud/runpod/views";
import {
  markCredentialPodsToTerminate,
  resolvePendingForAccount,
  unfinishedCredentialPods,
} from "@cocalc/server/gpu/pods";
import {
  recordKeyEvent,
  sanitizeProviderName,
} from "@cocalc/server/gpu/key-events";

import type { GpuCompromiseStatus } from "@cocalc/util/gpu/types";
import { raiseAlert, resolveAlert } from "@cocalc/server/gpu/alerts";

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
    opts?: { retryBackedOff?: boolean },
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

// The key, for `fn` only (5d-2c: one audited decrypt for the whole pass);
// tests stand in with deps.getCleanup.
async function withActiveCredential<T>(
  account_id: string,
  deps: GpuCompromiseDeps,
  key_use: GpuKeyCapability | undefined,
  fn: (c: RunpodCleanupCapability | undefined) => Promise<T>,
): Promise<T> {
  if (deps.getCleanup) return await fn(await deps.getCleanup(account_id));
  return await withRunpodCleanup(account_id, key_use, {}, fn);
}

// One cleanup pass for a compromised key. Idempotent; safe to run again at
// any point, by the request or the reaper.
// `key_use`: the report's own (compromise), or the compromise worker's run
// (cleanup).
export async function runCompromiseCleanup(
  account_id: string,
  credential_id: string,
  deps: GpuCompromiseDeps = {},
  key_use?: GpuKeyCapability,
): Promise<GpuCompromiseStatus> {
  return await withActiveCredential(account_id, deps, key_use, (c) =>
    cleanupPass(account_id, credential_id, deps, c),
  );
}

async function cleanupPass(
  account_id: string,
  credential_id: string,
  deps: GpuCompromiseDeps,
  c: RunpodCleanupCapability | undefined,
): Promise<GpuCompromiseStatus> {
  // the key is no longer stored (a forced removal ended it), or another key
  // is: nothing to do with this one
  if (!c || c.credential_id !== credential_id) return { closed: false };
  // the key's own pods, through their normal paths, every pass (backed-off
  // ones included: see the batches below)
  // the whole pass, resolving included, is bounded: past the deadline it
  // stops (the next pass continues)
  const deadline = Date.now() + (deps.passMs ?? REQUEST_PASS_MS);
  let cut = false;
  // a lost lease (the guard's throw) stops the pass wherever it happens
  let lost: unknown;
  const bounded = async () => {
    try {
      await deps.guard?.();
    } catch (err) {
      lost = err;
      throw err;
    }
    if (Date.now() >= deadline) {
      cut = true;
      throw Error("compromise pass deadline");
    }
  };
  // Batch after batch while the resolver says more may wait (within the
  // pass's bound): a batch's failures back off, so the next batch reaches
  // the pods after them; the next pass retries the failures.
  // The first batch also takes backed-off pods, the longest-waiting first
  // (a compromised key's pods are retried every pass, and one slow failure
  // can't keep the rest waiting); later batches skip what this pass just
  // backed off.
  const resolve =
    deps.resolvePending ??
    ((
      a: string,
      guard: () => Promise<void>,
      opts?: { retryBackedOff?: boolean },
    ) =>
      resolvePendingForAccount(
        a,
        {},
        // the key already read for this pass
        { guard, retryBackedOff: opts?.retryBackedOff, cleanup: c },
      ));
  for (let batch = 0; batch < MAX_RESOLVE_BATCHES && !cut; batch++) {
    const r = await resolve(account_id, bounded, {
      retryBackedOff: batch === 0,
    }).catch(() => undefined);
    if ((r as { full?: boolean } | undefined)?.full !== true) break;
  }
  // out of time: nothing more this pass (the next one continues)
  const cutShort = async (): Promise<GpuCompromiseStatus> => ({
    closed: false,
    managed_pods: (await unfinishedCredentialPods(credential_id)).length,
  });
  if (cut) return await cutShort();
  // No pod is ended for being absent from this listing: it changes as it is
  // paged (this pass's terminates, or another's, can shift RunPod's cursor
  // past live pods). CoCalc's own pods are all marked to terminate and end
  // through their normal path, where RunPod's "not found" is success; the
  // reconciler (5d) compares a full, unchanged inventory.
  // Each page's pods are acted on as the page arrives, so a large or slow
  // inventory still makes progress every pass (what this pass terminates
  // is gone from the next one's pages). CoCalc's unfinished pods end through
  // their normal paths; one it records as ended but RunPod still lists is
  // terminated again (quietly: it is CoCalc's, and terminating is
  // idempotent); any other pod CoCalc didn't start.
  const onPage = async (page: RunpodPodView[]) => {
    const { rows: managed } = await getPool().query(
      "SELECT provider_pod_id, state FROM gpu_pods WHERE credential_id = $1 AND provider_pod_id = ANY($2)",
      [credential_id, page.map((p) => p.id)],
    );
    const state = new Map<string, string>(
      managed.map((r) => [r.provider_pod_id, r.state]),
    );
    for (const pod of page) {
      const known = state.get(pod.id);
      if (known != null && !FINISHED.has(known)) continue;
      await bounded();
      if (known != null) {
        await c.terminatePod(pod.id).catch((err) => {
          log.warn("terminating an ended pod again failed", pod.id, `${err}`);
        });
        continue;
      }
      await terminateUnknownPod(account_id, credential_id, c, pod);
    }
  };
  let listed: Awaited<ReturnType<RunpodCleanupCapability["listPods"]>>;
  try {
    // every page is bounded by the pass too (RunPod may be slow, or the
    // account large)
    listed = await c.listPods({ beforePage: bounded, onPage });
  } catch (err) {
    if (lost !== undefined) throw lost;
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
  // done only once the account is empty and CoCalc has no unfinished pod
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

// A pod in the key's RunPod account that CoCalc didn't start: recorded the
// first time it is seen, and terminated every pass until it is gone.
async function terminateUnknownPod(
  account_id: string,
  credential_id: string,
  c: RunpodCleanupCapability,
  pod: RunpodPodView,
): Promise<void> {
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

// how many resolver batches one pass may run (each is bounded too)
const MAX_RESOLVE_BATCHES = 20;

const FINISHED = new Set(["terminated", "failed"]);

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
    // RunPod rejects the key now; the owner checks the account once
    const observed_at = new Date();
    await resolveAlert(
      {
        credential_id,
        kind: "compromise_awaiting_revocation",
        observed_at,
        by: "compromise_closed",
      },
      db,
    );
    await raiseAlert(
      {
        key_owner_account_id: account_id,
        credential_id,
        kind: "compromise_check_pods",
        severity: "warning",
        dedupe_key: "key",
        observed_at,
      },
      db,
    );
  });
}

// On the key owner's home bay. The caller checked fresh authentication.
export async function reportCompromisedLocal(
  opts: {
    account_id?: string;
    confirm_cocalc_only?: unknown;
    fresh_auth_verified?: boolean;
    // made by the authenticated boundary (5d-2c)
    key_use?: GpuKeyUse;
  },
  deps: GpuCompromiseDeps = {},
): Promise<GpuCompromiseStatus> {
  return await withKeyUseOutcome(opts.key_use, () =>
    reportCompromisedPass(opts, deps),
  );
}

async function reportCompromisedPass(
  opts: {
    account_id?: string;
    confirm_cocalc_only?: unknown;
    fresh_auth_verified?: boolean;
    key_use?: GpuKeyUse;
  },
  deps: GpuCompromiseDeps,
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
  // the connected key, from metadata (no decrypt)
  const meta = deps.getCleanup
    ? await deps.getCleanup(account_id)
    : await currentGpuKeyMeta(account_id);
  if (!meta) throw Error("No RunPod API key is connected.");
  const credential_id = meta.credential_id;
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
    // its account checks end: the fence admits nothing any more (5d-2b)
    await endAccountWatch(db, credential_id, "compromised");
    const marked = await markCredentialPodsToTerminate(db, {
      account_id,
      credential_id,
      cause: "compromised",
    });
    // open until the close (RunPod rejects the key and nothing is left)
    await raiseAlert(
      {
        key_owner_account_id: account_id,
        credential_id,
        kind: "compromise_awaiting_revocation",
        severity: "warning",
        dedupe_key: "key",
        observed_at: new Date(),
      },
      db,
    );
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
  const status = await runCompromiseCleanup(
    account_id,
    credential_id,
    deps,
    opts.key_use,
  );
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
    // made by the hub API handler when this is the home bay (5d-2c)
    key_use?: GpuKeyUse;
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
  return await reportCompromisedLocal(
    { ...forwarded, key_use: opts.key_use },
    deps,
  );
}

// The reaper's part: a pass for every compromised key still stored on this
// bay. `guard` renews the reaper's lease before each one.
// `key_use`: the compromise worker's run (cleanup)
export async function continueCompromiseCleanups(
  guard: () => Promise<void>,
  deps: GpuCompromiseDeps = {},
  key_use?: GpuKeyCapability,
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
  // Several at once (each key has its own fence and pass bound): a slow
  // account never makes the others wait for their turn.
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++];
      await guard();
      await runCompromiseCleanup(
        r.key_owner_account_id,
        r.credential_id,
        { ...deps, guard },
        key_use,
      ).catch((err) => {
        log.warn("a compromise cleanup pass failed", `${err}`);
      });
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(COMPROMISE_CONCURRENCY, rows.length) },
      worker,
    ),
  );
  return rows.length;
}

// how many compromised keys one sweep cleans up at the same time
export const COMPROMISE_CONCURRENCY = 8;
